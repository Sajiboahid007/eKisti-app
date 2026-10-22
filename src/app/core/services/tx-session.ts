import { Firestore, Transaction, DocumentReference, collection, doc } from '@angular/fire/firestore';
import {
  ActorStamp,
  AuditAction,
  Branch,
  FeeTransaction,
  FeeType,
  JournalEntry,
  JournalLine,
  LoanStatus,
  LoanStatusChange,
  LoanTransaction,
  LoanTransactionType,
  SmsLog,
  VaultTransaction,
  VaultTransactionType
} from '../models/database.models';
import { balancedLines } from '../finance/accounts';
import { AuditHistoryService, stripUndefined } from './audit-history.service';
import { EntitySequence, startingSequence } from './counter.service';

interface CounterState {
  ref: DocumentReference;
  last: number;
  initial: number;
}

/**
 * একটি আর্থিক অপারেশনের Firestore ট্রানজ্যাকশন সেশন।
 *
 * Firestore ট্রানজ্যাকশনে সব রিড আগে, তারপর সব রাইট — তাই ব্যবহারবিধি:
 *   ১. READ ধাপ: reserve(), assertDayOpen(), readBranch(), tx.get(...)
 *   ২. WRITE ধাপ: loanTxn(), vaultMove(), journal(), audit() … তারপর finish()
 *
 * আইডি কাউন্টার একই ট্রানজ্যাকশনে বাড়ে, তাই ব্যর্থ হলে আইডিতেও ফাঁক থাকে না।
 */
export class TxSession {
  private counters = new Map<EntitySequence, CounterState>();
  private branches = new Map<number, { ref: DocumentReference; data: Branch; vault: number; bank: number; touched: boolean }>();
  private writesStarted = false;

  constructor(
    private firestore: Firestore,
    readonly tx: Transaction,
    private auditService: AuditHistoryService,
    readonly actor: ActorStamp,
    readonly now: string,
    readonly businessDate: string,
    public correlationId: string
  ) {}

  // ================= READ PHASE =================

  /** count টি ক্রমিক আইডি সংরক্ষণ — প্রথম আইডি ফেরত দেয় */
  async reserve(entity: EntitySequence, count: number): Promise<number> {
    this.assertReadPhase();
    if (count <= 0) return 0;
    let state = this.counters.get(entity);
    if (!state) {
      const ref = doc(this.firestore, 'counters', entity);
      const snap = await this.tx.get(ref);
      const last = snap.exists()
        ? (Number(snap.data()['currentSequenceId']) || startingSequence(entity))
        : startingSequence(entity) - 1;
      state = { ref, last, initial: last };
      this.counters.set(entity, state);
    }
    const first = state.last + 1;
    state.last += count;
    return first;
  }

  /** দিবস সমাপনী হয়ে গেলে ওই শাখায় আজকের তারিখে কোনো লেনদেন নয় */
  async assertDayOpen(branchId: number): Promise<void> {
    this.assertReadPhase();
    const snap = await this.tx.get(doc(this.firestore, 'periodClosings', `${branchId}_${this.businessDate}`));
    if (snap.exists() && snap.data()['status'] === 'CLOSED') {
      throw new Error(`শাখা #${branchId}-এর ${this.businessDate} তারিখের দিবস সমাপনী সম্পন্ন হয়েছে। নতুন লেনদেন করতে হলে প্রধান কার্যালয় থেকে দিনটি পুনরায় খুলতে হবে।`);
    }
  }

  async readBranch(branchId: number): Promise<Branch> {
    this.assertReadPhase();
    const cached = this.branches.get(Number(branchId));
    if (cached) return cached.data;
    const ref = doc(this.firestore, 'branches', String(branchId));
    const snap = await this.tx.get(ref);
    if (!snap.exists()) throw new Error(`শাখা #${branchId} পাওয়া যায়নি`);
    const data = snap.data() as Branch;
    this.branches.set(Number(branchId), {
      ref, data,
      vault: Number(data.currentVaultCash) || 0,
      bank: Number(data.currentBankBalance) || 0,
      touched: false
    });
    return data;
  }

