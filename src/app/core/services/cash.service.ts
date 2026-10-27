import { Injectable, inject } from '@angular/core';
import { collection, doc, getDoc, getDocs, query, setDoc, where } from '@angular/fire/firestore';
import {
  Branch,
  Customer,
  DailyBranchSummary,
  DailyReconciliation,
  Expense,
  InstallmentSchedule,
  JournalEntry,
  Loan,
  MonthlyPortfolioSnapshot,
  PaymentCollection,
  PeriodClosing,
  SavingsTransaction,
  SavingsTransactionType,
  VaultTransaction
} from '../models/database.models';
import { ACCOUNTS, collectionCashAccount } from '../finance/accounts';
import { VAULT_ACCESS_DENIED, canOperateVaultFor } from '../guards/vault-access';
import { receiptTypeOf } from '../finance/field-cash';
import { addDaysKey, monthKeyDhaka, todayDhaka, toDhakaDayKey } from '../finance/dates';
import { portfolioQuality, recoveryRates } from '../finance/classification';
import { SettingsService } from './settings.service';
import { Actor, TxRunner } from './tx-runner.service';
import { CounterService, voucherSequence } from './counter.service';
import { round2 } from './tx-session';

export type VaultOperation = 'BANK_DEPOSIT' | 'BANK_WITHDRAW' | 'EXPENSE' | 'HO_TRANSFER_IN' | 'HO_TRANSFER_OUT' | 'OPENING';

/** স্বয়ংক্রিয় স্লিপ / ভাউচার নং-এর উপসর্গ — প্রতি শাখায় প্রতি ধরনে ০০১ থেকে ক্রমিক (যেমন BD-001) */
export const VOUCHER_PREFIX: Partial<Record<VaultOperation, string>> = {
  BANK_DEPOSIT: 'BD', BANK_WITHDRAW: 'BW', EXPENSE: 'EXP', HO_TRANSFER_IN: 'HOI', HO_TRANSFER_OUT: 'HOO'
};

export function formatVoucherNo(prefix: string, serial: number): string {
  return `${prefix}-${String(serial).padStart(3, '0')}`;
}

/**
 * টাকা কোথায় নেওয়া হলো:
 *  FIELD   — ক্যাশিয়ার ছাড়া যেকোনো কর্মকর্তা (মাঠকর্মী, BM, এডমিন…) যেখানেই নিন: রসিদ তাঁর হাতে থাকে,
 *            ক্যাশ ক্লোজিংয়ে ক্যাশিয়ার গ্রহণ করলে ভল্টে যায়
 *  COUNTER — শাখার কাউন্টারে ক্যাশিয়ার নিজে: সরাসরি ভল্টে
 */
export type CashChannel = 'FIELD' | 'COUNTER';

/** টাকা নেওয়ার (IN) ডিফল্ট চ্যানেল — শুধু ক্যাশিয়ার সরাসরি ভল্টে নেন, বাকি সবাইকে ক্যাশিয়ারের কাছে জমা দিতে হবে */
export function defaultChannel(actor: Actor): CashChannel {
  return actor.role === 'CASHIER' ? 'COUNTER' : 'FIELD';
}

export const EXPENSE_HEADS = [
  'অফিস ভাড়া', 'বিদ্যুৎ ও পানি', 'যাতায়াত ও কনভেয়েন্স', 'স্টেশনারি ও প্রিন্টিং', 'মোবাইল ও ইন্টারনেট',
  'আপ্যায়ন', 'মেরামত ও রক্ষণাবেক্ষণ', 'কর্মীর বেতন ও ভাতা', 'বিবিধ'
];

/**
 * শাখার নগদ, ভল্ট, ব্যাংক, খরচ, সঞ্চয় লেনদেন ও দিবস/মাস সমাপনী।
 */
@Injectable({ providedIn: 'root' })
export class CashService {
  private runner = inject(TxRunner);
  private counters = inject(CounterService);
  private settings = inject(SettingsService);
  private firestore = this.runner.firestore;

  // =====================================================================
  // ১. মাঠকর্মীর ক্যাশ ক্লোজিং (ভল্টে গ্রহণ)
  // =====================================================================

