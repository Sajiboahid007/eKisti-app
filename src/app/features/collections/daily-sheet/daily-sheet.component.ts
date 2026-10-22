import { Component, inject, OnInit, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Firestore, collection, getDocs, query, where } from '@angular/fire/firestore';
import { Loan, InstallmentSchedule, CenterOrSamity, Branch } from '../../../core/models/database.models';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService, ActiveUserSession } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

export interface DailySheetItem {
  loan: Loan;
  nextInstallment: InstallmentSchedule;
  isCollectedToday: boolean;
  isLockedForWeek: boolean;
  daysRemainingForNext: number;
  nextEligibleDate: string;
  nextPendingInstallmentNo?: number;
  lastPaidDateFormatted?: string;
}

@Component({
  selector: 'app-daily-sheet',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './daily-sheet.component.html',
  styleUrl: './daily-sheet.component.scss'
})
export class DailySheetComponent implements OnInit {
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly allBranches = signal<Branch[]>([]);

  // এরিয়া ম্যানেজারের নির্ধারিত শাখাগুলোর নাম (কমা দিয়ে)
  getAssignedBranchNames(): string {
    const ids = this.authService.accessibleBranchIds() || [];
    const names = this.allBranches().filter(b => ids.includes(b.branchId)).map(b => b.name);
    return names.length > 0 ? names.join(', ') : 'কোনো শাখা নির্ধারিত নেই';
  }
  readonly allCenters = signal<CenterOrSamity[]>([]);
  readonly filteredCenters = signal<CenterOrSamity[]>([]);
  readonly selectedCenterId = signal<number>(101);
  readonly sheetItems = signal<DailySheetItem[]>([]);
  readonly loading = signal<boolean>(true);

  // Quick Collect Modal state
  activeItemForCollect = signal<DailySheetItem | null>(null);
  collectAmount: number = 600;
  collectSavings: number = 50;
  collectMethod: 'CASH' | 'BKASH' | 'NAGAD' = 'CASH';
  isProcessing: boolean = false;

  readonly userScopeInfo = computed(() => {
    const user = this.authService.currentUser();
    if (user.role === 'FIELD_OFFICER') {
      return {
        title: 'দায়িত্বপ্রাপ্ত ফিল্ড কালেকশন',
        subtitle: `মাঠকর্মী: ${user.name} (শুধুমাত্র বরাদ্দকৃত রুট ও ঋণ)`,
        tag: 'ফিল্ড অফিসার রুট',
        icon: 'person_pin_circle',
        cssClass: 'scope-fo'
      };
    } else if (user.role === 'BRANCH_MANAGER') {
      return {
        title: 'শাখা কালেকশন ও রুট বিবরণী',
        subtitle: `শাখা: ${user.branchName} (শাখার সকল রুট ও ঋণ)`,
        tag: 'শাখা ব্যবস্থাপক ভিউ',
        icon: 'apartment',
        cssClass: 'scope-bm'
      };
    } else if (user.role === 'AREA_MANAGER') {
      return {
        title: 'এরিয়া কালেকশন বিবরণী',
        subtitle: `এরিয়াভুক্ত শাখা: ${this.getAssignedBranchNames()} (শাখাগুলোর রুট ও ঋণ)`,
        tag: 'এরিয়া ম্যানেজার ভিউ',
        icon: 'map',
        cssClass: 'scope-am'
      };
    }
    return {
      title: 'সর্বমোট কালেকশন শিট (সকল এলাকা)',
      subtitle: 'প্রধান কার্যালয় / সুপার অ্যাডমিন (সকল শাখা ও রুট এক্সেস)',
      tag: 'সুপার অ্যাডমিন ভিউ',
      icon: 'admin_panel_settings',
      cssClass: 'scope-admin'
    };
  });

  constructor() {
    // Whenever user role changes in top bar, reactively refresh routes and sheet
    effect(() => {
      const user = this.authService.currentUser();
      if (this.allCenters().length > 0) {
        this.applyRoleFiltering(user);
      }
    });
  }

  async ngOnInit() {
    await this.initData();
  }

  async initData() {
    this.loading.set(true);
    try {
      const [branches, centers] = await Promise.all([
        this.kistiService.getBranches(),
        this.kistiService.getCenters()
      ]);
      this.allBranches.set(branches);
      this.allCenters.set(centers);

      this.applyRoleFiltering(this.authService.currentUser());
    } catch (err) {
      console.error('Error initializing daily sheet:', err);
      this.loading.set(false);
    }
  }

