import { Component, inject, OnInit, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LoanEligibility, LoanLifecycleService } from '../../../core/services/loan-lifecycle.service';
import { SettingsService } from '../../../core/services/settings.service';
import { Customer, LoanProduct, InstallmentFrequency, Branch, CenterOrSamity, UserStaff, Loan } from '../../../core/models/database.models';
import { EMPTY_CALENDAR, LoanSchedule, WorkingCalendar, buildSchedule } from '../../../core/finance/schedule';
import { formatBnDate, todayDhaka, weekdayBn } from '../../../core/finance/dates';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';
import { ToastService } from '../../../core/services/toast.service';

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
  profitType: 'FLAT' | 'ANNUAL' | 'DECLINING';
  effectiveProfitRate: number;
  effectiveAnnualRate: number;
  profitAmount: number;
  totalRepayable: number;
  totalInstallments: number;
  installmentFrequency: InstallmentFrequency;
  frequencyLabel: string;
  installmentAmount: number;
  lastInstallmentAmount: number;
  savingsPerInstallment: number;
  totalCollectionPerCycle: number;
  firstInstallmentDueDate: string;
  expectedClosingDate: string;
  formFeePaid: number;
  insuranceFeePaid: number;
  purposeOfLoan: string;
  loanCycle: number;
  /** "বৃহস্পতিবার, ৫ নভেম্বর, ২০২৬" */
  firstInstallmentDayLabel: string;
  /** "প্রতি বৃহস্পতিবার (শাপলা মহিলা সমিতির মিটিং)" */
  scheduleDayLabel: string;
  centerMeetingInfo: string;
}

/**
 * দুই ধাপের পেজ:
 *  - আবেদন (ডিফল্ট): মাঠকর্মী/BM ঋণ আবেদন জমা দেন → অনুমোদন প্রবাহে যায়
 *  - বিতরণ (?loanId=): অনুমোদিত ঋণ ক্যাশিয়ার/BM বিতরণ করেন → কিস্তি শিডিউল, ভল্ট, ভাউচার
 */
@Component({
  selector: 'app-loan-disburse',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './loan-disburse.component.html',
  styleUrl: './loan-disburse.component.scss'
})
export class LoanDisburseComponent implements OnInit {
  /** প্রতিষ্ঠানের নাম/ঠিকানা (সেটিংস → প্রতিষ্ঠান) */
  readonly org = inject(SettingsService).org;
  private kistiService = inject(KistiDatabaseService);
  private lifecycle = inject(LoanLifecycleService);
  private settings = inject(SettingsService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);
  private toast = inject(ToastService);

