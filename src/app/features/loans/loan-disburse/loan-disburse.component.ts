import { Component, inject, OnInit, signal, computed, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { Firestore } from '@angular/fire/firestore';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { Customer, LoanProduct, InstallmentFrequency, Branch, CenterOrSamity, UserStaff } from '../../../core/models/database.models';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

export interface DisbursementReceiptData {
  loanId: number;
  loanAccountNo: string;
  disbursementDate: string;
  customerName: string;
  customerId: number;
  customerPhone: string;
  customerNid: string;
  customerAddress: string;
  customerFatherOrSpouse: string;
  branchName: string;
  branchPhone: string;
  centerName: string;
  centerCode: string;
  fieldOfficerName: string;
  fieldOfficerPhone: string;
  approvedByName: string;
  approvedByRole: string;
  principalAmount: number;
  profitRate: number;
  profitType: 'FLAT' | 'ANNUAL';
  effectiveProfitRate: number;
  profitAmount: number;
  totalRepayable: number;
  totalInstallments: number;
  installmentFrequency: InstallmentFrequency;
  frequencyLabel: string;
  installmentAmount: number;
  savingsPerInstallment: number;
  totalCollectionPerCycle: number;
  firstInstallmentDueDate: string;
  expectedClosingDate: string;
  formFeePaid: number;
  purposeOfLoan: string;
}

@Component({
  selector: 'app-loan-disburse',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './loan-disburse.component.html',
  styleUrl: './loan-disburse.component.scss'
})
export class LoanDisburseComponent implements OnInit {
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  private router = inject(Router);
  private cdr = inject(ChangeDetectorRef);
  readonly authService = inject(AuthStateService);

  readonly customers = signal<Customer[]>([]);
  readonly products = signal<LoanProduct[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly staffList = signal<UserStaff[]>([]);

  readonly loading = signal<boolean>(true);
  readonly submitting = signal<boolean>(false);

  // Receipt Modal State
  readonly selectedReceiptForPrint = signal<DisbursementReceiptData | null>(null);

  // Form Signals - Fully reactive in zoneless Angular
  readonly selectedCustomerId = signal<number>(0);
  readonly selectedProductId = signal<number>(1);
  readonly principalAmount = signal<number>(20000);
  readonly totalInstallments = signal<number>(40);
  readonly profitRate = signal<number>(10.0); // Base profit/service charge rate
  readonly profitCalculationType = signal<'FLAT' | 'ANNUAL'>('FLAT');
  readonly installmentFrequency = signal<InstallmentFrequency>('WEEKLY');
  readonly savingsPerInstallment = signal<number>(50);
  readonly formFeePaid = signal<number>(200);
  readonly insuranceFeePaid = signal<number>(100);
  readonly firstInstallmentDueDate = signal<string>(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
  readonly purposeOfLoan = signal<string>('ব্যবসা সম্প্রসারণ ও মালামাল ক্রয়');
  readonly customLoanAccountNo = signal<string>('');
  readonly estimatedNextLoanId = signal<number>(20001);
  readonly isEditingReceiptLoanNo = signal<boolean>(false);
  readonly tempReceiptLoanNo = signal<string>('');

  // Live Reactive Computed Calculations
  readonly effectiveProfitRate = computed(() => {
    const rate = this.profitRate();
    if (this.profitCalculationType() === 'FLAT') {
      return Math.round(rate * 10) / 10;
    }

    // ANNUAL (বাৎসরিক লাভ) calculation:
    const installments = Math.max(1, this.totalInstallments());
    const freq = this.installmentFrequency();
    if (freq === 'DAILY') {
      return Math.round((rate * (installments / 365)) * 10) / 10;
    } else if (freq === 'MONTHLY') {
      return Math.round((rate * (installments / 12)) * 10) / 10;
    }
    // WEEKLY: 52 weeks in a year
    return Math.round((rate * (installments / 52)) * 10) / 10;
  });

  readonly profitAmount = computed(() => {
    return Math.round((this.principalAmount() * this.effectiveProfitRate()) / 100);
  });

  readonly totalRepayable = computed(() => {
    return this.principalAmount() + this.profitAmount();
  });

  readonly installmentAmount = computed(() => {
    const count = this.totalInstallments();
    if (!count || count <= 0) return 0;
    return Math.round(this.totalRepayable() / count);
  });

  readonly principalPerInstallment = computed(() => {
    const count = this.totalInstallments();
    if (!count || count <= 0) return 0;
    return Math.round(this.principalAmount() / count);
  });

  readonly profitPerInstallment = computed(() => {
    return Math.max(0, this.installmentAmount() - this.principalPerInstallment());
  });

  readonly totalCycleCollection = computed(() => {
    return this.installmentAmount() + (this.savingsPerInstallment() || 0);
  });

  readonly totalSavingsCollected = computed(() => {
    return (this.savingsPerInstallment() || 0) * (this.totalInstallments() || 0);
  });

  readonly expectedClosingDate = computed(() => {
    const firstDate = this.firstInstallmentDueDate();
    const count = Math.max(1, this.totalInstallments());
    if (!firstDate) return '';
    const start = new Date(firstDate);
    const freq = this.installmentFrequency();

    if (freq === 'DAILY') {
      start.setDate(start.getDate() + (count - 1));
    } else if (freq === 'MONTHLY') {
      start.setMonth(start.getMonth() + (count - 1));
    } else {
      start.setDate(start.getDate() + (count - 1) * 7);
    }
    return start.toISOString().split('T')[0];
  });

  readonly frequencyLabel = computed(() => {
    const freq = this.installmentFrequency();
    if (freq === 'DAILY') return 'দৈনিক কিস্তি';
    if (freq === 'MONTHLY') return 'মাসিক কিস্তি';
    return 'সাপ্তাহিক কিস্তি';
  });

  readonly frequencyNameBangla = computed(() => {
    const freq = this.installmentFrequency();
    if (freq === 'DAILY') return 'প্রতিদিন (Daily)';
    if (freq === 'MONTHLY') return 'প্রতি মাসে (Monthly)';
    return 'সপ্তাহে ১ দিন (Weekly)';
  });

  readonly frequencySavingsLabel = computed(() => {
    const freq = this.installmentFrequency();
    if (freq === 'DAILY') return 'দৈনিক সঞ্চয়';
    if (freq === 'MONTHLY') return 'মাসিক সঞ্চয়';
    return 'সাপ্তাহিক সঞ্চয়';
  });

  readonly frequencyCollectionLabel = computed(() => {
    const freq = this.installmentFrequency();
    if (freq === 'DAILY') return 'প্রতিদিন মোট আদায় হবে';
    if (freq === 'MONTHLY') return 'মাসে মোট আদায় হবে';
    return 'সপ্তাহে মোট আদায় হবে';
  });

  async ngOnInit() {
    await this.loadInitialData();
  }

  async loadInitialData() {
    this.loading.set(true);
    try {
      const [custList, prodList, branchList, centerList, staffList, nextId] = await Promise.all([
        this.kistiService.getCustomers(),
        this.kistiService.getLoanProducts(),
        this.kistiService.getBranches(),
        this.kistiService.getCenters(),
        this.kistiService.getStaff(),
        this.kistiService.peekNextLoanId()
      ]);

      this.customers.set(custList);
      this.products.set(prodList);
      this.branches.set(branchList);
      this.centers.set(centerList);
      this.staffList.set(staffList);
      this.estimatedNextLoanId.set(nextId);

      if (custList.length > 0) {
        this.selectedCustomerId.set(custList[0].customerId);
      }
      if (prodList.length > 0) {
        this.selectedProductId.set(prodList[0].productId);
      }
    } catch (err) {
      console.error('Error loading data from database:', err);
    } finally {
      this.loading.set(false);
      this.cdr.markForCheck();
    }
  }

  setFrequency(freq: InstallmentFrequency) {
    this.installmentFrequency.set(freq);
    const now = Date.now();
    if (freq === 'DAILY') {
      const dailyProd = this.products().find(p => p.frequency === 'DAILY');
      this.selectedProductId.set(dailyProd ? dailyProd.productId : 2);
      this.totalInstallments.set(100);
      this.profitRate.set(12.0);
      this.savingsPerInstallment.set(20);
      this.firstInstallmentDueDate.set(new Date(now + 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
    } else if (freq === 'MONTHLY') {
      const monthlyProd = this.products().find(p => p.frequency === 'MONTHLY');
      this.selectedProductId.set(monthlyProd ? monthlyProd.productId : 3);
      this.totalInstallments.set(12);
      this.profitRate.set(12.0);
      this.savingsPerInstallment.set(200);
      this.firstInstallmentDueDate.set(new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
    } else {
      this.installmentFrequency.set('WEEKLY');
      const weeklyProd = this.products().find(p => p.frequency === 'WEEKLY');
      this.selectedProductId.set(weeklyProd ? weeklyProd.productId : 1);
      this.totalInstallments.set(40);
      this.profitRate.set(10.0);
      this.savingsPerInstallment.set(50);
      this.firstInstallmentDueDate.set(new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);
    }
    this.cdr.markForCheck();
  }

  setInstallments(val: any) {
    const count = Math.max(1, Number(val) || 1);
    this.totalInstallments.set(count);
    this.cdr.markForCheck();
  }

  setPrincipal(val: any) {
    const amount = Math.max(0, Number(val) || 0);
    this.principalAmount.set(amount);
    this.cdr.markForCheck();
  }

  setProfitRate(val: any) {
    const rate = Math.max(0, Number(val) || 0);
    this.profitRate.set(rate);
    this.cdr.markForCheck();
  }

  setProfitType(type: 'FLAT' | 'ANNUAL') {
    this.profitCalculationType.set(type);
    this.cdr.markForCheck();
  }

  setSavings(val: any) {
    const savings = Math.max(0, Number(val) || 0);
    this.savingsPerInstallment.set(savings);
    this.cdr.markForCheck();
  }

  // Getters for template compatibility
  getEffectiveProfitRate(): number { return this.effectiveProfitRate(); }
  calculateProfitAmount(): number { return this.profitAmount(); }
  calculateTotalRepayable(): number { return this.totalRepayable(); }
  calculateWeeklyInstallment(): number { return this.installmentAmount(); }
  calculatePrincipalPerInstallment(): number { return this.principalPerInstallment(); }
  calculateProfitPerInstallment(): number { return this.profitPerInstallment(); }
  calculateTotalWeeklyCollection(): number { return this.totalCycleCollection(); }
  calculateExpectedClosingDate(): string { return this.expectedClosingDate(); }
  getFrequencyLabel(): string { return this.frequencyLabel(); }
  getFrequencyNameBangla(): string { return this.frequencyNameBangla(); }
  getFrequencySavingsLabel(): string { return this.frequencySavingsLabel(); }
  getFrequencyCollectionLabel(): string { return this.frequencyCollectionLabel(); }

  getSelectedCustomer(): Customer | undefined {
    return this.customers().find(c => c.customerId === Number(this.selectedCustomerId()));
  }

  getCustomerBranch(cust: Customer): Branch | undefined {
    return this.branches().find(b => b.branchId === cust.branchId);
  }

  getCustomerCenter(cust: Customer): CenterOrSamity | undefined {
    return this.centers().find(c => c.centerId === cust.centerId);
  }

  getCustomerFieldOfficer(cust: Customer): UserStaff | undefined {
    return this.staffList().find(s => s.userId === cust.assignedFieldOfficerId);
  }

  // Preview receipt without disbursing
  previewReceipt() {
    const cust = this.getSelectedCustomer();
    if (!cust) {
      alert('অনুগ্রহ করে আগে গ্রাহক নির্বাচন করুন');
      return;
    }
    const branch = this.getCustomerBranch(cust);
    const center = this.getCustomerCenter(cust);
    const fo = this.getCustomerFieldOfficer(cust);
    const currentUser = this.authService.currentUser();
    const now = new Date().toISOString().split('T')[0];

    const custom = this.customLoanAccountNo().trim();
    const previewLoanNo = custom
      ? (custom.toUpperCase().startsWith('LN-') ? custom.toUpperCase() : `LN-${custom}`)
      : `LN-${this.estimatedNextLoanId()} (খসড়া)`;

    const receipt: DisbursementReceiptData = {
      loanId: 0,
      loanAccountNo: previewLoanNo,
      disbursementDate: now,
      customerName: cust.fullName,
      customerId: cust.customerId,
      customerPhone: cust.phonePrimary,
      customerNid: cust.nidNumber,
      customerAddress: `${cust.presentAddress?.villageOrStreet || ''}, ${cust.presentAddress?.thanaOrUpazila || ''}, ${cust.presentAddress?.district || ''}`.replace(/^,\s*|,\s*$/g, ''),
      customerFatherOrSpouse: cust.spouseName || cust.fatherName || 'N/A',
      branchName: branch?.name || 'প্রধান শাখা',
      branchPhone: branch?.phone || '',
      centerName: center?.name || 'সাধারণ কেন্দ্র',
      centerCode: center?.centerCode || '',
      fieldOfficerName: fo?.name || 'দায়িত্বপ্রাপ্ত মাঠ কর্মকর্তা',
      fieldOfficerPhone: fo?.phone || '',
      approvedByName: currentUser.name,
      approvedByRole: currentUser.role,
      principalAmount: this.principalAmount(),
      profitRate: this.profitRate(),
      profitType: this.profitCalculationType(),
      effectiveProfitRate: this.effectiveProfitRate(),
      profitAmount: this.profitAmount(),
      totalRepayable: this.totalRepayable(),
      totalInstallments: this.totalInstallments(),
      installmentFrequency: this.installmentFrequency(),
      frequencyLabel: this.frequencyLabel(),
      installmentAmount: this.installmentAmount(),
      savingsPerInstallment: this.savingsPerInstallment(),
      totalCollectionPerCycle: this.totalCycleCollection(),
      firstInstallmentDueDate: this.firstInstallmentDueDate(),
      expectedClosingDate: this.expectedClosingDate(),
      formFeePaid: this.formFeePaid(),
      purposeOfLoan: this.purposeOfLoan()
    };

    this.selectedReceiptForPrint.set(receipt);
    this.cdr.markForCheck();
  }

  printReceipt() {
    window.print();
  }

  closeReceipt() {
    const receipt = this.selectedReceiptForPrint();
    this.selectedReceiptForPrint.set(null);
    this.isEditingReceiptLoanNo.set(false);
    if (receipt && receipt.loanId > 0) {
      this.router.navigate(['/loans/detail', receipt.loanId]);
    }
    this.cdr.markForCheck();
  }

  viewLoanDetails() {
    const receipt = this.selectedReceiptForPrint();
    if (receipt && receipt.loanId > 0) {
      this.selectedReceiptForPrint.set(null);
      this.isEditingReceiptLoanNo.set(false);
      this.router.navigate(['/loans/detail', receipt.loanId]);
    } else {
      this.selectedReceiptForPrint.set(null);
      this.isEditingReceiptLoanNo.set(false);
    }
  }

  startEditReceiptLoanNo() {
    const cur = this.selectedReceiptForPrint();
    if (cur) {
      this.tempReceiptLoanNo.set(cur.loanAccountNo);
      this.isEditingReceiptLoanNo.set(true);
      this.cdr.markForCheck();
    }
  }

  cancelEditReceiptLoanNo() {
    this.isEditingReceiptLoanNo.set(false);
    this.cdr.markForCheck();
  }

  async saveReceiptLoanNo() {
    const cur = this.selectedReceiptForPrint();
    const newNo = this.tempReceiptLoanNo().trim();
    if (!cur || !newNo) return;

    let finalNo = newNo.toUpperCase().startsWith('LN-') ? newNo.toUpperCase() : `LN-${newNo}`;

    if (cur.loanId > 0) {
      try {
        finalNo = await this.kistiService.updateLoanAccountNo(cur.loanId, finalNo);
      } catch (err) {
        console.error('Failed to update loan account no in database:', err);
      }
    }

    this.selectedReceiptForPrint.set({
      ...cur,
      loanAccountNo: finalNo
    });
    this.isEditingReceiptLoanNo.set(false);
    this.cdr.markForCheck();
  }

  async onDisburse() {
    const cust = this.getSelectedCustomer();
    if (!cust) {
      alert('অনুগ্রহ করে গ্রাহক নির্বাচন করুন');
      return;
    }

    if (this.principalAmount() <= 0) {
      alert('সঠিক ঋণের পরিমাণ দিন');
      return;
    }

    if (this.totalInstallments() <= 0) {
      alert('সঠিক কিস্তির সংখ্যা দিন');
      return;
    }

    this.submitting.set(true);
    const currentUser = this.authService.currentUser();
    const now = new Date().toISOString().split('T')[0];

    try {
      const branch = this.getCustomerBranch(cust);
      const center = this.getCustomerCenter(cust);
      const fo = this.getCustomerFieldOfficer(cust);

      const result = await this.kistiService.disburseLoan(
        {
          customerId: cust.customerId,
          customerName: cust.fullName,
          branchId: cust.branchId,
          centerId: cust.centerId,
          fieldOfficerUserId: cust.assignedFieldOfficerId,
          productId: Number(this.selectedProductId()),
          principalAmount: this.principalAmount(),
          interestOrServiceCharge: this.profitAmount(),
          totalRepayableAmount: this.totalRepayable(),
          installmentFrequency: this.installmentFrequency(),
          totalInstallments: this.totalInstallments(),
          installmentAmount: this.installmentAmount(),
          savingsPerInstallment: this.savingsPerInstallment(),
          formFeePaid: this.formFeePaid(),
          insuranceFeePaid: this.insuranceFeePaid(),
          totalPaidAmount: 0,
          totalPrincipalPaid: 0,
          totalProfitPaid: 0,
          totalSavingsCollected: 0,
          outstandingBalance: this.totalRepayable(),
          paidInstallmentsCount: 0,
          remainingInstallmentsCount: this.totalInstallments(),
          overdueAmount: 0,
          missedInstallmentsCount: 0,
          applicationDate: now,
          approvedDate: now,
          approvedByUserId: currentUser.userId,
          disbursementDate: now,
          firstInstallmentDueDate: this.firstInstallmentDueDate(),
          expectedClosingDate: this.expectedClosingDate(),
          purposeOfLoan: this.purposeOfLoan(),
          status: 'DISBURSED'
        },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        `নতুন ঋণ বিতরণ: ৳${this.principalAmount()} (${this.totalInstallments()} কিস্তি - ${this.installmentFrequency()})`,
        this.customLoanAccountNo()
      );

      // Construct Complete Disbursement Sanction & Money Receipt Data
      const receipt: DisbursementReceiptData = {
        loanId: result.loan.loanId,
        loanAccountNo: result.loan.loanAccountNo,
        disbursementDate: result.loan.disbursementDate,
        customerName: cust.fullName,
        customerId: cust.customerId,
        customerPhone: cust.phonePrimary,
        customerNid: cust.nidNumber,
        customerAddress: `${cust.presentAddress?.villageOrStreet || ''}, ${cust.presentAddress?.thanaOrUpazila || ''}, ${cust.presentAddress?.district || ''}`.replace(/^,\s*|,\s*$/g, ''),
        customerFatherOrSpouse: cust.spouseName || cust.fatherName || 'N/A',
        branchName: branch?.name || 'প্রধান শাখা',
        branchPhone: branch?.phone || '',
        centerName: center?.name || 'সাধারণ কেন্দ্র',
        centerCode: center?.centerCode || '',
        fieldOfficerName: fo?.name || 'দায়িত্বপ্রাপ্ত মাঠ কর্মকর্তা',
        fieldOfficerPhone: fo?.phone || '',
        approvedByName: currentUser.name,
        approvedByRole: currentUser.role,
        principalAmount: this.principalAmount(),
        profitRate: this.profitRate(),
        profitType: this.profitCalculationType(),
        effectiveProfitRate: this.effectiveProfitRate(),
        profitAmount: this.profitAmount(),
        totalRepayable: this.totalRepayable(),
        totalInstallments: this.totalInstallments(),
        installmentFrequency: this.installmentFrequency(),
        frequencyLabel: this.frequencyLabel(),
        installmentAmount: this.installmentAmount(),
        savingsPerInstallment: this.savingsPerInstallment(),
        totalCollectionPerCycle: this.totalCycleCollection(),
        firstInstallmentDueDate: this.firstInstallmentDueDate(),
        expectedClosingDate: this.expectedClosingDate(),
        formFeePaid: this.formFeePaid(),
        purposeOfLoan: this.purposeOfLoan()
      };

      // Open the printable receipt modal immediately upon saving loan!
      this.selectedReceiptForPrint.set(receipt);
      this.cdr.markForCheck();
    } catch (err) {
      console.error('Disbursement error:', err);
      alert('ঋণ বিতরণে সমস্যা হয়েছে');
    } finally {
      this.submitting.set(false);
      this.cdr.markForCheck();
    }
  }
}