  async reconcileFieldOfficerCash(params: {
    branchId: number;
    fieldOfficerUserId: number;
    fieldOfficerName: string;
    receiptIds: number[];
    countedCashAmount: number;
    denominations?: Record<string, number>;
    notes?: string;
    cashier: Actor;
  }): Promise<DailyReconciliation> {
    const receiptIds = [...new Set(params.receiptIds)];
    if (receiptIds.length === 0) throw new Error('কমপক্ষে একটি রসিদ নির্বাচন করুন');
    if (receiptIds.length > 300) throw new Error('একবারে সর্বোচ্চ ৩০০টি রসিদ জমা নেওয়া যাবে');
    if (!(params.countedCashAmount >= 0)) throw new Error('গণনাকৃত নগদ টাকার পরিমাণ সঠিক নয়');
    const notes = (params.notes || '').trim();

    return this.runner.run(params.cashier, 'REC', async s => {
      await s.readBranch(params.branchId);
      const receiptRefs = receiptIds.map(id => doc(this.firestore, 'collections', String(id)));
      const snaps = await Promise.all(receiptRefs.map(ref => s.tx.get(ref)));
      const receipts = snaps.map((snap, i) => {
        if (!snap.exists()) throw new Error(`রসিদ #${receiptIds[i]} পাওয়া যায়নি`);
        const r = snap.data() as PaymentCollection;
        if (r.isDeleted || r.isReversed) throw new Error(`রসিদ #${r.receiptId} বাতিল/মুছে ফেলা হয়েছে`);
        if (r.isHandedOverToBranch) throw new Error(`রসিদ #${r.receiptId} ইতোমধ্যে ভল্টে জমা নেওয়া হয়েছে। পেজ রিফ্রেশ করুন।`);
        if (Number(r.branchId) !== Number(params.branchId)) throw new Error(`রসিদ #${r.receiptId} এই শাখার নয়`);
        if (Number(r.collectedByUserId) !== Number(params.fieldOfficerUserId)) throw new Error(`রসিদ #${r.receiptId} এই মাঠকর্মীর আদায় নয়`);
        return r;
      });
      await s.assertDayOpen(params.branchId);
      const reconciliationId = await s.reserve('reconciliations', 1);
      const journalId = await s.reserve('journalEntries', 1);
      const counted = round2(params.countedCashAmount);
      const vaultTxnId = counted > 0 ? await s.reserve('vaultTransactions', 1) : 0;
      s.correlationId = `REC-${reconciliationId}`;

      let totalCollected = 0, expectedCash = 0, digital = 0, kisti = 0, savings = 0, fine = 0, fees = 0, recovery = 0;
      const byType: Record<string, number> = {};
      for (const r of receipts) {
        const amount = r.totalAmountCollected || 0;
        const type = receiptTypeOf(r);
        totalCollected += amount;
        byType[type] = round2((byType[type] || 0) + amount);
        if (r.paymentMethod === 'CASH') expectedCash += amount; else digital += amount;
        savings += r.savingsAmountCollected || 0;
        fine += r.fineAmountCollected || 0;
        if (type === 'FEE') fees += r.feeAmountCollected || amount;
        else if (type === 'WRITE_OFF_RECOVERY') recovery += (r.principalAmountCollected || 0) + (r.profitAmountCollected || 0);
        else kisti += (r.principalAmountCollected || 0) + (r.profitAmountCollected || 0);
      }
      expectedCash = round2(expectedCash);
      const shortage = round2(expectedCash - counted); // + ঘাটতি, − অতিরিক্ত
      const status: DailyReconciliation['cashierStatus'] = shortage === 0 ? 'ACCEPTED' : 'MISMATCH_DISCREPANCY';
      if (status === 'MISMATCH_DISCREPANCY' && !notes) throw new Error('টাকার অমিল থাকলে কারণ / নোট লেখা বাধ্যতামূলক');

      const vaultBefore = s.vaultBalance(params.branchId);
      if (counted > 0) {
        s.vaultMove({ id: vaultTxnId, branchId: params.branchId, type: 'CLOSING_IN', direction: 'IN', amount: counted, refType: 'RECONCILIATION', refId: reconciliationId, note: `${params.fieldOfficerName} থেকে ক্যাশ গ্রহণ` });
      }

      const record: Omit<DailyReconciliation, 'history'> = {
        reconciliationId,
        date: s.businessDate,
        branchId: Number(params.branchId),
        fieldOfficerUserId: params.fieldOfficerUserId,
        fieldOfficerName: params.fieldOfficerName,
        targetCollectionAmount: round2(totalCollected),
        actualCashCollected: expectedCash,
        shortageOrDeficitAmount: shortage,
        totalReceiptsCount: receipts.length,
        cashHandedOverAmount: counted,
        cashierUserId: params.cashier.userId,
        cashierName: params.cashier.name,
        cashierStatus: status,
        cashierNotes: notes,
        receiptIds,
        digitalCollectedAmount: round2(digital),
        kistiAmount: round2(kisti),
        savingsAmount: round2(savings),
        fineAmount: round2(fine),
        feeAmount: round2(fees),
        recoveryAmount: round2(recovery),
        byType,
        denominations: params.denominations || {},
        vaultBalanceBefore: vaultBefore,
        vaultBalanceAfter: s.vaultBalance(params.branchId),
        submittedAt: s.now,
        verifiedAt: s.now,
        createdAt: s.now,
        isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null
      };
      const reconciliation: DailyReconciliation = {
        ...record,
        history: [s.historyEntry('CASH_RECONCILED', 'মাঠকর্মীর ক্যাশ ক্লোজিং ও ভল্টে জমা গ্রহণ', undefined, record)]
      };
      s.set(doc(this.firestore, 'reconciliations', String(reconciliationId)), reconciliation);

      receipts.forEach((r, i) => {
        const fields: Record<string, any> = { isHandedOverToBranch: true, reconciliationId, reconciledAt: s.now, reconciledByUserId: params.cashier.userId };
        if (r.paymentMethod !== 'CASH') fields['digitalVerifiedByUserId'] = params.cashier.userId;
        s.update(receiptRefs[i], { ...fields, history: s.appendHistory(r, s.historyEntry('CASH_RECONCILED', `ক্যাশ ক্লোজিং #${reconciliationId}`, r, fields)) });
      });

      // মাঠের নগদ → ভল্ট; ঘাটতি কর্মীর কাছে পাওনা, অতিরিক্ত আয়
      s.journal(journalId, params.branchId, `ক্যাশ ক্লোজিং #${reconciliationId} — ${params.fieldOfficerName}`, [
        { account: ACCOUNTS.VAULT_CASH, debit: counted, credit: 0 },
        { account: ACCOUNTS.SHORTAGE_RECEIVABLE, debit: Math.max(0, shortage), credit: 0 },
        { account: ACCOUNTS.CASH_IN_FIELD, debit: 0, credit: expectedCash },
        { account: ACCOUNTS.CASH_EXCESS_INCOME, debit: 0, credit: Math.max(0, -shortage) }
      ]);
      s.audit('reconciliations', reconciliationId, 'CASH_RECONCILED', 'ক্যাশ ক্লোজিং', { cashHandedOverAmount: { before: null, after: counted }, shortage: { before: null, after: shortage } }, params.branchId);
      return reconciliation;
    });
  }

  // =====================================================================
  // ২. ভল্ট / ব্যাংক / খরচ / প্রধান কার্যালয় তহবিল
  // =====================================================================

