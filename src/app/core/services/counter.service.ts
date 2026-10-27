import { Injectable, inject } from '@angular/core';
import { Firestore, doc, runTransaction, getDoc } from '@angular/fire/firestore';

export type EntitySequence = 
  | 'customers' 
  | 'loans' 
  | 'installments' 
  | 'receipts' 
  | 'branches' 
  | 'centers' 
  | 'staff' 
  | 'roles' 
  | 'reconciliations' 
  | 'history'
  | 'savings'
  | 'loanTransactions'
  | 'vaultTransactions'
  | 'feeTransactions'
  | 'expenses'
  | 'followUps'
  | 'insuranceClaims'
  | 'memberTransfers'
  | 'journalEntries'
  | 'loanProducts';

// Default starting Integer IDs for each table (like bank / microfinance numbering)
const STARTING_SEQUENCES: Record<EntitySequence, number> = {
  branches: 1,
  centers: 101,
  staff: 501,
  roles: 10,
  customers: 10001,
  loans: 20001,
  installments: 30001,
  receipts: 40001,
  reconciliations: 50001,
  history: 1,
  savings: 60001,
  loanTransactions: 70001,
  vaultTransactions: 80001,
  feeTransactions: 90001,
  expenses: 91001,
  followUps: 92001,
  insuranceClaims: 93001,
  memberTransfers: 94001,
  journalEntries: 100001,
  loanProducts: 1
};

/** শাখাভিত্তিক ভাউচার / স্লিপ ক্রমিক নং (যেমন voucher_BD_1) — ১ থেকে শুরু */
export type VoucherSequence = `voucher_${string}`;

export function voucherSequence(prefix: string, branchId: number): VoucherSequence {
  return `voucher_${prefix}_${branchId}`;
}

/** কাউন্টার না থাকলে শেষ ইস্যুকৃত আইডি = শুরুর আগের সংখ্যা */
export function startingSequence(entity: EntitySequence | VoucherSequence): number {
  return STARTING_SEQUENCES[entity as EntitySequence] ?? 1;
}

@Injectable({
  providedIn: 'root'
})
export class CounterService {
  private firestore = inject(Firestore);

  /**
   * Generates the next atomic, auto-incrementing Integer ID for any table in Firestore.
   * Completely race-condition proof using Firestore atomic transactions.
   */
  async getNextIntegerId(entity: EntitySequence): Promise<number> {
    const counterDocRef = doc(this.firestore, 'counters', entity);

    const nextId = await runTransaction(this.firestore, async (transaction) => {
      const counterDoc = await transaction.get(counterDocRef);

      let currentId = STARTING_SEQUENCES[entity];

      if (counterDoc.exists()) {
        const data = counterDoc.data();
        currentId = data['currentSequenceId'] || currentId;
        currentId += 1;
      } else {
        // If not initialized, start at initial sequence
        currentId = STARTING_SEQUENCES[entity];
      }

      transaction.set(counterDocRef, {
        entityName: entity,
        currentSequenceId: currentId,
        updatedAt: new Date().toISOString()
      });

      return currentId;
    });

    return nextId;
  }

  /**
   * Reserves a block of `count` consecutive Integer IDs in one atomic transaction.
   * Returns the first ID; the caller owns [first, first + count - 1].
   * (বাল্ক অপারেশনে প্রতিটি আইডির জন্য আলাদা ট্রানজ্যাকশন এড়াতে)
   */
  async reserveIntegerIds(entity: EntitySequence, count: number): Promise<number> {
    if (count <= 0) throw new Error('count must be positive');
    const counterDocRef = doc(this.firestore, 'counters', entity);

    return runTransaction(this.firestore, async (transaction) => {
      const counterDoc = await transaction.get(counterDocRef);
      const firstId = counterDoc.exists()
        ? (counterDoc.data()['currentSequenceId'] || STARTING_SEQUENCES[entity]) + 1
        : STARTING_SEQUENCES[entity];

      transaction.set(counterDocRef, {
        entityName: entity,
        currentSequenceId: firstId + count - 1,
        updatedAt: new Date().toISOString()
      });

      return firstId;
    });
  }

  /**
   * Peeks the next expected Integer ID without incrementing the sequence counter.
   */
  async peekNextIntegerId(entity: EntitySequence | VoucherSequence): Promise<number> {
    try {
      const counterDocRef = doc(this.firestore, 'counters', entity);
      const snap = await getDoc(counterDocRef);
      if (snap.exists()) {
        const data = snap.data();
        const current = data['currentSequenceId'] || startingSequence(entity);
        return current + 1;
      }
      return startingSequence(entity);
    } catch {
      return startingSequence(entity);
    }
  }
}
