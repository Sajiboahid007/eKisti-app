import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Firestore, collection, getDocs, query, where, orderBy, limit } from '@angular/fire/firestore';
import { AuthStateService } from '../../core/services/auth-state.service';
import { LanguageService } from '../../core/services/language.service';
import { Loan, PaymentCollection, Customer } from '../../core/models/database.models';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss'
})
export class DashboardComponent implements OnInit {
  private firestore = inject(Firestore);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  // Stats signals - strictly initialized to 0 and calculated from real database
  readonly todayCollectedAmount = signal<number>(0);
  readonly todayExpectedTarget = signal<number>(0);
  readonly totalVaultCash = signal<number>(0);
  readonly activeLoansCount = signal<number>(0);
  readonly totalOutstanding = signal<number>(0);
  readonly overdueAmount = signal<number>(0);

  // Recent data
  readonly recentLoans = signal<Loan[]>([]);
  readonly recentCollections = signal<PaymentCollection[]>([]);
  readonly loading = signal<boolean>(true);

  async ngOnInit() {
    await this.loadDashboardData();
  }

  async loadDashboardData() {
    this.loading.set(true);
    try {
      const todayStr = new Date().toISOString().split('T')[0];

      // 1. Load loans from Firestore
      const loanSnap = await getDocs(collection(this.firestore, 'loans'));
      const allLoans: Loan[] = [];
      let totalOut = 0;
      let overdue = 0;
      let activeCount = 0;

      loanSnap.forEach(d => {
        const data = d.data() as Loan;
        if (!data.isDeleted) {
          allLoans.push(data);
          if (data.status === 'DISBURSED' || data.status === 'OVERDUE') {
            activeCount++;
          }
          totalOut += data.outstandingBalance || 0;
          overdue += data.overdueAmount || 0;
        }
      });

      allLoans.sort((a, b) => b.loanId - a.loanId);
      this.recentLoans.set(allLoans.slice(0, 5));
      this.activeLoansCount.set(activeCount);
      this.totalOutstanding.set(totalOut);
      this.overdueAmount.set(overdue);

      // 2. Load collections from Firestore
      const colSnap = await getDocs(collection(this.firestore, 'collections'));
      const allCols: PaymentCollection[] = [];
      let todayTotal = 0;

      colSnap.forEach(d => {
        const data = d.data() as PaymentCollection;
        if (!data.isDeleted) {
          allCols.push(data);
          if (data.collectionDate && data.collectionDate.startsWith(todayStr)) {
            todayTotal += data.totalAmountCollected || 0;
          }
        }
      });

      allCols.sort((a, b) => b.receiptId - a.receiptId);
      this.recentCollections.set(allCols.slice(0, 5));
      this.todayCollectedAmount.set(todayTotal);

      // 3. Load vault cash from branches in Firestore
      const branchSnap = await getDocs(collection(this.firestore, 'branches'));
      let vaultTotal = 0;
      branchSnap.forEach(d => {
        const b = d.data() as any;
        if (!b.isDeleted) {
          vaultTotal += b.currentVaultCash || 0;
        }
      });
      this.totalVaultCash.set(vaultTotal);

      // 4. Load today's target from installments scheduled for today
      const instSnap = await getDocs(collection(this.firestore, 'installments'));
      let expectedToday = 0;
      instSnap.forEach(d => {
        const inst = d.data() as any;
        if (!inst.isDeleted && inst.dueDate === todayStr) {
          expectedToday += inst.expectedTotalAmount || 0;
        }
      });
      this.todayExpectedTarget.set(expectedToday);

    } catch (err) {
      console.error('Dashboard data loading error from Firestore:', err);
    } finally {
      this.loading.set(false);
    }
  }
}