  /** পরবর্তী স্বয়ংক্রিয় স্লিপ / ভাউচার নং (শুধু দেখানোর জন্য — আসল নং জমার সময় বরাদ্দ হয়) */
  async peekVoucherNo(branchId: number, operation: VaultOperation): Promise<string> {
    const prefix = VOUCHER_PREFIX[operation];
    if (!prefix) return '';
    return formatVoucherNo(prefix, await this.counters.peekNextIntegerId(voucherSequence(prefix, Number(branchId))));
  }

  async vaultOperation(params: {
    branchId: number;
    operation: VaultOperation;
    amount: number;
    slipNo?: string;
    /** true হলে slipNo উপেক্ষা করে ট্রানজ্যাকশনের ভেতরে পরবর্তী ক্রমিক ভাউচার নং বরাদ্দ হয় */
    autoSlipNo?: boolean;
    note?: string;
    expenseHead?: string;
    paidTo?: string;
  }, actor: Actor): Promise<VaultTransaction> {
    this.assertVaultAccess(actor);
    const amount = round2(params.amount);
    if (!(amount > 0)) throw new Error('সঠিক পরিমাণ দিন');
    if (params.operation === 'EXPENSE' && !params.expenseHead) throw new Error('খরচের খাত নির্বাচন করুন');
    const prefix = VOUCHER_PREFIX[params.operation];
    const autoSlip = !!prefix && (params.autoSlipNo || !params.slipNo?.trim());
    if (!autoSlip && (params.operation === 'BANK_DEPOSIT' || params.operation === 'BANK_WITHDRAW') && !params.slipNo?.trim()) {
      throw new Error('ব্যাংক স্লিপ / চেক নম্বর লিখুন');
    }

    if (params.operation === 'OPENING') {
      const existing = await getDocs(query(collection(this.firestore, 'vaultTransactions'), where('branchId', '==', Number(params.branchId))));
      if (!existing.empty) throw new Error('এই শাখার ভল্ট খতিয়ান ইতোমধ্যে চালু — প্রারম্ভিক স্থিতি আর সেট করা যাবে না');
    }

    return this.runner.run(actor, `VLT-${params.operation}`, async s => {
      const branch = await s.readBranch(params.branchId);
      await s.assertDayOpen(params.branchId);
      const id = await s.reserve('vaultTransactions', 1);
      const journalId = await s.reserve('journalEntries', 1);
      const expenseId = params.operation === 'EXPENSE' ? await s.reserve('expenses', 1) : 0;
      if (autoSlip) params = { ...params, slipNo: formatVoucherNo(prefix!, await s.reserve(voucherSequence(prefix!, Number(params.branchId)), 1)) };
      s.correlationId = `VLT-${id}`;
      const note = params.note?.trim();

      let row: VaultTransaction;
      let lines;
      switch (params.operation) {
        case 'BANK_DEPOSIT':
          row = s.vaultMove({ id, branchId: params.branchId, type: 'BANK_DEPOSIT', direction: 'OUT', amount, bankDelta: amount, slipNo: params.slipNo, note });
          lines = [{ account: ACCOUNTS.BANK, debit: amount, credit: 0 }, { account: ACCOUNTS.VAULT_CASH, debit: 0, credit: amount }];
          break;
        case 'BANK_WITHDRAW':
          row = s.vaultMove({ id, branchId: params.branchId, type: 'BANK_WITHDRAW', direction: 'IN', amount, bankDelta: -amount, slipNo: params.slipNo, note });
          lines = [{ account: ACCOUNTS.VAULT_CASH, debit: amount, credit: 0 }, { account: ACCOUNTS.BANK, debit: 0, credit: amount }];
          break;
        case 'EXPENSE': {
          row = s.vaultMove({ id, branchId: params.branchId, type: 'EXPENSE', direction: 'OUT', amount, refType: 'EXPENSE', refId: expenseId, slipNo: params.slipNo, note: `${params.expenseHead}${note ? ` — ${note}` : ''}` });
          const expense: Expense = {
            expenseId, branchId: Number(params.branchId), head: params.expenseHead!, amount,
            voucherNo: params.slipNo, description: note, paidTo: params.paidTo,
            businessDate: s.businessDate, correlationId: s.correlationId, createdAt: s.now, createdBy: s.actor
          };
          s.set(doc(this.firestore, 'expenses', String(expenseId)), expense);
          lines = [{ account: ACCOUNTS.OPERATING_EXPENSE, debit: amount, credit: 0 }, { account: ACCOUNTS.VAULT_CASH, debit: 0, credit: amount }];
          break;
        }
        case 'HO_TRANSFER_IN':
          row = s.vaultMove({ id, branchId: params.branchId, type: 'HO_TRANSFER_IN', direction: 'IN', amount, slipNo: params.slipNo, note });
          lines = [{ account: ACCOUNTS.VAULT_CASH, debit: amount, credit: 0 }, { account: ACCOUNTS.HEAD_OFFICE_FUND, debit: 0, credit: amount }];
          break;
        case 'HO_TRANSFER_OUT':
          row = s.vaultMove({ id, branchId: params.branchId, type: 'HO_TRANSFER_OUT', direction: 'OUT', amount, slipNo: params.slipNo, note });
          lines = [{ account: ACCOUNTS.HEAD_OFFICE_FUND, debit: amount, credit: 0 }, { account: ACCOUNTS.VAULT_CASH, debit: 0, credit: amount }];
          break;
        case 'OPENING': {
          // বিদ্যমান স্থিতি থেকে খতিয়ান শুরু — পার্থক্য সমন্বয় হিসেবে
          const current = Number(branch.currentVaultCash) || 0;
          const diff = round2(amount - current);
          if (diff === 0) throw new Error('প্রারম্ভিক স্থিতি বর্তমান স্থিতির সমান — সমন্বয়ের প্রয়োজন নেই');
          row = s.vaultMove({ id, branchId: params.branchId, type: 'OPENING', direction: diff > 0 ? 'IN' : 'OUT', amount: Math.abs(diff), note: note || `প্রারম্ভিক স্থিতি ৳${amount}`, allowNegative: true });
          lines = diff > 0
            ? [{ account: ACCOUNTS.VAULT_CASH, debit: diff, credit: 0 }, { account: ACCOUNTS.OPENING_EQUITY, debit: 0, credit: diff }]
            : [{ account: ACCOUNTS.OPENING_EQUITY, debit: -diff, credit: 0 }, { account: ACCOUNTS.VAULT_CASH, debit: 0, credit: -diff }];
          break;
        }
      }
      s.journal(journalId, params.branchId, `ভল্ট: ${params.operation}${note ? ` — ${note}` : ''}`, lines);
      s.audit('branches', params.branchId, 'VAULT_TRANSACTION', params.operation, { currentVaultCash: { before: row.balanceBefore, after: row.balanceAfter } }, params.branchId);
      return row;
    });
  }