  vaultBalance(branchId: number): number {
    return this.branchState(branchId).vault;
  }

  bankBalance(branchId: number): number {
    return this.branchState(branchId).bank;
  }

  // ================= WRITE PHASE =================

  set(ref: DocumentReference, data: object): void {
    this.writesStarted = true;
    this.tx.set(ref, stripUndefined(data));
  }

  update(ref: DocumentReference, data: Record<string, any>): void {
    this.writesStarted = true;
    this.tx.update(ref, stripUndefined(data));
  }

  /**
   * ভল্টে টাকা আসা/যাওয়া — খতিয়ানে সারি তৈরি ও চলতি স্থিতি হালনাগাদ।
   * bankDelta: ব্যাংক হিসাবের পরিবর্তন (ব্যাংক জমা/উত্তোলনে)।
   */
  vaultMove(params: {
    id: number;
    branchId: number;
    type: VaultTransactionType;
    direction: 'IN' | 'OUT';
    amount: number;
    bankDelta?: number;
    refType?: string;
    refId?: number;
    slipNo?: string;
    note?: string;
    allowNegative?: boolean;
  }): VaultTransaction {
    const state = this.branchState(params.branchId);
    const amount = round2(params.amount);
    if (!(amount > 0)) throw new Error('টাকার পরিমাণ শূন্যের বেশি হতে হবে');
    const before = state.vault;
    const after = round2(params.direction === 'IN' ? before + amount : before - amount);
    if (after < 0 && !params.allowNegative) {
      throw new Error(`ভল্টে পর্যাপ্ত নগদ নেই (বর্তমান ৳${before.toLocaleString('en-IN')}, প্রয়োজন ৳${amount.toLocaleString('en-IN')})। প্রধান কার্যালয় থেকে তহবিল আনুন বা ব্যাংক থেকে উত্তোলন করুন।`);
    }
    state.vault = after;
    if (params.bankDelta) {
      const bankAfter = round2(state.bank + params.bankDelta);
      if (bankAfter < 0) throw new Error(`ব্যাংক হিসাবে পর্যাপ্ত স্থিতি নেই (বর্তমান ৳${state.bank.toLocaleString('en-IN')})`);
      state.bank = bankAfter;
    }
    state.touched = true;

    const row: VaultTransaction = {
      vaultTransactionId: params.id,
      branchId: Number(params.branchId),
      type: params.type,
      direction: params.direction,
      amount,
      balanceBefore: before,
      balanceAfter: after,
      bankBalanceAfter: params.bankDelta ? state.bank : undefined,
      refType: params.refType,
      refId: params.refId,
      slipNo: params.slipNo,
      businessDate: this.businessDate,
      correlationId: this.correlationId,
      note: params.note,
      createdAt: this.now,
      createdBy: this.actor
    };
    this.set(doc(this.firestore, 'vaultTransactions', String(params.id)), row);
    return row;
  }

  loanTxn(params: {
    id: number;
    loanId: number;
    customerId: number;
    branchId: number;
    type: LoanTransactionType;
    principal: number;
    profit: number;
    outstandingBefore: number;
    outstandingAfter: number;
    receiptId?: number;
    note?: string;
  }): LoanTransaction {
    const row: LoanTransaction = {
      loanTransactionId: params.id,
      loanId: params.loanId,
      customerId: params.customerId,
      branchId: Number(params.branchId),
      type: params.type,
      principal: round2(params.principal),
      profit: round2(params.profit),
      amount: round2(params.principal + params.profit),
      outstandingBefore: round2(params.outstandingBefore),
      outstandingAfter: round2(params.outstandingAfter),
      receiptId: params.receiptId,
      businessDate: this.businessDate,
      correlationId: this.correlationId,
      note: params.note,
      createdAt: this.now,
      createdBy: this.actor
    };
    this.set(doc(this.firestore, 'loanTransactions', String(params.id)), row);
    return row;
  }