  readonly customers = signal<Customer[]>([]);
  readonly products = signal<LoanProduct[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly staffList = signal<UserStaff[]>([]);

  readonly loading = signal<boolean>(true);
  readonly submitting = signal<boolean>(false);
  readonly errorMessage = signal<string>('');
  readonly successMessage = signal<string>('');

  // আবেদন বনাম বিতরণ
  readonly mode = signal<'APPLY' | 'DISBURSE'>('APPLY');
  readonly approvedLoan = signal<Loan | null>(null);

  // Receipt Modal State
  readonly selectedReceiptForPrint = signal<DisbursementReceiptData | null>(null);

  // Form Signals
  readonly selectedCustomerId = signal<number>(0);
  readonly selectedProductId = signal<number>(1);
  readonly principalAmount = signal<number>(20000);
  readonly totalInstallments = signal<number>(40);
  readonly profitRate = signal<number>(10.0);
  /** FLAT: মেয়াদের মোট %, ANNUAL: বার্ষিক ফ্ল্যাট % মেয়াদে রূপান্তর, DECLINING: বার্ষিক হ্রাসমান % */
  readonly profitCalculationType = signal<'FLAT' | 'ANNUAL' | 'DECLINING'>('FLAT');
  readonly installmentFrequency = signal<InstallmentFrequency>('WEEKLY');
  readonly savingsPerInstallment = signal<number>(50);
  readonly formFeePaid = signal<number>(200);
  readonly insuranceFeePaid = signal<number>(100);
  readonly firstInstallmentDueDate = signal<string>('');
  readonly purposeOfLoan = signal<string>('ব্যবসা সম্প্রসারণ ও মালামাল ক্রয়');
  readonly customLoanAccountNo = signal<string>('');
  readonly estimatedNextLoanId = signal<number>(20001);
  readonly isEditingReceiptLoanNo = signal<boolean>(false);
  readonly tempReceiptLoanNo = signal<string>('');

  readonly calendar = signal<WorkingCalendar>(EMPTY_CALENDAR);
  readonly today = signal<string>(todayDhaka());
  readonly eligibility = signal<LoanEligibility | null>(null);
  readonly checkingEligibility = signal<boolean>(false);

  readonly selectedProduct = computed(() => this.products().find(p => p.productId === Number(this.selectedProductId())));
  readonly selectedCustomer = computed(() => this.customers().find(c => c.customerId === Number(this.selectedCustomerId())));
  readonly selectedCenter = computed(() => {
    const cust = this.selectedCustomer();
    return cust ? this.centers().find(c => c.centerId === cust.centerId) : undefined;
  });

  /** প্রথম কিস্তি — বার ও তারিখসহ (ছুটি বাদ দেওয়ার পরের প্রকৃত তারিখ) */
  readonly firstDueLabel = computed(() => formatBnDate(this.schedule()?.rows[0]?.dueDate || this.firstInstallmentDueDate()));
  readonly closingLabel = computed(() => formatBnDate(this.expectedClosingDate()));

  /** কিস্তি কোন বারে / কবে আদায় হবে */
  readonly scheduleDayLabel = computed(() => {
    const first = this.schedule()?.rows[0]?.dueDate || this.firstInstallmentDueDate();
    const freq = this.installmentFrequency();
    if (!first) return '';
    if (freq === 'DAILY') return 'প্রতি কর্মদিবস (সাপ্তাহিক ও সরকারি ছুটি বাদে)';
    if (freq === 'MONTHLY') return `প্রতি মাসের ${new Intl.NumberFormat('bn-BD').format(Number(first.slice(8, 10)))} তারিখ`;
    return `প্রতি ${weekdayBn(first)}`;
  });

  /** সাপ্তাহিক ঋণে প্রথম কিস্তি সমিতির মিটিং-বারে না পড়লে সতর্কতা */
  readonly meetingDayMismatch = computed(() => {
    const center = this.selectedCenter();
    const first = this.firstInstallmentDueDate();
    if (!center || !first || this.installmentFrequency() !== 'WEEKLY' || center.meetingDay === 'Daily') return '';
    const aligned = this.lifecycle.alignToMeetingDay(first, 'WEEKLY', center.meetingDay);
    return aligned !== first ? `সমিতির মিটিং ${weekdayBn(aligned)} — প্রথম কিস্তি ${formatBnDate(aligned)} করুন?` : '';
  });

  alignFirstDueToMeeting() {
    const center = this.selectedCenter();
    if (center) this.firstInstallmentDueDate.set(this.lifecycle.alignToMeetingDay(this.firstInstallmentDueDate(), 'WEEKLY', center.meetingDay));
  }

  /** মেয়াদের মোট ফ্ল্যাট % (FLAT ও ANNUAL); হ্রাসমানে বার্ষিক হার */
  readonly effectiveProfitRate = computed(() => {
    const rate = this.profitRate();
    const type = this.profitCalculationType();
    if (type === 'FLAT' || type === 'DECLINING') return Math.round(rate * 100) / 100;
    const installments = Math.max(1, this.totalInstallments());
    const freq = this.installmentFrequency();
    const perYear = freq === 'DAILY' ? 365 : freq === 'MONTHLY' ? 12 : 52;
    return Math.round(rate * (installments / perYear) * 100) / 100;
  });

  /** পূর্ণ শিডিউল — ছুটির ক্যালেন্ডার ও শেষ কিস্তির রাউন্ডিং সমন্বয়সহ */
  readonly schedule = computed<LoanSchedule | null>(() => {
    if (!this.firstInstallmentDueDate() || this.principalAmount() <= 0 || this.totalInstallments() <= 0) return null;
    return buildSchedule({
      principal: this.principalAmount(),
      ratePercent: this.effectiveProfitRate(),
      method: this.profitCalculationType() === 'DECLINING' ? 'DECLINING' : 'FLAT',
      count: this.totalInstallments(),
      frequency: this.installmentFrequency(),
      firstDueDate: this.firstInstallmentDueDate(),
      calendar: this.calendar()
    });
  });

  readonly profitAmount = computed(() => this.schedule()?.totalProfit || 0);
  readonly totalRepayable = computed(() => this.schedule()?.totalRepayable || this.principalAmount());
  readonly installmentAmount = computed(() => this.schedule()?.installmentAmount || 0);
  readonly lastInstallmentAmount = computed(() => this.schedule()?.lastInstallmentAmount || 0);
  readonly effectiveAnnualRate = computed(() => this.schedule()?.effectiveAnnualRate || 0);
  readonly principalPerInstallment = computed(() => this.schedule()?.rows[0]?.principal || 0);
  readonly profitPerInstallment = computed(() => this.schedule()?.rows[0]?.profit || 0);
  readonly totalCycleCollection = computed(() => this.installmentAmount() + (this.savingsPerInstallment() || 0));
  readonly totalSavingsCollected = computed(() => (this.savingsPerInstallment() || 0) * (this.totalInstallments() || 0));
  readonly expectedClosingDate = computed(() => this.schedule()?.expectedClosingDate || '');

  readonly frequencyLabel = computed(() => {
    const freq = this.installmentFrequency();
    if (freq === 'DAILY') return 'দৈনিক কিস্তি';
    if (freq === 'MONTHLY') return 'মাসিক কিস্তি';
    return 'সাপ্তাহিক কিস্তি';
  });

  readonly frequencyNameBangla = computed(() => {
    const freq = this.installmentFrequency();
    if (freq === 'DAILY') return 'প্রতি কর্মদিবস (Daily)';
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

  readonly profitTypeLabel = computed(() => {
    const t = this.profitCalculationType();
    return t === 'FLAT' ? 'ফ্ল্যাট' : t === 'ANNUAL' ? 'বাৎসরিক ফ্ল্যাট' : 'বার্ষিক হ্রাসমান';
  });

  constructor() {
    // গ্রাহক বা প্রোডাক্ট বদলালে যোগ্যতা ও শাখার ছুটির ক্যালেন্ডার নতুন করে আনা
    effect(() => {
      const customer = this.selectedCustomer();
      const product = this.selectedProduct();
      if (!customer || this.mode() !== 'APPLY') return;
      void this.refreshEligibility(customer, product);
    });
  }

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

      // শুধু নিজের শাখার সক্রিয় সদস্য
      this.customers.set(custList.filter(c => c.status !== 'CLOSED' && this.authService.canAccessBranch(c.branchId)));
      this.products.set(prodList.filter(p => p.isActive !== false));
      this.branches.set(branchList);
      this.centers.set(centerList);
      this.staffList.set(staffList);
      this.estimatedNextLoanId.set(nextId);

      const loanIdParam = Number(this.route.snapshot.queryParamMap.get('loanId'));
      if (loanIdParam) {
        await this.loadApprovedLoan(loanIdParam);
      } else {
        if (this.customers().length > 0) this.selectedCustomerId.set(this.customers()[0].customerId);
        const weekly = this.products().find(p => p.frequency === 'WEEKLY') || this.products()[0];
        if (weekly) this.applyProduct(weekly);
        else this.firstInstallmentDueDate.set(this.lifecycle.defaultFirstDueDate(undefined, 'WEEKLY'));
      }
    } catch (err) {
      console.error('Error loading data from database:', err);
      this.errorMessage.set('ডেটা লোড করা যায়নি। আবার চেষ্টা করুন।');
    } finally {
      this.loading.set(false);
    }
  }

  /** অনুমোদিত ঋণ বিতরণ মোড — শর্তাবলি আবেদন থেকে, শুধু তারিখ ও হিসাব নং পরিবর্তনযোগ্য */
  private async loadApprovedLoan(loanId: number) {
    const loan = (await this.kistiService.getLoans()).find(l => l.loanId === loanId);
    if (!loan) throw new Error('ঋণ পাওয়া যায়নি');
    this.mode.set('DISBURSE');
    this.approvedLoan.set(loan);
    if (!this.customers().some(c => c.customerId === loan.customerId)) {
      const all = await this.kistiService.getCustomers();
      const cust = all.find(c => c.customerId === loan.customerId);
      if (cust) this.customers.update(list => [...list, cust]);
    }
    this.selectedCustomerId.set(loan.customerId);
    this.selectedProductId.set(loan.productId);
    this.principalAmount.set(loan.principalAmount);
    this.totalInstallments.set(loan.totalInstallments);
    this.installmentFrequency.set(loan.installmentFrequency);
    this.profitCalculationType.set(loan.interestMethod === 'DECLINING' ? 'DECLINING' : 'FLAT');
    this.profitRate.set(loan.ratePercent ?? Math.round((loan.interestOrServiceCharge / loan.principalAmount) * 10000) / 100);
    this.savingsPerInstallment.set(loan.savingsPerInstallment);
    this.formFeePaid.set(loan.formFeePaid || 0);
    this.insuranceFeePaid.set(loan.insuranceFeePaid || 0);
    this.purposeOfLoan.set(loan.purposeOfLoan);
    const today = todayDhaka();
    this.firstInstallmentDueDate.set(loan.firstInstallmentDueDate > today
      ? loan.firstInstallmentDueDate
      : this.lifecycle.defaultFirstDueDate(this.selectedProduct(), loan.installmentFrequency, today, this.centers().find(c => c.centerId === loan.centerId)?.meetingDay));
    this.calendar.set(await this.settings.getCalendar(loan.branchId));
    if (loan.status !== 'APPROVED') {
      this.errorMessage.set(`এই ঋণটি "${loan.status}" অবস্থায় আছে — শুধু অনুমোদিত ঋণ বিতরণ করা যায়।`);
    }
  }

  private async refreshEligibility(customer: Customer, product: LoanProduct | undefined) {
    this.checkingEligibility.set(true);
    try {
      const [elig, cal] = await Promise.all([
        this.lifecycle.checkEligibility(customer, product, this.authService.currentUser()),
        this.settings.getCalendar(customer.branchId)
      ]);
      this.eligibility.set(elig);
      this.calendar.set(cal);
      // গ্রাহক বদলালে তার সমিতির মিটিং-বার অনুযায়ী প্রথম কিস্তির তারিখ
      this.firstInstallmentDueDate.set(this.lifecycle.defaultFirstDueDate(product, this.installmentFrequency(), undefined, this.selectedCenter()?.meetingDay));
    } catch (err) {
      console.error('Eligibility check failed:', err);
    } finally {
      this.checkingEligibility.set(false);
    }
  }

  /** প্রোডাক্ট নির্বাচনে নীতি অনুযায়ী ডিফল্ট মান */
  applyProduct(product: LoanProduct) {
    this.selectedProductId.set(product.productId);
    this.installmentFrequency.set(product.frequency);
    this.totalInstallments.set(product.defaultInstallmentsCount);
    this.profitRate.set(product.interestOrServiceChargeRate);
    this.profitCalculationType.set(product.interestMethod === 'DECLINING' ? 'DECLINING' : 'FLAT');
    this.savingsPerInstallment.set(product.mandatorySavingsPerInstallment);
    this.formFeePaid.set(product.formAndProcessingFee || 0);
    this.insuranceFeePaid.set(product.insuranceFee || 0);
    this.firstInstallmentDueDate.set(this.lifecycle.defaultFirstDueDate(product, product.frequency, undefined, this.selectedCenter()?.meetingDay));
  }

  onProductChange(productId: number | string) {
    const product = this.products().find(p => p.productId === Number(productId));
    if (product) this.applyProduct(product);
  }

  setFrequency(freq: InstallmentFrequency) {
    const product = this.products().find(p => p.frequency === freq);
    if (product) {
      this.applyProduct(product);
      return;
    }
    this.installmentFrequency.set(freq);
    this.totalInstallments.set(freq === 'DAILY' ? 100 : freq === 'MONTHLY' ? 12 : 40);
    this.firstInstallmentDueDate.set(this.lifecycle.defaultFirstDueDate(undefined, freq, undefined, this.selectedCenter()?.meetingDay));
  }

  setInstallments(val: any) {
    this.totalInstallments.set(Math.max(1, Math.min(450, Number(val) || 1)));
  }

  setPrincipal(val: any) {
    this.principalAmount.set(Math.max(0, Number(val) || 0));
  }

  setProfitRate(val: any) {
    this.profitRate.set(Math.max(0, Number(val) || 0));
  }

  setProfitType(type: 'FLAT' | 'ANNUAL' | 'DECLINING') {
    this.profitCalculationType.set(type);
  }

  setSavings(val: any) {
    this.savingsPerInstallment.set(Math.max(0, Number(val) || 0));
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

  private buildReceipt(cust: Customer, loanId: number, loanAccountNo: string, disbursementDate: string, approver: { name: string; role: string }): DisbursementReceiptData {
    const branch = this.getCustomerBranch(cust);
    const center = this.getCustomerCenter(cust);
    const fo = this.getCustomerFieldOfficer(cust);
    return {
      loanId,
      loanAccountNo,
      disbursementDate,
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
      approvedByName: approver.name,
      approvedByRole: approver.role,
      principalAmount: this.principalAmount(),
      profitRate: this.profitRate(),
      profitType: this.profitCalculationType(),
      effectiveProfitRate: this.effectiveProfitRate(),
      effectiveAnnualRate: this.effectiveAnnualRate(),
      profitAmount: this.profitAmount(),
      totalRepayable: this.totalRepayable(),
      totalInstallments: this.totalInstallments(),
      installmentFrequency: this.installmentFrequency(),
      frequencyLabel: this.frequencyLabel(),
      installmentAmount: this.installmentAmount(),
      lastInstallmentAmount: this.lastInstallmentAmount(),
      savingsPerInstallment: this.savingsPerInstallment(),
      totalCollectionPerCycle: this.totalCycleCollection(),
      firstInstallmentDueDate: this.schedule()?.rows[0]?.dueDate || this.firstInstallmentDueDate(),
      expectedClosingDate: this.expectedClosingDate(),
      formFeePaid: this.formFeePaid(),
      insuranceFeePaid: this.insuranceFeePaid(),
      purposeOfLoan: this.purposeOfLoan(),
      loanCycle: this.approvedLoan()?.loanCycle || this.eligibility()?.loanCycle || 1,
      firstInstallmentDayLabel: this.firstDueLabel(),
      scheduleDayLabel: this.scheduleDayLabel(),
      centerMeetingInfo: center ? `${center.name} — মিটিং: ${center.meetingDay === 'Daily' ? 'প্রতিদিন' : weekdayBn(this.lifecycle.alignToMeetingDay(this.today(), 'WEEKLY', center.meetingDay))} ${center.meetingTime || ''}` : ''
    };
  }

  // Preview receipt without saving
  previewReceipt() {
    const cust = this.selectedCustomer();
    if (!cust) {
      this.errorMessage.set('অনুগ্রহ করে আগে গ্রাহক নির্বাচন করুন');
      return;
    }
    const custom = this.customLoanAccountNo().trim();
    const loanNo = this.approvedLoan()
      ? (custom ? (custom.toUpperCase().startsWith('LN-') ? custom.toUpperCase() : `LN-${custom}`) : this.approvedLoan()!.loanAccountNo) + ' (খসড়া)'
      : `LN-${this.estimatedNextLoanId()} (খসড়া)`;
    const user = this.authService.currentUser();
    this.selectedReceiptForPrint.set(this.buildReceipt(cust, 0, loanNo, todayDhaka(), { name: this.approvedLoan()?.approvedByName || user.name, role: user.role }));
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
  }

  viewLoanDetails() {
    this.closeReceipt();
  }

  startEditReceiptLoanNo() {
    const cur = this.selectedReceiptForPrint();
    if (cur) {
      this.tempReceiptLoanNo.set(cur.loanAccountNo);
      this.isEditingReceiptLoanNo.set(true);
    }
  }

  cancelEditReceiptLoanNo() {
    this.isEditingReceiptLoanNo.set(false);
  }

  async saveReceiptLoanNo() {
    const cur = this.selectedReceiptForPrint();
    const newNo = this.tempReceiptLoanNo().trim();
    if (!cur || !newNo) return;
    let finalNo = newNo.toUpperCase().startsWith('LN-') ? newNo.toUpperCase() : `LN-${newNo}`;
    if (cur.loanId > 0) {
      try {
        const user = this.authService.currentUser();
        finalNo = await this.kistiService.updateLoanAccountNo(cur.loanId, finalNo, { userId: user.userId, name: user.name, role: user.role });
      } catch (err: any) {
        this.errorMessage.set(err?.message || 'ঋণ হিসাব নং পরিবর্তন করা যায়নি');
        return;
      }
    }
    this.selectedReceiptForPrint.set({ ...cur, loanAccountNo: finalNo });
    this.isEditingReceiptLoanNo.set(false);
  }

  async onSubmit() {
    this.errorMessage.set('');
    this.successMessage.set('');
    const cust = this.selectedCustomer();
    if (!cust) {
      this.errorMessage.set('অনুগ্রহ করে গ্রাহক নির্বাচন করুন');
      return;
    }
    const user = this.authService.currentUser();
    const actor = { userId: user.userId, name: user.name, role: user.role, category: user.category };
    this.submitting.set(true);
    try {
      if (this.mode() === 'DISBURSE') {
        const loan = this.approvedLoan()!;
        const result = await this.lifecycle.disburse(loan.loanId, {
          firstDueDate: this.firstInstallmentDueDate(),
          customLoanAccountNo: this.customLoanAccountNo()
        }, actor);
        this.approvedLoan.set(result.loan);
        this.toast.success(`ঋণ ${result.loan.loanAccountNo} সফলভাবে বিতরণ হয়েছে — ৳${Number(result.loan.principalAmount || 0).toLocaleString('en-IN')}`, 'ঋণ বিতরণ সম্পন্ন');
        this.selectedReceiptForPrint.set(this.buildReceipt(cust, result.loan.loanId, result.loan.loanAccountNo, result.loan.disbursementDate, {
          name: loan.approvedByName || user.name, role: loan.approvedByName ? 'শাখা ব্যবস্থাপক (অনুমোদনকারী)' : user.role
        }));
      } else {
        const loan = await this.lifecycle.createApplication({
          customerId: cust.customerId,
          productId: Number(this.selectedProductId()),
          principalAmount: this.principalAmount(),
          interestMethod: this.profitCalculationType() === 'DECLINING' ? 'DECLINING' : 'FLAT',
          ratePercent: this.effectiveProfitRate(),
          totalInstallments: this.totalInstallments(),
          installmentFrequency: this.installmentFrequency(),
          savingsPerInstallment: this.savingsPerInstallment(),
          formFeePaid: this.formFeePaid(),
          insuranceFeePaid: this.insuranceFeePaid(),
          purposeOfLoan: this.purposeOfLoan(),
          proposedFirstDueDate: this.firstInstallmentDueDate()
        }, actor);
        this.successMessage.set(`ঋণ আবেদন ${loan.loanAccountNo} জমা হয়েছে — এখন মাঠ যাচাই ও শাখা ব্যবস্থাপকের অনুমোদনের অপেক্ষায়।`);
        this.toast.success(`ঋণ আবেদন ${loan.loanAccountNo} জমা হয়েছে`, 'আবেদন জমা হয়েছে', '/loans/approvals');
        setTimeout(() => this.router.navigate(['/loans/approvals']), 1500);
      }
    } catch (err: any) {
      console.error('Loan submit error:', err);
      this.errorMessage.set(err?.message || 'প্রক্রিয়া সম্পন্ন করা যায়নি');
    } finally {
      this.submitting.set(false);
    }
  }
}
