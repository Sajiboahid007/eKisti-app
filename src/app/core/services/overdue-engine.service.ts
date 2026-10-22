import { Injectable, inject } from '@angular/core';
import { collection, doc, getDoc, getDocs, query, setDoc, where, writeBatch, WriteBatch } from '@angular/fire/firestore';
import { Customer, InstallmentSchedule, Loan, LoanStatus } from '../models/database.models';
import { loanOverdueState } from '../finance/classification';
import { todayDhaka } from '../finance/dates';
import { Actor, TxRunner } from './tx-runner.service';

export interface OverdueRunResult {
  date: string;
  loansChecked: number;
  loansUpdated: number;
  installmentsMarked: number;
  creditScoresChanged: number;
  skipped: boolean;
}

/** ক্রেডিট স্কোর নিয়ম: চলমান ঋণের সর্বোচ্চ বকেয়া দিন অনুযায়ী (কালো তালিকা শুধু ম্যানুয়ালি) */
function scoreFor(maxDaysPastDue: number): Customer['creditScore'] {
  if (maxDaysPastDue === 0) return 'GOOD';
  if (maxDaysPastDue <= 30) return 'AVERAGE';
  return 'RISKY';
}

/**
 * বকেয়া ইঞ্জিন — নির্ধারিত তারিখ পার হওয়া কিস্তি OVERDUE, ঋণের বকেয়া টাকা/দিন, MRA শ্রেণীকরণ
 * ও গ্রাহকের ক্রেডিট স্কোর হালনাগাদ। দিনে একবার (প্রথম লগইনে ড্যাশবোর্ড থেকে) বা ম্যানুয়ালি চলে।
 * পুনরায় চালালে একই ফল (idempotent)।
 *
 * প্রোডাকশনে এটি Cloud Scheduler (রাত ১২:০৫, Asia/Dhaka) দিয়ে সার্ভারে চালানো উচিত।
 */
@Injectable({ providedIn: 'root' })
export class OverdueEngineService {
  private runner = inject(TxRunner);
  private firestore = this.runner.firestore;
  private running: Promise<OverdueRunResult> | null = null;

  /** আজ এই পরিধিতে না চললে চালানো */
  async runIfDue(branchIds: number[] | null, actor: Actor): Promise<OverdueRunResult | null> {
    const marker = await getDoc(doc(this.firestore, 'systemJobs', this.markerId(branchIds)));
    if (marker.exists() && marker.data()['date'] === todayDhaka()) return null;
    return this.run(branchIds, actor);
  }

  run(branchIds: number[] | null, actor: Actor): Promise<OverdueRunResult> {
    if (!this.running) {
      this.running = this.execute(branchIds, actor).finally(() => { this.running = null; });
    }
    return this.running;
  }

  private markerId(branchIds: number[] | null): string {
    return `overdue_${branchIds === null ? 'ALL' : [...branchIds].sort((a, b) => a - b).join('-') || 'NONE'}`;
  }