  // =====================================================================
  // ৩. সঞ্চয় জমা / উত্তোলন / সমন্বয় / হিসাব সমাপ্তি
  // =====================================================================

  async recordSavings(params: {
    customerId: number;
    type: SavingsTransactionType;
    amount: number;
    isCredit: boolean;
    paymentMethod: SavingsTransaction['paymentMethod'];
    reason: string;
    receiptNo?: string;
    /** না দিলে: জমা → ক্যাশিয়ার হলে COUNTER, অন্য সবাই FIELD (ক্যাশিয়ারের অনুমোদন লাগবে); অন্য ধরন → COUNTER */
    channel?: CashChannel;
  }, actor: Actor): Promise<SavingsTransaction> {
    const amount = round2(params.amount);
    if (!(amount > 0)) throw new Error('সঠিক পরিমাণ দিন');
    if (params.paymentMethod === 'SAVINGS') throw new Error('সঞ্চয় হতে কিস্তি সমন্বয় "সঞ্চয় থেকে কিস্তি" অপশন দিয়ে করুন');
    const general = await this.settings.getGeneralSettings();
    const channel = params.channel || (params.type === 'DEPOSIT' ? defaultChannel(actor) : 'COUNTER');
    const fieldDeposit = channel === 'FIELD' && params.type === 'DEPOSIT';

    if (params.type !== 'DEPOSIT' && (channel === 'FIELD' || actor.role === 'FIELD_OFFICER')) {
      // মাঠকর্মী মাঠে শুধু জমা নিতে পারেন; উত্তোলন/ফেরত/সমন্বয় শাখায় ক্যাশিয়ার/BM করবেন
      throw new Error('মাঠকর্মী শুধু সঞ্চয় জমা নিতে পারেন। উত্তোলন, হিসাব সমাপ্তি বা সমন্বয় শাখায় ক্যাশিয়ার/শাখা ব্যবস্থাপক করবেন।');
    }

    return this.runner.run(actor, `SAV-${params.customerId}`, async s => {
      const custSnap = await s.tx.get(this.runner.customerRef(params.customerId));
      if (!custSnap.exists()) throw new Error('গ্রাহক পাওয়া যায়নি');
      const customer = custSnap.data() as Customer;
      const branchId = Number(customer.branchId);
      const isCash = params.paymentMethod === 'CASH';
      // মাঠে নেওয়া জমা ভল্টে যায় না — মাঠকর্মীর হাতে থাকে, ক্যাশ ক্লোজিংয়ে ভল্টে ঢোকে
      const touchesVault = !fieldDeposit && isCash && ['DEPOSIT', 'WITHDRAW', 'ACCOUNT_CLOSURE'].includes(params.type);
      if (touchesVault) await s.readBranch(branchId);
      await s.assertDayOpen(branchId);
      const txnId = await s.reserve('savings', 1);
      const journalId = await s.reserve('journalEntries', 1);
      const vaultId = touchesVault ? await s.reserve('vaultTransactions', 1) : 0;
      const receiptId = fieldDeposit ? await s.reserve('receipts', 1) : 0;
      s.correlationId = fieldDeposit ? `SAV-RCP-${receiptId}` : `SAV-${txnId}`;

      if (params.type === 'WITHDRAW' && general.lockSavingsWithdrawalWithActiveLoan && (customer.activeLoansCount || 0) > 0) {
        throw new Error('চলমান ঋণ থাকা অবস্থায় বাধ্যতামূলক সঞ্চয় উত্তোলন করা যাবে না (সাধারণ সেটিংস নীতি)। ঋণ পরিশোধ বা সঞ্চয় হতে সমন্বয় করুন।');
      }
      const before = Number(customer.totalSavingsBalance) || 0;
      const after = round2(params.isCredit ? before + amount : before - amount);
      if (after < 0) throw new Error(`সঞ্চয় স্থিতি (৳${before}) এর চেয়ে বেশি উত্তোলন সম্ভব নয়`);

      const txn: SavingsTransaction = {
        transactionId: txnId, customerId: customer.customerId, customerName: customer.fullName,
        branchId, centerId: Number(customer.centerId), type: params.type, amount, isCredit: params.isCredit,
        previousBalance: before, newBalance: after, paymentMethod: params.paymentMethod, transactionDate: s.now,
        performedByUserId: actor.userId, performedByName: actor.name, performedByRole: actor.role,
        reason: params.reason, receiptNo: fieldDeposit ? `RCP-${receiptId}` : params.receiptNo, correlationId: s.correlationId,
        isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
        history: [s.historyEntry('CREATE', params.reason, undefined, { amount, type: params.type })]
      };
      s.set(doc(this.firestore, 'savingsTransactions', String(txnId)), txn);

      if (fieldDeposit) {
        // মাঠ রসিদ — মাঠকর্মীর হাতে থাকা টাকা, ক্যাশিয়ার গ্রহণ না করা পর্যন্ত অপেক্ষমাণ
        const receipt: PaymentCollection = {
          receiptId, receiptType: 'SAVINGS_DEPOSIT',
          loanId: 0, customerId: customer.customerId, customerName: customer.fullName, installmentNo: 0,
          branchId, centerId: Number(customer.centerId),
          collectedByUserId: actor.userId, collectedByName: actor.name,
          principalAmountCollected: 0, profitAmountCollected: 0, savingsAmountCollected: amount, fineAmountCollected: 0,
          totalAmountCollected: amount, paymentMethod: params.paymentMethod, collectionDate: s.now,
          isHandedOverToBranch: false, correlationId: s.correlationId,
          isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
          history: [s.historyEntry('PAYMENT_COLLECTED', params.reason, undefined, { amount, type: 'SAVINGS_DEPOSIT' })]
        };
        s.set(doc(this.firestore, 'collections', String(receiptId)), receipt);
        s.audit('collections', receiptId, 'PAYMENT_COLLECTED', 'সঞ্চয় জমা — ক্যাশিয়ারের গ্রহণ বাকি', { totalAmountCollected: { before: null, after: amount } }, branchId);
      }
      const custFields = { totalSavingsBalance: after };
      s.update(this.runner.customerRef(customer.customerId), { ...custFields, history: s.appendHistory(customer, s.historyEntry('UPDATE', params.reason, customer, custFields)) });

      if (touchesVault) {
        s.vaultMove({
          id: vaultId, branchId, type: params.isCredit ? 'SAVINGS_DEPOSIT_IN' : 'SAVINGS_WITHDRAW_OUT',
          direction: params.isCredit ? 'IN' : 'OUT', amount, refType: 'SAVINGS', refId: txnId,
          note: `${customer.fullName} (#${customer.customerId})`
        });
      }
      const counter = params.type === 'INTEREST' ? ACCOUNTS.SAVINGS_INTEREST_EXPENSE
        : params.type === 'ADJUSTMENT' ? ACCOUNTS.OPENING_EQUITY
        : fieldDeposit ? collectionCashAccount(params.paymentMethod)
        : isCash ? ACCOUNTS.VAULT_CASH : ACCOUNTS.MOBILE_CLEARING;
      s.journal(journalId, branchId, `সঞ্চয় ${params.type} — ${customer.fullName}`, params.isCredit
        ? [{ account: counter, debit: amount, credit: 0 }, { account: ACCOUNTS.MEMBER_SAVINGS, debit: 0, credit: amount }]
        : [{ account: ACCOUNTS.MEMBER_SAVINGS, debit: amount, credit: 0 }, { account: counter, debit: 0, credit: amount }]);
      s.audit('customers', customer.customerId, 'UPDATE', params.reason, { totalSavingsBalance: { before, after } }, branchId);
      return txn;
    });
  }

