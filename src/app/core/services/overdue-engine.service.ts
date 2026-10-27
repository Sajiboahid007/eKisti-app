import { Injectable, inject } from '@angular/core';
import { collection, doc, getDoc, getDocs, query, setDoc, where, writeBatch, WriteBatch } from '@angular/fire/firestore';
import { Customer, InstallmentSchedule, Loan } from '../models/database.models';
import { nextCreditScore, overdueMarkerId, planOverdueRun } from '../finance/overdue';
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

/**
 * বকেয়া ইঞ্জিন — নির্ধারিত তারিখ পার হওয়া কিস্তি OVERDUE, ঋণের বকেয়া টাকা/দিন, MRA শ্রেণীকরণ
 * ও গ্রাহকের ক্রেডিট স্কোর হালনাগাদ। পুনরায় চালালে একই ফল (idempotent)।
 *
 * মূল দৈনিক রান সার্ভারে: Cloud Function `dailyOverdueEngine` (রাত ১২:০৫, Asia/Dhaka) — functions/src/index.ts।
 * সার্ভার আজ চালিয়ে থাকলে (systemJobs/overdue_ALL) ড্যাশবোর্ড আর চালায় না; না চললে (ফাংশন ডিপ্লয় না থাকলে)
 * প্রথম লগইনে ড্যাশবোর্ড থেকে এটি ব্যাকআপ হিসেবে চলে, আর ম্যানুয়ালি পুনরায় চালানো যায়।
 */
@Injectable({ providedIn: 'root' })
export class OverdueEngineService {
  private runner = inject(TxRunner);
  private firestore = this.runner.firestore;
  private running: Promise<OverdueRunResult> | null = null;

  /** আজ এই পরিধিতে না চললে চালানো */
  async runIfDue(branchIds: number[] | null, actor: Actor): Promise<OverdueRunResult | null> {
    const today = todayDhaka();
    const ids = [...new Set([overdueMarkerId(null), overdueMarkerId(branchIds)])];
    const markers = await Promise.all(ids.map(id => getDoc(doc(this.firestore, 'systemJobs', id))));
    if (markers.some(m => m.exists() && m.data()['date'] === today)) return null;
    return this.run(branchIds, actor);
  }

  run(branchIds: number[] | null, actor: Actor): Promise<OverdueRunResult> {
    if (!this.running) {
      this.running = this.execute(branchIds, actor).finally(() => { this.running = null; });
    }
    return this.running;
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
    const plan = planOverdueRun(loans, byLoan, today);

    for (const installmentId of plan.installmentIdsToMark) {
      await writer.update(doc(this.firestore, 'installments', String(installmentId)), { status: 'OVERDUE' });
    }

    for (const u of plan.loanUpdates) {
      await writer.update(doc(this.firestore, 'loans', String(u.loanId)), {
        status: u.status,
        overdueAmount: u.overdueAmount,
        missedInstallmentsCount: u.missedInstallmentsCount,
        daysPastDue: u.daysPastDue,
        classification: u.classification,
        classifiedAt: now
      });
      if (u.statusChanged) {
        await writer.set(doc(collection(this.firestore, 'loanStatusHistory')), {
          loanId: u.loanId, fromStatus: u.fromStatus, toStatus: u.status,
          reason: u.reason, branchId: u.branchId, timestamp: now, actor: stamp
        });
      }
    }

    // ক্রেডিট স্কোর
    let creditScoresChanged = 0;
    for (const [customerId, dpd] of plan.maxDpdByCustomer) {
      const snap = await getDoc(doc(this.firestore, 'customers', String(customerId)));
      if (!snap.exists()) continue;
      const customer = snap.data() as Customer;
      const target = nextCreditScore(customer.creditScore, dpd);
      if (!target) continue;
      creditScoresChanged++;
      await writer.update(doc(this.firestore, 'customers', String(customerId)), { creditScore: target, creditScoreUpdatedAt: now });
      await writer.set(doc(collection(this.firestore, 'creditScoreHistory')), {
        customerId, from: customer.creditScore, to: target,
        reason: `বকেয়া ইঞ্জিন: সর্বোচ্চ বকেয়া ${dpd} দিন`, timestamp: now, actor: stamp
      });
    }

    await writer.commit();
    const result: OverdueRunResult = {
      date: today, loansChecked: plan.loansChecked, loansUpdated: plan.loanUpdates.length,
      installmentsMarked: plan.installmentIdsToMark.length, creditScoresChanged, skipped: false
    };
    await setDoc(doc(this.firestore, 'systemJobs', overdueMarkerId(branchIds)), { ...result, ranAt: now, by: stamp });
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
