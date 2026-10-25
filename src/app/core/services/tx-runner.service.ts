import { Injectable, inject } from '@angular/core';
import { Firestore, collection, doc, getDoc, getDocs, query, runTransaction, where } from '@angular/fire/firestore';
import { InstallmentSchedule, Loan } from '../models/database.models';
import { todayDhaka } from '../finance/dates';
import { AuditHistoryService } from './audit-history.service';
import { TxSession } from './tx-session';

export type Actor = { userId: number; name: string; role: string; category?: string };

/** ট্রানজ্যাকশনের মাঝে ডেটা বদলে গেলে পুনরায় চেষ্টা করার সংকেত */
export class ConcurrentChangeError extends Error {
  constructor() {
    super('এই ঋণে একই সময়ে অন্য একটি লেনদেন হয়েছে। আবার চেষ্টা করা হচ্ছে…');
  }
}

/**
 * আর্থিক ট্রানজ্যাকশন চালানোর সাধারণ ব্যবস্থা।
 */
@Injectable({ providedIn: 'root' })
export class TxRunner {
  readonly firestore = inject(Firestore);
  readonly audit = inject(AuditHistoryService);

  /** একটি পূর্ণ Firestore ট্রানজ্যাকশন — ConcurrentChangeError হলে সর্বোচ্চ ৩ বার পুনরায় চেষ্টা */
  async run<T>(actor: Actor, correlationId: string, body: (s: TxSession) => Promise<T>, prepare?: () => Promise<void>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (prepare) await prepare();
        return await runTransaction(this.firestore, async tx => {
          const session = new TxSession(
            this.firestore, tx, this.audit,
            { userId: actor.userId, name: actor.name, role: actor.role },
            new Date().toISOString(), todayDhaka(), correlationId
          );
          const result = await body(session);
          session.finish();
          return result;
        });
      } catch (err) {
        lastError = err;
        if (!(err instanceof ConcurrentChangeError)) throw err;
      }
    }
    throw lastError;
  }

  async getLoan(loanId: number): Promise<Loan> {
    const snap = await getDoc(doc(this.firestore, 'loans', String(loanId)));
    if (!snap.exists()) throw new Error(`ঋণ #${loanId} পাওয়া যায়নি`);
    return snap.data() as Loan;
  }

  async getInstallments(loanId: number): Promise<InstallmentSchedule[]> {
    const snap = await getDocs(query(collection(this.firestore, 'installments'), where('loanId', '==', Number(loanId))));
    const list: InstallmentSchedule[] = [];
    snap.forEach(d => {
      const inst = d.data() as InstallmentSchedule;
      if (!inst.isDeleted) list.push(inst);
    });
    return list.sort((a, b) => a.installmentNo - b.installmentNo);
  }

  async loadLoanBundle(loanId: number): Promise<{ loan: Loan; installments: InstallmentSchedule[] }> {
    const [loan, installments] = await Promise.all([this.getLoan(loanId), this.getInstallments(loanId)]);
    return { loan, installments };
  }

  loanRef(loanId: number) {
    return doc(this.firestore, 'loans', String(loanId));
  }

  installmentRef(installmentId: number) {
    return doc(this.firestore, 'installments', String(installmentId));
  }

  customerRef(customerId: number) {
    return doc(this.firestore, 'customers', String(customerId));
  }
}