  /**
   * ভর্তি ফি ও পাসবুক ফি।
   * ক্যাশিয়ার ছাড়া অন্য কেউ নিলে (FIELD): রসিদ — টাকা তাঁর হাতে, ক্যাশ ক্লোজিংয়ে ক্যাশিয়ার গ্রহণ করলে ভল্টে।
   * শাখায় ক্যাশিয়ার নিলে (COUNTER): সরাসরি ভল্টে।
   */
  async postMemberFees(customerId: number, fees: { admission: number; passbook: number }, actor: Actor, channel: CashChannel = defaultChannel(actor)): Promise<void> {
    const items = [
      { type: 'ADMISSION' as const, amount: round2(fees.admission || 0), label: 'ভর্তি ফি' },
      { type: 'PASSBOOK' as const, amount: round2(fees.passbook || 0), label: 'পাসবুক ফি' }
    ].filter(i => i.amount > 0);
    if (!items.length) return;
    const field = channel === 'FIELD';

    await this.runner.run(actor, `FEE-${customerId}`, async s => {
      const custSnap = await s.tx.get(this.runner.customerRef(customerId));
      const customer = custSnap.data() as Customer;
      const branchId = Number(customer.branchId);
      if (!field) await s.readBranch(branchId);
      await s.assertDayOpen(branchId);
      const feeId = await s.reserve('feeTransactions', items.length);
      const vaultId = field ? 0 : await s.reserve('vaultTransactions', items.length);
      const receiptId = field ? await s.reserve('receipts', 1) : 0;
      const journalId = await s.reserve('journalEntries', 1);
      const total = items.reduce((sum, i) => sum + i.amount, 0);
      if (field) s.correlationId = `FEE-RCP-${receiptId}`;
      items.forEach((item, idx) => {
        s.fee({ id: feeId + idx, branchId, customerId, feeType: item.type, amount: item.amount });
        if (!field) {
          s.vaultMove({ id: vaultId + idx, branchId, type: 'FEE_IN', direction: 'IN', amount: item.amount, refType: 'FEE', refId: feeId + idx, note: `${item.label} — ${customer.fullName}` });
        }
      });
      if (field) {
        const receipt: PaymentCollection = {
          receiptId, receiptType: 'FEE',
          loanId: 0, customerId, customerName: customer.fullName, installmentNo: 0,
          branchId, centerId: Number(customer.centerId),
          collectedByUserId: actor.userId, collectedByName: actor.name,
          principalAmountCollected: 0, profitAmountCollected: 0, savingsAmountCollected: 0, fineAmountCollected: 0,
          feeAmountCollected: total, feeBreakdown: items.map(i => ({ feeType: i.type, amount: i.amount })),
          totalAmountCollected: total, paymentMethod: 'CASH', collectionDate: s.now,
          isHandedOverToBranch: false, correlationId: s.correlationId,
          isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
          history: [s.historyEntry('PAYMENT_COLLECTED', 'ভর্তি / পাসবুক ফি (মাঠে)', undefined, { total })]
        };
        s.set(doc(this.firestore, 'collections', String(receiptId)), receipt);
        s.audit('collections', receiptId, 'PAYMENT_COLLECTED', 'মাঠে ভর্তি / পাসবুক ফি', { totalAmountCollected: { before: null, after: total } }, branchId);
      }
      s.journal(journalId, branchId, `সদস্য ভর্তি ফি — ${customer.fullName}`, [
        { account: field ? ACCOUNTS.CASH_IN_FIELD : ACCOUNTS.VAULT_CASH, debit: total, credit: 0 },
        { account: ACCOUNTS.FEE_INCOME, debit: 0, credit: total }
      ]);
      const custFields = { admissionFeePaid: items.find(i => i.type === 'ADMISSION')?.amount || 0, passbookFeePaid: items.find(i => i.type === 'PASSBOOK')?.amount || 0 };
      s.update(this.runner.customerRef(customerId), { ...custFields, history: s.appendHistory(customer, s.historyEntry('UPDATE', 'ভর্তি ও পাসবুক ফি জমা', customer, custFields)) });
    });
  }