  journal(id: number, branchId: number, memo: string, lines: JournalLine[]): JournalEntry {
    const entry: JournalEntry = {
      journalId: id,
      branchId: Number(branchId),
      businessDate: this.businessDate,
      memo,
      lines: balancedLines(lines),
      correlationId: this.correlationId,
      createdAt: this.now,
      createdBy: this.actor
    };
    this.set(doc(this.firestore, 'journalEntries', String(id)), entry);
    return entry;
  }

  fee(params: { id: number; branchId: number; customerId: number; loanId?: number; feeType: FeeType; amount: number }): FeeTransaction {
    const row: FeeTransaction = {
      feeTransactionId: params.id,
      branchId: Number(params.branchId),
      customerId: params.customerId,
      loanId: params.loanId,
      feeType: params.feeType,
      amount: round2(params.amount),
      businessDate: this.businessDate,
      correlationId: this.correlationId,
      createdAt: this.now,
      createdBy: this.actor
    };
    this.set(doc(this.firestore, 'feeTransactions', String(params.id)), row);
    return row;
  }

  audit(entityType: string, entityId: number | string, action: AuditAction, reason: string, changes: Record<string, { before: any; after: any }>, branchId?: number): void {
    this.writesStarted = true;
    this.auditService.writeAuditLog(this.tx, {
      entityType, entityId, action, reason, changes,
      branchId, correlationId: this.correlationId, actor: this.actor, timestamp: this.now
    });
  }

  statusChange(loanId: number, branchId: number, from: LoanStatus | null, to: LoanStatus, reason: string): void {
    if (from === to) return;
    const row: LoanStatusChange = { loanId, fromStatus: from, toStatus: to, reason, branchId: Number(branchId), timestamp: this.now, actor: this.actor };
    this.set(doc(collection(this.firestore, 'loanStatusHistory')), row);
  }

  /** SMS সারিতে রাখা — ক্লাউড ফাংশন/গেটওয়ে পাঠাবে (ব্রাউজার থেকে সরাসরি নয়) */
  queueSms(sms: Omit<SmsLog, 'status' | 'createdAt'>): void {
    if (!sms.to) return;
    this.set(doc(collection(this.firestore, 'smsLogs')), { ...sms, status: 'QUEUED', createdAt: this.now } as SmsLog);
  }

  historyEntry(action: AuditAction, reason: string, previousData: Record<string, any> | undefined, newData: Record<string, any>) {
    return this.auditService.buildHistoryEntry({
      action,
      changedByUserId: this.actor.userId,
      changedByName: this.actor.name,
      changedByRole: this.actor.role,
      reason,
      previousData,
      newData,
      timestamp: this.now
    });
  }

  appendHistory<T extends { history?: any[] }>(existing: T, entry: ReturnType<TxSession['historyEntry']>) {
    return this.auditService.appendHistory(existing.history, entry);
  }

  /** শেষ ধাপ: কাউন্টার ও শাখার ভল্ট স্থিতি লেখা */
  finish(): void {
    this.writesStarted = true;
    for (const [entity, state] of this.counters) {
      if (state.last !== state.initial) {
        this.tx.set(state.ref, { entityName: entity, currentSequenceId: state.last, updatedAt: this.now });
      }
    }
    for (const state of this.branches.values()) {
      if (!state.touched) continue;
      const fields = { currentVaultCash: state.vault, currentBankBalance: state.bank };
      const entry = this.historyEntry('VAULT_TRANSACTION', `ভল্ট হালনাগাদ (${this.correlationId})`,
        { currentVaultCash: Number(state.data.currentVaultCash) || 0, currentBankBalance: Number(state.data.currentBankBalance) || 0 }, fields);
      this.tx.update(state.ref, { ...fields, history: this.auditService.appendHistory(state.data.history, entry) });
    }
  }

  private branchState(branchId: number) {
    const state = this.branches.get(Number(branchId));
    if (!state) throw new Error(`শাখা #${branchId} ট্রানজ্যাকশনে আগে পড়া হয়নি`);
    return state;
  }

  private assertReadPhase(): void {
    if (this.writesStarted) {
      throw new Error('Internal: Firestore transaction read after write');
    }
  }
}

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
