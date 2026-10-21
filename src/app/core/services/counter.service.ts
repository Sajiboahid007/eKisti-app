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
  | 'savings';

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
  savings: 60001
};

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
   * Peeks the next expected Integer ID without incrementing the sequence counter.
   */
  async peekNextIntegerId(entity: EntitySequence): Promise<number> {
    try {
      const counterDocRef = doc(this.firestore, 'counters', entity);
      const snap = await getDoc(counterDocRef);
      if (snap.exists()) {
        const data = snap.data();
        const current = data['currentSequenceId'] || STARTING_SEQUENCES[entity];
        return current + 1;
      }
      return STARTING_SEQUENCES[entity];
    } catch {
      return STARTING_SEQUENCES[entity];
    }
  }
}