  /**
   * মাসিক সঞ্চয় মুনাফা জমা — প্রতিটি গ্রাহকের জন্য আলাদা ট্রানজ্যাকশন; চলমান রেকর্ড রাখা হয় যাতে
   * মাঝপথে বন্ধ হলে পুনরায় চালালে দ্বিগুণ জমা না হয়।
   */
  async postSavingsInterest(branchId: number, month: string, actor: Actor, onProgress?: (done: number, total: number) => void): Promise<{ posted: number; totalInterest: number }> {
    this.assertVaultAccess(actor);
    const general = await this.settings.getGeneralSettings(true);
    const rate = Number(general.savingsInterestAnnualPercent) || 0;
    if (rate <= 0) throw new Error('সাধারণ সেটিংসে সঞ্চয়ের বার্ষিক মুনাফার হার নির্ধারণ করুন');
    const markerRef = doc(this.firestore, 'savingsInterestPostings', `${branchId}_${month}`);
    const marker = await getDoc(markerRef);
    const done = new Set<number>(marker.exists() ? (marker.data()['customerIds'] || []) : []);
    if (marker.exists() && marker.data()['status'] === 'COMPLETED') throw new Error(`${month} মাসের মুনাফা এই শাখায় ইতোমধ্যে জমা হয়েছে`);

    const snap = await getDocs(query(collection(this.firestore, 'customers'), where('branchId', '==', Number(branchId))));
    const customers = snap.docs.map(d => d.data() as Customer).filter(c => !c.isDeleted && (c.totalSavingsBalance || 0) > 0 && c.status !== 'CLOSED');
    let posted = 0, totalInterest = 0;
    for (const c of customers) {
      if (done.has(c.customerId)) continue;
      const interest = Math.round((c.totalSavingsBalance || 0) * rate / 100 / 12);
      if (interest > 0) {
        await this.recordSavings({ customerId: c.customerId, type: 'INTEREST', amount: interest, isCredit: true, paymentMethod: 'CASH', reason: `${month} মাসের সঞ্চয় মুনাফা (${rate}% বার্ষিক)` }, actor);
        posted++;
        totalInterest += interest;
      }
      done.add(c.customerId);
      await setDoc(markerRef, { branchId, month, status: 'IN_PROGRESS', customerIds: [...done], updatedAt: new Date().toISOString() });
      onProgress?.(done.size, customers.length);
    }
    await setDoc(markerRef, { branchId, month, status: 'COMPLETED', customerIds: [...done], rate, posted, totalInterest, completedAt: new Date().toISOString(), by: this.runner.audit.actorStamp(actor) });
    return { posted, totalInterest };
  }

  // =====================================================================
  // ৪. দিবস সমাপনী ও মাস সমাপনী
  // =====================================================================

  /** ভল্ট/সমাপনী লেনদেনের অনুমতি — সুপার অ্যাডমিন, অ্যাডমিন, হেড অফিস, BM, ক্যাশিয়ার */
  private assertVaultAccess(actor: Actor) {
    if (!canOperateVaultFor(actor.role, actor.category)) throw new Error(VAULT_ACCESS_DENIED);
  }

  async getDayStatus(branchId: number, date = todayDhaka()): Promise<PeriodClosing | null> {
    const snap = await getDoc(doc(this.firestore, 'periodClosings', `${branchId}_${date}`));
    return snap.exists() ? (snap.data() as PeriodClosing) : null;
  }

  /**
   * দিবস সমাপনী — সব মাঠকর্মীর নগদ জমা নেওয়ার পর। দিনের সারাংশ সংরক্ষণ ও তারিখ লক।
   */
  async closeDay(branchId: number, actor: Actor): Promise<DailyBranchSummary> {
    this.assertVaultAccess(actor);
    const date = todayDhaka();
    const pendingCash = (await this.receiptsBetween(date, date))
      .filter(r => Number(r.branchId) === Number(branchId) && !r.isReversed && !r.isHandedOverToBranch && r.paymentMethod === 'CASH');
    if (pendingCash.length) {
      const officers = [...new Set(pendingCash.map(r => r.collectedByName))].join(', ');
      throw new Error(`আজকের ${pendingCash.length}টি নগদ রসিদ এখনো ভল্টে জমা হয়নি (${officers})। আগে ক্যাশ ক্লোজিং সম্পন্ন করুন।`);
    }
    const summary = await this.buildDailySummary(branchId, date, actor);

    return this.runner.run(actor, `DAY-${branchId}-${date}`, async s => {
      const lockRef = doc(this.firestore, 'periodClosings', `${branchId}_${date}`);
      const lock = await s.tx.get(lockRef);
      if (lock.exists() && lock.data()['status'] === 'CLOSED') throw new Error('আজকের দিবস সমাপনী ইতোমধ্যে সম্পন্ন');
      const closing: PeriodClosing = { closingId: `${branchId}_${date}`, branchId: Number(branchId), periodType: 'DAY', period: date, status: 'CLOSED', closedAt: s.now, closedBy: s.actor };
      s.set(lockRef, closing);
      s.set(doc(this.firestore, 'dailyBranchSummaries', summary.summaryId), summary);
      s.audit('periodClosings', closing.closingId, 'DAY_CLOSED', 'দিবস সমাপনী', { status: { before: lock.exists() ? lock.data()['status'] : null, after: 'CLOSED' } }, branchId);
      return summary;
    });
  }