  applyRoleFiltering(user: ActiveUserSession) {
    const centers = this.allCenters();
    const branches = this.allBranches();

    let permitted: CenterOrSamity[] = [];

    if (user.role === 'SUPER_ADMIN' || user.role === 'MANAGING_DIRECTOR') {
      // Super admin sees all routes
      permitted = centers;
    } else if (this.authService.isAreaScoped()) {
      // Area manager sees routes of their assigned branches only
      permitted = centers.filter(c => this.authService.canAccessBranch(c.branchId));
    } else if (user.role === 'BRANCH_MANAGER' || user.role === 'CASHIER') {
      // Branch manager sees routes belonging to their branch
      permitted = centers.filter(c => c.branchId === user.branchId);
    } else if (user.role === 'FIELD_OFFICER') {
      // Field officer sees ONLY their assigned routes (others hidden)
      permitted = centers.filter(c => 
        c.fieldOfficerUserId === user.userId || 
        (user.assignedCenterIds && user.assignedCenterIds.includes(c.centerId))
      );
    } else {
      permitted = centers;
    }

    this.filteredCenters.set(permitted);

    // If current selected center is not permitted, select first permitted or 0
    if (permitted.length > 0) {
      if (!permitted.some(c => c.centerId === this.selectedCenterId())) {
        this.selectedCenterId.set(permitted[0].centerId);
      }
    } else {
      this.selectedCenterId.set(0);
    }

    this.loadSheetData();
  }

