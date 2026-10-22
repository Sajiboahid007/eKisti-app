import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Firestore, collection, getDocs, doc, getDoc, updateDoc } from '@angular/fire/firestore';
import { PaymentCollection, Branch } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

@Component({
  selector: 'app-cash-closing',
  standalone: true,
  imports: [CommonModule, FormsModule, SkeletonComponent],
  templateUrl: './cash-closing.component.html',
  styleUrl: './cash-closing.component.scss'
})
export class CashClosingComponent implements OnInit {
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);

  readonly branch = signal<Branch | null>(null);
  readonly collectionsToReconcile = signal<PaymentCollection[]>([]);
  readonly loading = signal<boolean>(true);
  readonly verifying = signal<boolean>(false);

  reconciliationNotes: string = '';

  async ngOnInit() {
    await this.loadReconciliationData();
  }

  async loadReconciliationData() {
    this.loading.set(true);
    try {
      // 1. Fetch branch vault info
      const bDoc = await getDoc(doc(this.firestore, 'branches', '1'));
      if (bDoc.exists()) {
        this.branch.set(bDoc.data() as Branch);
      }

      // 2. Fetch collections
      const snap = await getDocs(collection(this.firestore, 'collections'));
      const list: PaymentCollection[] = [];
      snap.forEach(d => list.push(d.data() as PaymentCollection));
      this.collectionsToReconcile.set(list);
    } catch (err) {
      console.error('Error loading reconciliation data:', err);
    } finally {
      this.loading.set(false);
    }
  }

  getPendingHandoverAmount(): number {
    return this.collectionsToReconcile()
      .filter(c => !c.isHandedOverToBranch)
      .reduce((sum, c) => sum + c.totalAmountCollected, 0);
  }

  getCompletedHandoverAmount(): number {
    return this.collectionsToReconcile()
      .filter(c => c.isHandedOverToBranch)
      .reduce((sum, c) => sum + c.totalAmountCollected, 0);
  }

  async verifyAndAcceptCash(rec: PaymentCollection) {
    this.verifying.set(true);
    const currentUser = this.authService.currentUser();

    try {
      // Mark receipt as handed over and reconciled by cashier
      await this.kistiService.editRecord(
        'collections',
        rec.receiptId,
        {
          isHandedOverToBranch: true,
          reconciledAt: new Date().toISOString(),
          reconciledByUserId: currentUser.userId
        },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        'ক্যাশিয়ার কর্তৃক মাঠকর্মীর টাকা গ্রহণ ও ভল্টে জমা'
      );

      // Increase branch vault cash
      if (this.branch()) {
        const currentVault = this.branch()!.currentVaultCash || 0;
        const newVault = currentVault + rec.totalAmountCollected;
        await updateDoc(doc(this.firestore, 'branches', '1'), {
          currentVaultCash: newVault
        });
      }

      await this.loadReconciliationData();
      alert(`রসিদ #${rec.receiptId} এর ৳${rec.totalAmountCollected} সফলভাবে ক্যাশিয়ার ভল্টে গ্রহণ করা হয়েছে`);
    } catch (err) {
      console.error('Verification error:', err);
      alert('ক্যাশ গ্রহণে সমস্যা হয়েছে');
    } finally {
      this.verifying.set(false);
    }
  }
}