  private async execute(branchIds: number[] | null, actor: Actor): Promise<OverdueRunResult> {
    const today = todayDhaka();
    const now = new Date().toISOString();
    const stamp = this.runner.audit.actorStamp(actor);
    const inScope = (branchId: number) => branchIds === null || branchIds.includes(Number(branchId));

    const loanSnap = await getDocs(query(collection(this.firestore, 'loans'), where('status', 'in', ['DISBURSED', 'OVERDUE'])));
    const loans = loanSnap.docs.map(d => d.data() as Loan).filter(l => !l.isDeleted && inScope(l.branchId));
    const instSnap = await getDocs(query(collection(this.firestore, 'installments'), where('status', 'in', ['PENDING', 'PARTIAL', 'OVERDUE'])));
    const byLoan = new Map<number, InstallmentSchedule[]>();
    instSnap.forEach(d => {
      const inst = d.data() as InstallmentSchedule;
      if (inst.isDeleted) return;
      const list = byLoan.get(inst.loanId) || [];
      list.push(inst);
      byLoan.set(inst.loanId, list);
    });

    const writer = new ChunkedBatch(() => writeBatch(this.firestore));
    let loansUpdated = 0, installmentsMarked = 0;
    const maxDpdByCustomer = new Map<number, number>();

    for (const loan of loans) {
      const insts = byLoan.get(loan.loanId) || [];
      const state = loanOverdueState(insts, today);
      maxDpdByCustomer.set(loan.customerId, Math.max(maxDpdByCustomer.get(loan.customerId) || 0, state.daysPastDue));

      for (const inst of insts) {
        if (inst.status === 'PENDING' && state.overdueInstallmentIds.includes(inst.installmentId)) {
          await writer.update(doc(this.firestore, 'installments', String(inst.installmentId)), { status: 'OVERDUE' });
          installmentsMarked++;
        }
      }

      const status: LoanStatus = state.missedInstallmentsCount > 0 ? 'OVERDUE' : 'DISBURSED';
      const changed = loan.status !== status
        || (loan.overdueAmount || 0) !== state.overdueAmount
        || (loan.missedInstallmentsCount || 0) !== state.missedInstallmentsCount
        || (loan.daysPastDue || 0) !== state.daysPastDue
        || loan.classification !== state.classification;
      if (!changed) continue;

      loansUpdated++;
      await writer.update(doc(this.firestore, 'loans', String(loan.loanId)), {
        status,
        overdueAmount: state.overdueAmount,
        missedInstallmentsCount: state.missedInstallmentsCount,
        daysPastDue: state.daysPastDue,
        classification: state.classification,
        classifiedAt: now
      });
      if (loan.status !== status) {
        await writer.set(doc(collection(this.firestore, 'loanStatusHistory')), {
          loanId: loan.loanId, fromStatus: loan.status, toStatus: status,
          reason: status === 'OVERDUE' ? `${state.missedInstallmentsCount}টি কিস্তি বকেয়া (${state.daysPastDue} দিন)` : 'বকেয়া পরিশোধিত',
          branchId: Number(loan.branchId), timestamp: now, actor: stamp
        });
      }
    }

    // ক্রেডিট স্কোর
    let creditScoresChanged = 0;
    for (const [customerId, dpd] of maxDpdByCustomer) {
      const snap = await getDoc(doc(this.firestore, 'customers', String(customerId)));
      if (!snap.exists()) continue;
      const customer = snap.data() as Customer;
      if (customer.creditScore === 'BLACKLISTED') continue;
      const next = scoreFor(dpd);
      // একবার ঝুঁকিপূর্ণ হলে বকেয়া শোধেও সরাসরি "ভালো" নয় — "মাঝারি"
      const target = customer.creditScore === 'RISKY' && next === 'GOOD' ? 'AVERAGE' : next;
      if (target === customer.creditScore) continue;
      creditScoresChanged++;
      await writer.update(doc(this.firestore, 'customers', String(customerId)), { creditScore: target, creditScoreUpdatedAt: now });
      await writer.set(doc(collection(this.firestore, 'creditScoreHistory')), {
        customerId, from: customer.creditScore, to: target,
        reason: `বকেয়া ইঞ্জিন: সর্বোচ্চ বকেয়া ${dpd} দিন`, timestamp: now, actor: stamp
      });
    }

    await writer.commit();
    const result: OverdueRunResult = { date: today, loansChecked: loans.length, loansUpdated, installmentsMarked, creditScoresChanged, skipped: false };
    await setDoc(doc(this.firestore, 'systemJobs', this.markerId(branchIds)), { ...result, ranAt: now, by: stamp });
    return result;
  }
}

/** Firestore ব্যাচে ৫০০ লেখার সীমা — স্বয়ংক্রিয়ভাবে ভাগ করে কমিট */
class ChunkedBatch {
  private batch: WriteBatch;
  private count = 0;
  constructor(private factory: () => WriteBatch) {
    this.batch = factory();
  }
  async update(ref: any, data: Record<string, any>) {
    this.batch.update(ref, data);
    await this.tick();
  }
  async set(ref: any, data: object) {
    this.batch.set(ref, data);
    await this.tick();
  }
  private async tick() {
    if (++this.count >= 400) {
      await this.batch.commit();
      this.batch = this.factory();
      this.count = 0;
    }
  }
  async commit() {
    if (this.count > 0) await this.batch.commit();
  }
}