  /** বন্ধ দিন পুনরায় খোলা — শুধু অ্যাডমিন / প্রধান কার্যালয়, কারণসহ */
  async reopenDay(branchId: number, date: string, reason: string, actor: Actor): Promise<void> {
    this.assertVaultAccess(actor);
    if (!reason.trim()) throw new Error('দিন পুনরায় খোলার কারণ লিখুন');
    await this.runner.run(actor, `DAY-REOPEN-${branchId}-${date}`, async s => {
      const lockRef = doc(this.firestore, 'periodClosings', `${branchId}_${date}`);
      const lock = await s.tx.get(lockRef);
      if (!lock.exists() || lock.data()['status'] !== 'CLOSED') throw new Error('দিনটি বন্ধ অবস্থায় নেই');
      const fields = { status: 'REOPENED', reopenedAt: s.now, reopenedBy: s.actor, reopenReason: reason.trim() };
      s.update(lockRef, fields);
      s.audit('periodClosings', `${branchId}_${date}`, 'DAY_REOPENED', reason, { status: { before: 'CLOSED', after: 'REOPENED' } }, branchId);
    });
  }

  /** মাস সমাপনী — পোর্টফোলিও স্ন্যাপশট (শ্রেণীকরণ, সঞ্চিতি, PAR, OTR, CRR) */
  async closeMonth(branchId: number, month: string, actor: Actor): Promise<MonthlyPortfolioSnapshot> {
    this.assertVaultAccess(actor);
    const loansSnap = await getDocs(query(collection(this.firestore, 'loans'), where('branchId', '==', Number(branchId))));
    const loans = loansSnap.docs.map(d => d.data() as Loan).filter(l => !l.isDeleted);
    const quality = portfolioQuality(loans);
    const instSnap = await getDocs(query(collection(this.firestore, 'installments'), where('branchId', '==', Number(branchId))));
    const installments = instSnap.docs.map(d => d.data() as InstallmentSchedule);
    const monthEnd = this.lastDayOf(month);
    const rates = recoveryRates(installments, monthEnd < todayDhaka() ? monthEnd : todayDhaka(), toDhakaDayKey);
    const now = new Date().toISOString();
    const snapshot: MonthlyPortfolioSnapshot = {
      snapshotId: `${branchId}_${month}`,
      branchId: Number(branchId), month,
      loansCount: quality.loansCount,
      outstandingPrincipal: quality.outstandingPrincipal,
      par1Percent: quality.par1Percent,
      par30Percent: quality.par30Percent,
      requiredProvision: quality.requiredProvision,
      byClass: quality.byClass.map(b => ({ classification: b.rule.classification, loans: b.loans, outstanding: b.outstanding, provision: b.provision })),
      otrPercent: rates.otrPercent,
      crrPercent: rates.crrPercent,
      createdAt: now,
      createdBy: this.runner.audit.actorStamp(actor)
    };
    await this.runner.run(actor, `MON-${branchId}-${month}`, async s => {
      const lockRef = doc(this.firestore, 'periodClosings', `${branchId}_${month}`);
      const lock = await s.tx.get(lockRef);
      if (lock.exists() && lock.data()['status'] === 'CLOSED') throw new Error(`${month} মাস ইতোমধ্যে সমাপ্ত`);
      s.set(lockRef, { closingId: `${branchId}_${month}`, branchId: Number(branchId), periodType: 'MONTH', period: month, status: 'CLOSED', closedAt: s.now, closedBy: s.actor } as PeriodClosing);
      s.set(doc(this.firestore, 'monthlyPortfolioSnapshots', snapshot.snapshotId), snapshot);
      s.audit('periodClosings', `${branchId}_${month}`, 'DAY_CLOSED', 'মাস সমাপনী', { status: { before: null, after: 'CLOSED' } }, branchId);
    });
    return snapshot;
  }

  private lastDayOf(month: string): string {
    const [y, m] = month.split('-').map(Number);
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }

  async buildDailySummary(branchId: number, date: string, actor: Actor): Promise<DailyBranchSummary> {
    const [vault, receipts, branchSnap, loansSnap, customersSnap, expenses] = await Promise.all([
      this.getVaultTransactions(branchId, date, date),
      this.receiptsBetween(date, date),
      getDoc(doc(this.firestore, 'branches', String(branchId))),
      getDocs(query(collection(this.firestore, 'loans'), where('branchId', '==', Number(branchId)))),
      getDocs(query(collection(this.firestore, 'customers'), where('branchId', '==', Number(branchId)))),
      this.getExpenses(branchId, date, date)
    ]);
    const branch = branchSnap.data() as Branch;
    const ordered = [...vault].sort((a, b) => a.vaultTransactionId - b.vaultTransactionId);
    const vaultIn: Record<string, number> = {};
    const vaultOut: Record<string, number> = {};
    for (const v of ordered) {
      const bucket = v.direction === 'IN' ? vaultIn : vaultOut;
      bucket[v.type] = round2((bucket[v.type] || 0) + v.amount);
    }
    const branchReceipts = receipts.filter(r => Number(r.branchId) === Number(branchId));
    const valid = branchReceipts.filter(r => !r.isReversed);
    const loans = loansSnap.docs.map(d => d.data() as Loan).filter(l => !l.isDeleted);
    const quality = portfolioQuality(loans);
    const disbursedToday = loans.filter(l => l.disbursementDate === date && l.status !== 'APPROVED');
    const newMembers = customersSnap.docs.map(d => d.data() as Customer).filter(c => !c.isDeleted && toDhakaDayKey(c.createdAt) === date).length;

    return {
      summaryId: `${branchId}_${date}`,
      branchId: Number(branchId),
      date,
      openingVault: ordered.length ? ordered[0].balanceBefore : (Number(branch.currentVaultCash) || 0),
      closingVault: Number(branch.currentVaultCash) || 0,
      vaultIn, vaultOut,
      bankBalance: Number(branch.currentBankBalance) || 0,
      collectionsCount: valid.length,
      collectionsTotal: round2(valid.reduce((s, r) => s + (r.totalAmountCollected || 0), 0)),
      kistiCollected: round2(valid.reduce((s, r) => s + (r.principalAmountCollected || 0) + (r.profitAmountCollected || 0), 0)),
      savingsCollected: round2(valid.reduce((s, r) => s + (r.savingsAmountCollected || 0), 0)),
      disbursementsCount: disbursedToday.length,
      disbursedAmount: round2(disbursedToday.reduce((s, l) => s + l.principalAmount, 0)),
      expensesTotal: round2(expenses.reduce((s, e) => s + e.amount, 0)),
      newMembers,
      reversalsCount: branchReceipts.filter(r => r.isReversed).length,
      outstandingPrincipal: quality.outstandingPrincipal,
      par1Percent: quality.par1Percent,
      par30Percent: quality.par30Percent,
      createdAt: new Date().toISOString(),
      createdBy: this.runner.audit.actorStamp(actor)
    };
  }

  // =====================================================================
  // ৫. পাঠ (রিপোর্ট ও খতিয়ান)
  // =====================================================================

  async getVaultTransactions(branchId: number | null, from: string, to: string): Promise<VaultTransaction[]> {
    return (await this.byBusinessDate<VaultTransaction>('vaultTransactions', from, to))
      .filter(v => branchId === null || Number(v.branchId) === Number(branchId))
      .sort((a, b) => a.vaultTransactionId - b.vaultTransactionId);
  }

  async getJournalEntries(branchId: number | null, from: string, to: string): Promise<JournalEntry[]> {
    return (await this.byBusinessDate<JournalEntry>('journalEntries', from, to))
      .filter(j => branchId === null || Number(j.branchId) === Number(branchId))
      .sort((a, b) => a.journalId - b.journalId);
  }

  async getExpenses(branchId: number | null, from: string, to: string): Promise<Expense[]> {
    return (await this.byBusinessDate<Expense>('expenses', from, to))
      .filter(e => branchId === null || Number(e.branchId) === Number(branchId))
      .sort((a, b) => b.expenseId - a.expenseId);
  }

  async getDailySummaries(branchId: number): Promise<DailyBranchSummary[]> {
    const snap = await getDocs(query(collection(this.firestore, 'dailyBranchSummaries'), where('branchId', '==', Number(branchId))));
    return snap.docs.map(d => d.data() as DailyBranchSummary).sort((a, b) => b.date.localeCompare(a.date));
  }

  async getMonthlySnapshots(branchId: number): Promise<MonthlyPortfolioSnapshot[]> {
    const snap = await getDocs(query(collection(this.firestore, 'monthlyPortfolioSnapshots'), where('branchId', '==', Number(branchId))));
    return snap.docs.map(d => d.data() as MonthlyPortfolioSnapshot).sort((a, b) => b.month.localeCompare(a.month));
  }

  /** সঞ্চয় লেনদেন (জমা/উত্তোলন/কিস্তির সাথে সঞ্চয়/মুনাফা …) — ঢাকার দিনের সীমা অনুযায়ী */
  async savingsTransactionsBetween(from: string, to: string): Promise<SavingsTransaction[]> {
    const start = new Date(`${from}T00:00:00+06:00`).toISOString();
    const end = new Date(`${addDaysKey(to, 1)}T00:00:00+06:00`).toISOString();
    const snap = await getDocs(query(collection(this.firestore, 'savingsTransactions'), where('transactionDate', '>=', start), where('transactionDate', '<', end)));
    return snap.docs.map(d => d.data() as SavingsTransaction)
      .filter(t => !t.isDeleted)
      .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate) || b.transactionId - a.transactionId);
  }

  /** রসিদের তারিখ ISO (UTC) — ঢাকার দিনের সীমা অনুযায়ী আনা হয় */
  async receiptsBetween(from: string, to: string): Promise<PaymentCollection[]> {
    const start = new Date(`${from}T00:00:00+06:00`).toISOString();
    const end = new Date(`${addDaysKey(to, 1)}T00:00:00+06:00`).toISOString();
    const snap = await getDocs(query(collection(this.firestore, 'collections'), where('collectionDate', '>=', start), where('collectionDate', '<', end)));
    return snap.docs.map(d => d.data() as PaymentCollection).filter(r => !r.isDeleted);
  }

  private async byBusinessDate<T>(col: string, from: string, to: string): Promise<T[]> {
    try {
      const snap = await getDocs(query(collection(this.firestore, col), where('businessDate', '>=', from), where('businessDate', '<=', to)));
      return snap.docs.map(d => d.data() as T);
    } catch (err) {
      console.error(`Error loading ${col}:`, err);
      return [];
    }
  }

  monthKey(): string {
    return monthKeyDhaka();
  }
}