  async loadSheetData() {
    const centerId = this.selectedCenterId();
    if (!centerId || centerId === 0) {
      this.sheetItems.set([]);
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    const currentUser = this.authService.currentUser();

    try {
      // 1. Load loans via kistiService (handles local seeding and Firestore data)
      const allLoans = await this.kistiService.getLoans();

      // Filter active loans for the selected center
      let activeLoans = allLoans.filter(l => 
        l.centerId === centerId && 
        (l.status === 'DISBURSED' || l.status === 'OVERDUE') && 
        !l.isDeleted
      );

      // Enforce role-based isolation on loans
      if (currentUser.role === 'FIELD_OFFICER') {
        activeLoans = activeLoans.filter(l => 
          l.fieldOfficerUserId === currentUser.userId || 
          (currentUser.assignedCenterIds && currentUser.assignedCenterIds.includes(l.centerId))
        );
      } else if (currentUser.role === 'BRANCH_MANAGER' || currentUser.role === 'CASHIER') {
        activeLoans = activeLoans.filter(l => l.branchId === currentUser.branchId);
      } else if (this.authService.isAreaScoped()) {
        activeLoans = activeLoans.filter(l => this.authService.canAccessBranch(l.branchId));
      }

      const items: DailySheetItem[] = [];

      for (const loan of activeLoans) {
        // Fetch installments for this loan
        let nextInst: InstallmentSchedule | null = null;
        let isLockedForWeek = false;
        let isCollectedToday = false;
        let daysRemainingForNext = 0;
        let nextEligibleDate = '';
        let nextPendingInstallmentNo: number | undefined;
        let lastPaidDateFormatted: string | undefined;

        try {
          const instRef = collection(this.firestore, 'installments');
          const instQ = query(instRef, where('loanId', '==', loan.loanId));
          const instSnap = await getDocs(instQ);
          const instList: InstallmentSchedule[] = [];
          instSnap.forEach(idoc => instList.push(idoc.data() as InstallmentSchedule));
          instList.sort((a, b) => a.installmentNo - b.installmentNo);

          if (instList.length > 0) {
            const paidList = instList.filter(i => i.status === 'PAID');
            const pendingList = instList.filter(i => i.status === 'PENDING');
            const pendingInst = pendingList.length > 0 ? pendingList[0] : null;

            if (pendingInst) {
              nextPendingInstallmentNo = pendingInst.installmentNo;
            }

            // Find latest paid installment
            let latestPaid: InstallmentSchedule | null = null;
            if (paidList.length > 0) {
              latestPaid = paidList.reduce((prev, curr) => {
                const prevTime = prev.paidDate ? new Date(prev.paidDate).getTime() : 0;
                const currTime = curr.paidDate ? new Date(curr.paidDate).getTime() : 0;
                if (currTime !== prevTime) {
                  return currTime > prevTime ? curr : prev;
                }
                return curr.installmentNo > prev.installmentNo ? curr : prev;
              });
            }

            // 7-day weekly lockout check
            if (latestPaid && latestPaid.paidDate) {
              const lastPaidTime = new Date(latestPaid.paidDate).getTime();
              const now = Date.now();
              const diffMs = now - lastPaidTime;
              const daysSinceLast = diffMs / (1000 * 60 * 60 * 24);

              if (daysSinceLast < 7) {
                // Collected within the last 7 days!
                isLockedForWeek = true;
                isCollectedToday = true;
                daysRemainingForNext = Math.max(1, Math.ceil(7 - daysSinceLast));
                const nextTime = lastPaidTime + 7 * 24 * 60 * 60 * 1000;
                nextEligibleDate = new Date(nextTime).toISOString().split('T')[0];
                lastPaidDateFormatted = new Date(latestPaid.paidDate).toLocaleDateString('bn-BD');

                // For the sheet row, display the collected installment for this week
                nextInst = latestPaid;
              }
            }

            if (!nextInst) {
              if (pendingInst) {
                nextInst = pendingInst;
                isCollectedToday = false;
                isLockedForWeek = false;
              } else {
                // All installments paid
                nextInst = instList[instList.length - 1];
                isCollectedToday = true;
                isLockedForWeek = true;
              }
            }
          }
        } catch (err) {
          console.error('Error loading installments for loan:', loan.loanId, err);
        }

        if (nextInst) {
          items.push({
            loan,
            nextInstallment: nextInst,
            isCollectedToday,
            isLockedForWeek,
            daysRemainingForNext,
            nextEligibleDate,
            nextPendingInstallmentNo,
            lastPaidDateFormatted
          });
        }
      }

      this.sheetItems.set(items);
    } catch (err) {
      console.error('Error loading daily sheet loans:', err);
    } finally {
      this.loading.set(false);
    }
  }

  onCenterChange(event: Event) {
    const val = Number((event.target as HTMLSelectElement).value);
    this.selectedCenterId.set(val);
    this.loadSheetData();
  }

  openCollectModal(item: DailySheetItem) {
    if (item.isLockedForWeek || item.isCollectedToday) {
      alert(`সতর্কতা: এই গ্রাহকের (${item.loan.customerName}) এই সপ্তাহের কিস্তি ইতিমধ্যে আদায় হয়েছে। নিয়ম অনুযায়ী ৭ দিন পর (${item.nextEligibleDate}) পরবর্তী কিস্তি গ্রহণ করা যাবে।`);
      return;
    }
    this.activeItemForCollect.set(item);
    this.collectAmount = item.nextInstallment.expectedPrincipal + item.nextInstallment.expectedProfit;
    this.collectSavings = item.nextInstallment.expectedSavings;
  }

  closeCollectModal() {
    this.activeItemForCollect.set(null);
  }

  async confirmCollection() {
    const item = this.activeItemForCollect();
    if (!item) return;

    this.isProcessing = true;
    const currentUser = this.authService.currentUser();
    const totalCollected = this.collectAmount + this.collectSavings;

    try {
      await this.kistiService.collectPayment(
        {
          loanId: item.loan.loanId,
          customerId: item.loan.customerId,
          customerName: item.loan.customerName,
          installmentId: item.nextInstallment.installmentId,
          installmentNo: item.nextInstallment.installmentNo,
          branchId: item.loan.branchId,
          centerId: item.loan.centerId,
          collectedByUserId: currentUser.userId,
          collectedByName: currentUser.name,
          principalAmountCollected: item.nextInstallment.expectedPrincipal,
          profitAmountCollected: item.nextInstallment.expectedProfit,
          savingsAmountCollected: this.collectSavings,
          fineAmountCollected: 0,
          totalAmountCollected: totalCollected,
          paymentMethod: this.collectMethod,
          collectionDate: new Date().toISOString()
        },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        `মাঠপর্যায়ে কিস্তি আদায় (সমিতি রুট ${this.selectedCenterId()})`
      );

      // Update installment status
      await this.kistiService.editRecord(
        'installments',
        item.nextInstallment.installmentId,
        {
          paidPrincipal: item.nextInstallment.expectedPrincipal,
          paidProfit: item.nextInstallment.expectedProfit,
          paidSavings: this.collectSavings,
          paidTotalAmount: totalCollected,
          status: 'PAID',
          paidDate: new Date().toISOString()
        },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        'মাঠপর্যায়ে কিস্তি আদায় সম্পন্ন'
      );

      this.closeCollectModal();
      await this.loadSheetData();
      alert(`সফল! ${item.loan.customerName}-এর কিস্তি ও সঞ্চয় সফলভাবে আদায় হয়েছে`);
    } catch (err) {
      console.error('Error collecting in daily sheet:', err);
      alert('কালেকশন সম্পন্ন করতে সমস্যা হয়েছে');
    } finally {
      this.isProcessing = false;
    }
  }

  getTotalExpectedToday(): number {
    return this.sheetItems().reduce((sum, item) => sum + (item.nextInstallment?.expectedTotalAmount || 0), 0);
  }

  getTotalCollectedToday(): number {
    return this.sheetItems()
      .filter(item => item.isCollectedToday)
      .reduce((sum, item) => sum + (item.nextInstallment?.paidTotalAmount || item.nextInstallment?.expectedTotalAmount || 0), 0);
  }
}
