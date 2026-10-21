import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Firestore, doc, getDoc, collection, query, where, getDocs, orderBy } from '@angular/fire/firestore';
import { Loan, InstallmentSchedule } from '../../../core/models/database.models';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { HistoryModalComponent } from '../../../shared/components/history-modal/history-modal.component';

@Component({
  selector: 'app-loan-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, HistoryModalComponent],
  templateUrl: './loan-detail.component.html',
  styleUrl: './loan-detail.component.scss'
})
export class LoanDetailComponent implements OnInit {
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);

  loanId: number = 20001;
  readonly loan = signal<Loan | null>(null);
  readonly installments = signal<InstallmentSchedule[]>([]);
  readonly loading = signal<boolean>(true);

  // Quick collection modal state
  selectedInstallmentForCollect = signal<InstallmentSchedule | null>(null);
  collectInstallmentAmount: number = 740;
  collectSavingsAmount: number = 50;
  collectPaymentMethod: 'CASH' | 'BKASH' | 'NAGAD' = 'CASH';
  collecting: boolean = false;

  showHistoryModal = signal<boolean>(false);

  async ngOnInit() {
    const idParam = this.route.snapshot.paramMap.get('id');
    if (idParam) {
      this.loanId = Number(idParam);
    }
    await this.loadLoanAndInstallments();
  }

  async loadLoanAndInstallments() {
    this.loading.set(true);
    try {
      // 1. Fetch Loan
      const loanDocRef = doc(this.firestore, 'loans', this.loanId.toString());
      const loanSnap = await getDoc(loanDocRef);
      if (loanSnap.exists()) {
        this.loan.set(loanSnap.data() as Loan);
      }

      // 2. Fetch Installments
      const instRef = collection(this.firestore, 'installments');
      const instQuery = query(instRef, where('loanId', '==', this.loanId));
      const instSnap = await getDocs(instQuery);
      const list: InstallmentSchedule[] = [];
      instSnap.forEach(d => list.push(d.data() as InstallmentSchedule));
      
      // Sort by installmentNo ascending
      list.sort((a, b) => a.installmentNo - b.installmentNo);
      this.installments.set(list);

    } catch (err) {
      console.error('Error loading loan details:', err);
    } finally {
      this.loading.set(false);
    }
  }

  getFirstPendingInstallment(): InstallmentSchedule | undefined {
    return this.installments().find(i => i.status === 'PENDING');
  }

  getLatestPaidInstallment(): InstallmentSchedule | undefined {
    const paidList = this.installments().filter(i => i.status === 'PAID');
    if (paidList.length === 0) return undefined;
    return paidList.reduce((prev, curr) => {
      const prevTime = prev.paidDate ? new Date(prev.paidDate).getTime() : 0;
      const currTime = curr.paidDate ? new Date(curr.paidDate).getTime() : 0;
      if (currTime !== prevTime) {
        return currTime > prevTime ? curr : prev;
      }
      return curr.installmentNo > prev.installmentNo ? curr : prev;
    });
  }

  isLockedByWeeklyRule(): boolean {
    const latestPaid = this.getLatestPaidInstallment();
    if (!latestPaid || !latestPaid.paidDate) return false;
    const diffDays = (Date.now() - new Date(latestPaid.paidDate).getTime()) / (1000 * 60 * 60 * 24);
    return diffDays < 7;
  }

  getDaysRemainingForNextInstallment(): number {
    const latestPaid = this.getLatestPaidInstallment();
    if (!latestPaid || !latestPaid.paidDate) return 0;
    const diffDays = (Date.now() - new Date(latestPaid.paidDate).getTime()) / (1000 * 60 * 60 * 24);
    return Math.max(1, Math.ceil(7 - diffDays));
  }

  getNextEligiblePaymentDate(): string {
    const latestPaid = this.getLatestPaidInstallment();
    if (!latestPaid || !latestPaid.paidDate) return '';
    const nextTime = new Date(latestPaid.paidDate).getTime() + 7 * 24 * 60 * 60 * 1000;
    return new Date(nextTime).toISOString().split('T')[0];
  }

  canTakeAmount(): boolean {
    const user = this.authService.currentUser();
    if (!user) return false;
    const role = user.role;
    const category = user.category;
    return (
      role === 'BRANCH_MANAGER' ||
      role === 'SUPER_ADMIN' ||
      role === 'ADMIN' ||
      role === 'AREA_MANAGER' ||
      role === 'MANAGING_DIRECTOR' ||
      role === 'FIELD_OFFICER' ||
      category === 'SYSTEM_ADMIN' ||
      category === 'HEAD_OFFICE' ||
      this.authService.canCollectKisti()
    );
  }

  isInstallmentCollectable(inst: InstallmentSchedule): boolean {
    if (inst.status === 'PAID') return false;

    // Allow collection for every unpaid installment payment
    return this.canTakeAmount();
  }

  openCollectModal(inst: InstallmentSchedule) {
    if (!this.canTakeAmount()) {
      alert('শুধুমাত্র শাখা ব্যবস্থাপক (Branch Manager), অ্যাডমিন, সুপার অ্যাডমিন ও হেড অফিস কর্মকর্তাগণ এখান থেকে সরাসরি কিস্তি আদায় করতে পারবেন।');
      return;
    }
    if (inst.status === 'PAID') {
      alert('এই কিস্তি ইতিমধ্যে পরিশোধ করা হয়েছে।');
      return;
    }

    this.selectedInstallmentForCollect.set(inst);
    const principal = Number(inst.expectedPrincipal) || 0;
    const profit = Number(inst.expectedProfit) || 0;
    this.collectInstallmentAmount = principal + profit;
    this.collectSavingsAmount = Number(inst.expectedSavings) || 0;
  }

  getTotalCollectionAmount(): number {
    const instAmt = Number(this.collectInstallmentAmount) || 0;
    const savAmt = Number(this.collectSavingsAmount) || 0;
    return instAmt + savAmt;
  }

  closeCollectModal() {
    this.selectedInstallmentForCollect.set(null);
  }

  async submitCollection() {
    const inst = this.selectedInstallmentForCollect();
    const l = this.loan();
    if (!inst || !l) return;

    const instAmt = Number(this.collectInstallmentAmount) || 0;
    const savAmt = Number(this.collectSavingsAmount) || 0;
    const totalCollected = instAmt + savAmt;

    if (totalCollected <= 0) {
      alert('অনুগ্রহ করে আদায়ের সঠিক পরিমাণ দিন');
      return;
    }

    this.collecting = true;
    const currentUser = this.authService.currentUser();

    // Calculate principal and profit breakdown
    const expectedPrincipal = Number(inst.expectedPrincipal) || 0;
    const expectedProfit = Number(inst.expectedProfit) || 0;
    const expectedTotal = expectedPrincipal + expectedProfit;
    let principalCollected = 0;
    let profitCollected = 0;

    if (expectedTotal > 0) {
      if (instAmt === expectedTotal) {
        principalCollected = expectedPrincipal;
        profitCollected = expectedProfit;
      } else {
        const profitRatio = expectedProfit / expectedTotal;
        profitCollected = Math.round(instAmt * profitRatio);
        principalCollected = instAmt - profitCollected;
      }
    } else {
      principalCollected = instAmt;
      profitCollected = 0;
    }

    try {
      // Record payment collection and update loan
      await this.kistiService.collectPayment(
        {
          loanId: l.loanId,
          customerId: l.customerId,
          customerName: l.customerName,
          installmentId: inst.installmentId,
          installmentNo: inst.installmentNo,
          branchId: l.branchId,
          centerId: l.centerId,
          collectedByUserId: currentUser.userId,
          collectedByName: currentUser.name,
          principalAmountCollected: principalCollected,
          profitAmountCollected: profitCollected,
          savingsAmountCollected: savAmt,
          fineAmountCollected: 0,
          totalAmountCollected: totalCollected,
          paymentMethod: this.collectPaymentMethod,
          collectionDate: new Date().toISOString()
        },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        `কিস্তি #${inst.installmentNo} আদায় সম্পন্ন`
      );

      // Update installment document status
      await this.kistiService.editRecord(
        'installments',
        inst.installmentId,
        {
          paidPrincipal: principalCollected,
          paidProfit: profitCollected,
          paidSavings: savAmt,
          paidTotalAmount: totalCollected,
          status: 'PAID',
          paidDate: new Date().toISOString()
        },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        'কিস্তি আদায় ও স্ট্যাটাস পরিবর্তন'
      );

      this.closeCollectModal();
      await this.loadLoanAndInstallments();
      alert(`কিস্তি নং ${inst.installmentNo} সফলভাবে আদায় হয়েছে (রসিদ তৈরি সম্পন্ন)`);
    } catch (err) {
      console.error('Collection error:', err);
      alert('কিস্তি আদায়ে সমস্যা হয়েছে');
    } finally {
      this.collecting = false;
    }
  }
}
