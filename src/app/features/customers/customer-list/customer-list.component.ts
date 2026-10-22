import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Firestore, collection, getDocs, doc, setDoc } from '@angular/fire/firestore';
import { Customer, EditHistoryEntry, Branch, CenterOrSamity, UserStaff, Loan, LoanStatus, SavingsTransaction, PaymentCollection, MemberTransfer, CreditScoreChange } from '../../../core/models/database.models';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { MemberService } from '../../../core/services/member.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { HistoryModalComponent } from '../../../shared/components/history-modal/history-modal.component';
import { CustomerApplicationFormComponent } from '../customer-application-form/customer-application-form.component';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

// সদস্য বিবরণী প্রিন্টে কোন কোন অংশ থাকবে (সদস্যের তথ্য সব সময় থাকে)
export interface CustomerPrintOptions {
  loans: boolean;           // ঋণ বিবরণী
  payments: boolean;        // কিস্তি পরিশোধের ইতিহাস
  paymentDetails: boolean;  // প্রতিটি রসিদের বিস্তারিত বিভাজন
  savings: boolean;         // সঞ্চয় স্থিতি ও সঞ্চয়ের ইতিহাস
}

@Component({
  selector: 'app-customer-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, HistoryModalComponent, CustomerApplicationFormComponent, SkeletonComponent],
  templateUrl: './customer-list.component.html',
  styleUrl: './customer-list.component.scss'
})
export class CustomerListComponent implements OnInit {
  private router = inject(Router);
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  private memberService = inject(MemberService);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly customers = signal<Customer[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);

  // ফাঁকা সদস্য ভর্তি আবেদন ফরম (প্রিন্ট করে গ্রাহককে দেওয়ার জন্য)
  readonly showApplicationForm = signal<boolean>(false);
  readonly staffList = signal<UserStaff[]>([]);
  readonly loading = signal<boolean>(true);

  searchQuery: string = '';

  // History modal state
  selectedCustomerForHistory = signal<Customer | null>(null);

  // Delete modal state
  selectedCustomerForDelete = signal<Customer | null>(null);
  deleteReason: string = '';

  // Details modal state
  showDetailsModal = signal<boolean>(false);
  selectedCustomerForDetails = signal<Customer | null>(null);
  selectedCustomerLoans = signal<Loan[]>([]);
  loadingLoans = signal<boolean>(false);
  readonly selectedCustomerSavingsHistory = signal<SavingsTransaction[]>([]);
  readonly loadingSavingsHistory = signal<boolean>(false);
  readonly savingsExpanded = signal<boolean>(false);
  // কিস্তি পরিশোধের ইতিহাস (Installment payment history)
  readonly selectedCustomerPayments = signal<PaymentCollection[]>([]);
  readonly loadingPayments = signal<boolean>(false);
  readonly paymentsExpanded = signal<boolean>(false);
  readonly expandedPaymentIds = signal<Set<number>>(new Set());

  // Print options modal state
  readonly showPrintOptions = signal<boolean>(false);
  readonly printOptions = signal<CustomerPrintOptions>({ loans: true, payments: true, paymentDetails: false, savings: true });

  // ID Card modal state
  showIdCardModal = signal<boolean>(false);
  selectedCustomerForCard = signal<Customer | null>(null);

  // Disclose / Close Account modal state
  showDiscloseModal = signal<boolean>(false);
  selectedCustomerForDisclose = signal<Customer | null>(null);
  discloseRefundAmount: number = 0;
  discloseRemainingSavings: number = 0;
  discloseDate: string = '';
  discloseReason: string = 'সদস্যপদ প্রত্যাহার ও সঞ্চয় ফেরত প্রদান (হিসাব ক্লোজ)';
  disclosePaymentMethod: 'CASH' | 'BANK' | 'BKASH' = 'CASH';
  discloseNewStatus: 'CLOSED' | 'INACTIVE' = 'CLOSED';
  adjustOutstandingWithSavings: boolean = false;
  discloseSubmitting = signal<boolean>(false);
  discloseOutstandingLoanAmount = signal<number>(0);

  // Edit Savings modal state
  showEditSavingsModal = signal<boolean>(false);
  selectedCustomerForEditSavings = signal<Customer | null>(null);
  editSavingsCurrentBalance: number = 0;
  newSavingsBalance: number = 0;
  savingsEditAdjustmentType: 'DIRECT' | 'DEPOSIT' | 'WITHDRAW' = 'DIRECT';
  savingsEditAmount: number = 0;
  savingsEditReason: string = 'সঞ্চয় স্থিতি সমন্বয় / সংশোধন';
  savingsSubmitting = signal<boolean>(false);
  readonly savingsError = signal<string>('');
  readonly discloseError = signal<string>('');

  // পাতার উপরের ইনলাইন বার্তা (alert() এর পরিবর্তে)
  readonly notice = signal<{ type: 'success' | 'danger' | 'warning' | 'info'; text: string } | null>(null);

  // সদস্য স্থানান্তর ও ক্রেডিট স্কোর ইতিহাস (বিস্তারিত মডালে)
  readonly selectedCustomerTransfers = signal<MemberTransfer[]>([]);
  readonly selectedCustomerCreditHistory = signal<CreditScoreChange[]>([]);

  // সদস্য স্থানান্তর মডাল
  readonly transferCustomer = signal<Customer | null>(null);
  readonly transferBranchId = signal<number | null>(null);
  readonly transferCenterId = signal<number | null>(null);
  readonly transferFoId = signal<number | null>(null);
  transferReason: string = '';
  readonly transferSubmitting = signal<boolean>(false);
  readonly transferError = signal<string>('');
  readonly transferCenters = computed(() => {
    const bId = Number(this.transferBranchId());
    return this.centers().filter(c => Number(c.branchId) === bId && !c.isDeleted);
  });
  readonly transferOfficers = computed(() => {
    const bId = Number(this.transferBranchId());
    return this.staffList().filter(s => s.role === 'FIELD_OFFICER' && Number(s.branchId) === bId && s.status !== 'INACTIVE');
  });

  // ক্রেডিট স্কোর / কালো তালিকা মডাল
  readonly creditCustomer = signal<Customer | null>(null);
  creditScoreValue: Customer['creditScore'] = 'GOOD';
  creditReason: string = '';
  readonly creditSubmitting = signal<boolean>(false);
  readonly creditError = signal<string>('');
  readonly creditScoreOptions: { value: Customer['creditScore']; label: string }[] = [
    { value: 'GOOD', label: 'ভালো (GOOD)' },
    { value: 'AVERAGE', label: 'মধ্যম (AVERAGE)' },
    { value: 'RISKY', label: 'ঝুঁকিপূর্ণ (RISKY)' },
    { value: 'BLACKLISTED', label: 'কালো তালিকাভুক্ত (BLACKLISTED)' }
  ];
  readonly canChangeCreditScore = computed(() => this.authService.canApproveLoans() || this.authService.canManageUsers());

  async ngOnInit() {
    await this.loadAllData();
  }

  async loadAllData() {
    this.loading.set(true);
    try {
      const [branches, centers, customers] = await Promise.all([
        this.kistiService.getBranches(),
        this.kistiService.getCenters(),
        this.kistiService.getCustomers()
      ]);

      this.branches.set(branches);
      this.centers.set(centers);
      this.customers.set(customers);
    } catch (err) {
      console.error('Error fetching initial data:', err);
    } finally {
      this.loading.set(false);
    }
    // মাঠকর্মীর নাম ও স্থানান্তরের জন্য কর্মী তালিকা (পটভূমিতে)
    this.kistiService.getStaff().then(list => this.staffList.set(list)).catch(err => console.error('Error loading staff:', err));
  }

  async loadCustomers() {
    try {
      const list = await this.kistiService.getCustomers();
      this.customers.set(list);
    } catch (err) {
      console.error('Error loading customers:', err);
    }
  }

  filteredCustomers(): Customer[] {
    let list = this.customers();
    const user = this.authService.currentUser();

    // Role-based visibility
    if (user.role === 'FIELD_OFFICER') {
      list = list.filter(c =>
        c.assignedFieldOfficerId === user.userId ||
        (user.assignedCenterIds && user.assignedCenterIds.includes(c.centerId))
      );
    } else if (user.role === 'BRANCH_MANAGER' || user.role === 'CASHIER') {
      list = list.filter(c => c.branchId === user.branchId);
    } else if (this.authService.isAreaScoped()) {
      // এরিয়া ম্যানেজার: শুধু নির্ধারিত শাখার সদস্য
      list = list.filter(c => this.authService.canAccessBranch(c.branchId));
    }

    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return list;

    return list.filter(c =>
      c.fullName.toLowerCase().includes(q) ||
      c.phonePrimary.includes(q) ||
      c.nidNumber.includes(q) ||
      c.customerId.toString().includes(q)
    );
  }

  getBranchName(branchId: number): string {
    const b = this.branches().find(item => item.branchId === branchId);
    return b ? `${b.name}` : `শাখা #${branchId}`;
  }

  getCenterName(centerId: number): string {
    const c = this.centers().find(item => item.centerId === centerId);
    return c ? `${c.name}` : `সমিতি #${centerId}`;
  }

  getCenter(centerId: number): CenterOrSamity | undefined {
    return this.centers().find(item => item.centerId === centerId);
  }

  getFieldOfficerName(officerId: number): string {
    const staff = this.staffList().find(s => Number(s.userId) === Number(officerId));
    if (staff) return staff.name;
    if (officerId === 502) return 'মোঃ রফিকুল ইসলাম (মাঠকর্মী)';
    if (officerId === 501) return 'মোঃ কামরুল ইসলাম (BM)';
    return `মাঠ কর্মকর্তা #${officerId}`;
  }

  async openCustomerDetails(customer: Customer) {
    this.selectedCustomerForDetails.set(customer);
    this.savingsExpanded.set(false); // Collapsed / hidden by default when customer info is opened
    this.paymentsExpanded.set(false);
    this.expandedPaymentIds.set(new Set());
    this.showDetailsModal.set(true);
    this.selectedCustomerTransfers.set([]);
    this.selectedCustomerCreditHistory.set([]);
    await Promise.all([
      this.loadCustomerLoans(customer.customerId),
      this.loadCustomerSavingsHistory(customer.customerId),
      this.loadCustomerPayments(customer.customerId),
      this.loadMemberHistories(customer.customerId)
    ]);
  }

  /** স্থানান্তর ও ক্রেডিট স্কোর পরিবর্তনের ইতিহাস */
  async loadMemberHistories(customerId: number) {
    const [transfers, credit] = await Promise.all([
      this.memberService.getTransfers(customerId).catch(err => { console.error('Error loading transfers:', err); return []; }),
      this.memberService.getCreditScoreHistory(customerId).catch(err => { console.error('Error loading credit history:', err); return []; })
    ]);
    this.selectedCustomerTransfers.set(transfers);
    this.selectedCustomerCreditHistory.set(credit);
  }

  getCreditScoreLabel(score: Customer['creditScore'] | undefined): string {
    return this.creditScoreOptions.find(o => o.value === (score || 'GOOD'))?.label || String(score);
  }

  getCreditScoreBadgeClass(score: Customer['creditScore'] | undefined): string {
    switch (score) {
      case 'AVERAGE': return 'badge-warning';
      case 'RISKY':
      case 'BLACKLISTED': return 'badge-danger';
      default: return 'badge-paid';
    }
  }

  private errorText(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback;
  }

  private get actor() {
    const u = this.authService.currentUser();
    return { userId: u.userId, name: u.name, role: u.role };
  }

  private patchCustomerLocal(customerId: number, fields: Partial<Customer>) {
    this.customers.update(list => list.map(c => c.customerId === customerId ? { ...c, ...fields } : c));
    if (this.selectedCustomerForDetails()?.customerId === customerId) {
      this.selectedCustomerForDetails.update(c => c ? { ...c, ...fields } : null);
    }
  }

  // ==========================================
  // সদস্য স্থানান্তর (Member Transfer)
  // ==========================================
  openTransferModal(customer: Customer) {
    this.transferCustomer.set(customer);
    this.transferReason = '';
    this.transferError.set('');
    this.onTransferBranchChange(Number(customer.branchId));
    // একই শাখায় থাকলে বর্তমান সমিতি বাদে প্রথম সমিতি ডিফল্ট
    const other = this.transferCenters().find(c => c.centerId !== customer.centerId);
    if (other) this.onTransferCenterChange(other.centerId);
  }

  closeTransferModal() {
    this.transferCustomer.set(null);
  }

  onTransferBranchChange(branchId: number) {
    this.transferBranchId.set(Number(branchId));
    const first = this.transferCenters()[0];
    this.onTransferCenterChange(first ? first.centerId : null);
  }

  onTransferCenterChange(centerId: number | null) {
    this.transferCenterId.set(centerId === null ? null : Number(centerId));
    const center = this.centers().find(c => c.centerId === Number(centerId));
    // সমিতির নির্ধারিত মাঠকর্মী ডিফল্ট
    this.transferFoId.set(center?.fieldOfficerUserId ?? this.transferOfficers()[0]?.userId ?? null);
  }

  async confirmTransfer() {
    const customer = this.transferCustomer();
    if (!customer) return;
    const toBranchId = this.transferBranchId();
    const toCenterId = this.transferCenterId();
    const toFieldOfficerId = this.transferFoId();
    if (!toBranchId || !toCenterId || !toFieldOfficerId) {
      this.transferError.set('নতুন শাখা, সমিতি ও মাঠকর্মী নির্বাচন করুন');
      return;
    }
    if (!this.transferReason.trim()) {
      this.transferError.set('স্থানান্তরের কারণ লিখুন');
      return;
    }
    this.transferSubmitting.set(true);
    this.transferError.set('');
    try {
      const transfer = await this.memberService.transferMember(
        { customerId: customer.customerId, toBranchId, toCenterId, toFieldOfficerId, reason: this.transferReason },
        this.actor
      );
      this.patchCustomerLocal(customer.customerId, { branchId: transfer.toBranchId, centerId: transfer.toCenterId, assignedFieldOfficerId: transfer.toFieldOfficerId });
      if (this.selectedCustomerForDetails()?.customerId === customer.customerId) {
        await Promise.all([this.loadMemberHistories(customer.customerId), this.loadCustomerLoans(customer.customerId)]);
      }
      this.closeTransferModal();
      this.notice.set({
        type: 'success',
        text: `সদস্য #${customer.customerId} (${customer.fullName}) ${this.getCenterName(transfer.toCenterId)} সমিতিতে স্থানান্তরিত হয়েছে (${transfer.loansMoved.length}টি চলমান ঋণসহ)`
      });
    } catch (err) {
      console.error('Transfer error:', err);
      this.transferError.set(this.errorText(err, 'স্থানান্তরে সমস্যা হয়েছে'));
    } finally {
      this.transferSubmitting.set(false);
    }
  }

  // ==========================================
  // ক্রেডিট স্কোর / কালো তালিকা
  // ==========================================
  openCreditModal(customer: Customer) {
    this.creditCustomer.set(customer);
    this.creditScoreValue = customer.creditScore || 'GOOD';
    this.creditReason = '';
    this.creditError.set('');
  }

  closeCreditModal() {
    this.creditCustomer.set(null);
  }

  async confirmCreditScore() {
    const customer = this.creditCustomer();
    if (!customer) return;
    if (!this.creditReason.trim()) {
      this.creditError.set('কারণ লেখা বাধ্যতামূলক');
      return;
    }
    if ((customer.creditScore || 'GOOD') === this.creditScoreValue) {
      this.creditError.set('নতুন স্কোর বর্তমান স্কোরের মতোই — পরিবর্তন করুন');
      return;
    }
    this.creditSubmitting.set(true);
    this.creditError.set('');
    try {
      await this.memberService.setCreditScore(customer.customerId, this.creditScoreValue, this.creditReason, this.actor);
      this.patchCustomerLocal(customer.customerId, {
        creditScore: this.creditScoreValue,
        blacklistReason: this.creditScoreValue === 'BLACKLISTED' ? this.creditReason.trim() : '',
        creditScoreUpdatedAt: new Date().toISOString()
      });
      if (this.selectedCustomerForDetails()?.customerId === customer.customerId) {
        await this.loadMemberHistories(customer.customerId);
      }
      this.closeCreditModal();
      this.notice.set({ type: 'success', text: `সদস্য #${customer.customerId} এর ক্রেডিট স্কোর ${this.getCreditScoreLabel(this.creditScoreValue)} করা হয়েছে` });
    } catch (err) {
      console.error('Credit score error:', err);
      this.creditError.set(this.errorText(err, 'ক্রেডিট স্কোর পরিবর্তনে সমস্যা হয়েছে'));
    } finally {
      this.creditSubmitting.set(false);
    }
  }

  toggleSavingsExpanded() {
    this.savingsExpanded.update(v => !v);
  }

  togglePaymentsExpanded() {
    this.paymentsExpanded.update(v => !v);
  }

  togglePaymentRow(receiptId: number) {
    this.expandedPaymentIds.update(set => {
      const next = new Set(set);
      if (next.has(receiptId)) {
        next.delete(receiptId);
      } else {
        next.add(receiptId);
      }
      return next;
    });
  }

  isPaymentRowExpanded(receiptId: number): boolean {
    return this.expandedPaymentIds().has(receiptId);
  }

  getTotalPaidFromReceipts(): number {
    return this.selectedCustomerPayments().reduce((sum, r) => sum + (r.totalAmountCollected || 0), 0);
  }

  getLoanAccountNo(loanId: number): string {
    return this.selectedCustomerLoans().find(l => l.loanId === loanId)?.loanAccountNo || `LN-${loanId}`;
  }

  async loadCustomerPayments(customerId: number) {
    this.loadingPayments.set(true);
    try {
      const list = await this.kistiService.getPaymentCollectionsByCustomerId(customerId);
      this.selectedCustomerPayments.set(list);
    } catch (err) {
      console.error('Error loading customer payment history:', err);
      this.selectedCustomerPayments.set([]);
    } finally {
      this.loadingPayments.set(false);
    }
  }

  async loadCustomerLoans(customerId: number) {
    this.loadingLoans.set(true);
    try {
      const loans = await this.kistiService.getLoansByCustomerId(customerId);
      this.selectedCustomerLoans.set(loans);
    } catch (err) {
      console.error('Error loading customer loans:', err);
      this.selectedCustomerLoans.set([]);
    } finally {
      this.loadingLoans.set(false);
    }
  }

  async loadCustomerSavingsHistory(customerId: number) {
    this.loadingSavingsHistory.set(true);
    try {
      let list = await this.kistiService.getSavingsTransactionsByCustomerId(customerId);
      const customer = this.selectedCustomerForDetails();

      // If customer has a savings balance but no transactions yet, synthesize opening balance
      if (list.length === 0 && customer && (customer.totalSavingsBalance || 0) > 0) {
        list = [{
          transactionId: 0,
          customerId: customer.customerId,
          customerName: customer.fullName,
          branchId: customer.branchId,
          centerId: customer.centerId,
          type: 'DEPOSIT',
          amount: customer.totalSavingsBalance,
          isCredit: true,
          previousBalance: 0,
          newBalance: customer.totalSavingsBalance,
          paymentMethod: 'CASH',
          transactionDate: customer.createdAt || new Date().toISOString(),
          performedByUserId: 1,
          performedByName: 'সিস্টেম ইনিশিয়ালাইজেশন',
          performedByRole: 'SYSTEM',
          reason: 'সদস্য ভর্তিকালীন প্রাথমিক সঞ্চয় স্থিতি (Opening Savings Balance)',
          isDeleted: false,
          deletedAt: null,
          deletedByUserId: null,
          deleteReason: null,
          history: []
        }];
      }

      this.selectedCustomerSavingsHistory.set(list);
    } catch (err) {
      console.error('Error loading customer savings history:', err);
      this.selectedCustomerSavingsHistory.set([]);
    } finally {
      this.loadingSavingsHistory.set(false);
    }
  }

  closeCustomerDetails() {
    this.showDetailsModal.set(false);
    this.selectedCustomerForDetails.set(null);
    this.selectedCustomerLoans.set([]);
    this.selectedCustomerSavingsHistory.set([]);
    this.savingsExpanded.set(false);
    this.selectedCustomerPayments.set([]);
    this.paymentsExpanded.set(false);
    this.expandedPaymentIds.set(new Set());
  }

  openIdCard(customer: Customer) {
    this.selectedCustomerForCard.set(customer);
    this.showIdCardModal.set(true);
  }

  closeIdCard() {
    this.showIdCardModal.set(false);
    this.selectedCustomerForCard.set(null);
  }

  printIdCard() {
    document.body.classList.add('print-id-card');
    document.body.classList.remove('print-customer-details');
    window.print();
    setTimeout(() => {
      document.body.classList.remove('print-id-card');
    }, 1000);
  }

  get printDate(): string {
    const today = new Date();
    return today.toLocaleDateString('bn-BD', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  openPrintOptions() {
    this.showPrintOptions.set(true);
  }

  closePrintOptions() {
    this.showPrintOptions.set(false);
  }

  togglePrintOption(key: keyof CustomerPrintOptions) {
    this.printOptions.update(o => ({ ...o, [key]: !o[key] }));
  }

  setPrintPreset(preset: 'profile' | 'all') {
    const on = preset === 'all';
    this.printOptions.set({ loans: on, payments: on, paymentDetails: on, savings: on });
  }

  confirmPrint() {
    const options = this.printOptions();
    this.showPrintOptions.set(false);
    this.printCustomerDetails(options);
  }

  // নির্বাচিত অংশগুলো খুলে প্রিন্ট করে, তারপর স্ক্রিনের আগের অবস্থা ফিরিয়ে আনে
  printCustomerDetails(options: CustomerPrintOptions = { loans: true, payments: true, paymentDetails: true, savings: true }) {
    const prevSavingsExpanded = this.savingsExpanded();
    const prevPaymentsExpanded = this.paymentsExpanded();
    const prevExpandedRows = this.expandedPaymentIds();

    this.savingsExpanded.set(options.savings);
    this.paymentsExpanded.set(options.payments);
    this.expandedPaymentIds.set(options.payments && options.paymentDetails
      ? new Set(this.selectedCustomerPayments().map(r => r.receiptId))
      : new Set());

    const hideClasses = [
      !options.loans && 'print-hide-loans',
      !options.payments && 'print-hide-payments',
      !options.savings && 'print-hide-savings'
    ].filter((c): c is string => !!c);

    document.body.classList.add('print-customer-details', ...hideClasses);
    document.body.classList.remove('print-id-card');

    const cleanup = () => {
      document.body.classList.remove('print-customer-details', ...hideClasses);
      this.savingsExpanded.set(prevSavingsExpanded);
      this.paymentsExpanded.set(prevPaymentsExpanded);
      this.expandedPaymentIds.set(prevExpandedRows);
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    // Let Angular render the selected sections (and close the options modal) before opening the print dialog
    setTimeout(() => {
      window.print();
    }, 150);
  }

  isCustomerDetailsLoading(): boolean {
    return this.loadingLoans() || this.loadingSavingsHistory() || this.loadingPayments();
  }

  printFullCustomerProfile() {
    this.printCustomerDetails();
  }



  // Loan summary calculation helpers
  getCompletedLoansCount(loans: Loan[]): number {
    return loans.filter(l => l.status === 'CLOSED').length;
  }

  getActiveLoansCount(loans: Loan[]): number {
    return loans.filter(l => l.status === 'DISBURSED' || l.status === 'APPROVED' || l.status === 'OVERDUE').length;
  }

  getTotalLoanAmount(loans: Loan[]): number {
    return loans.reduce((sum, l) => sum + (l.principalAmount || 0), 0);
  }

  getTotalOutstanding(loans: Loan[]): number {
    return loans.reduce((sum, l) => sum + (l.outstandingBalance || 0), 0);
  }

  getTotalPaidAmount(loans: Loan[]): number {
    return loans.reduce((sum, l) => sum + (l.totalPaidAmount || 0), 0);
  }

  getLoanProgressPercent(loan: Loan): number {
    if (!loan.totalRepayableAmount || loan.totalRepayableAmount <= 0) return 0;
    const pct = Math.round(((loan.totalPaidAmount || 0) / loan.totalRepayableAmount) * 100);
    return Math.min(100, Math.max(0, pct));
  }

  isAccountClosedOrInactive(customer: Customer): boolean {
    return customer.status === 'CLOSED' || customer.status === 'INACTIVE';
  }

  getLoanStatusBadge(status: LoanStatus): { text: string; cssClass: string } {
    switch (status) {
      case 'CLOSED':
        return { text: 'পরিশোধিত (Closed)', cssClass: 'badge-paid' };
      case 'DISBURSED':
        return { text: 'চলমান (Running)', cssClass: 'badge-running' };
      case 'OVERDUE':
        return { text: 'খেলাপি/বকেয়া (Overdue)', cssClass: 'badge-overdue' };
      case 'APPROVED':
        return { text: 'অনুমোদিত (Approved)', cssClass: 'badge-approved' };
      default:
        return { text: status, cssClass: 'badge-secondary' };
    }
  }

  getSavingsTypeLabel(type: string): string {
    switch (type) {
      case 'DEPOSIT':
        return 'সঞ্চয় জমা';
      case 'WITHDRAW':
        return 'সঞ্চয় উত্তোলন';
      case 'KISTI_COLLECTION':
        return 'কিস্তি আদায়ে সঞ্চয়';
      case 'ADJUSTMENT':
        return 'সঞ্চয় সমন্বয়';
      case 'ACCOUNT_CLOSURE':
        return 'হিসাব সমাপ্তি সঞ্চয় ফেরত';
      default:
        return type || 'সঞ্চয় লেনদেন';
    }
  }

  getSavingsTypeBadgeClass(type: string): string {
    switch (type) {
      case 'DEPOSIT':
        return 'badge-deposit';
      case 'WITHDRAW':
        return 'badge-withdraw';
      case 'KISTI_COLLECTION':
        return 'badge-kisti';
      case 'ADJUSTMENT':
        return 'badge-adjustment';
      case 'ACCOUNT_CLOSURE':
        return 'badge-closure';
      default:
        return 'badge-secondary';
    }
  }

  // ==========================================
  // DISCLOSE / CLOSE ACCOUNT OPERATIONS
  // ==========================================
  async openDiscloseModal(customer: Customer) {
    this.selectedCustomerForDisclose.set(customer);
    this.discloseRefundAmount = customer.totalSavingsBalance || 0;
    this.discloseRemainingSavings = 0;
    this.discloseDate = new Date().toISOString().split('T')[0];
    this.discloseReason = 'সদস্যপদ প্রত্যাহার ও সঞ্চয় ফেরত প্রদান (হিসাব ক্লোজ)';
    this.disclosePaymentMethod = 'CASH';
    this.discloseNewStatus = 'CLOSED';
    this.adjustOutstandingWithSavings = false;
    this.discloseError.set('');

    // Load customer's loans to calculate any outstanding balance
    try {
      let loans = this.selectedCustomerLoans();
      if (this.selectedCustomerForDetails()?.customerId !== customer.customerId) {
        loans = await this.kistiService.getLoansByCustomerId(customer.customerId);
      }
      const outstanding = this.getTotalOutstanding(loans);
      this.discloseOutstandingLoanAmount.set(outstanding);
    } catch (e) {
      console.error('Error fetching loans for disclose modal:', e);
      this.discloseOutstandingLoanAmount.set(0);
    }

    this.showDiscloseModal.set(true);
  }

  closeDiscloseModal() {
    this.showDiscloseModal.set(false);
    this.selectedCustomerForDisclose.set(null);
  }

  onDiscloseRefundChange() {
    const savings = this.selectedCustomerForDisclose()?.totalSavingsBalance || 0;
    const refund = Number(this.discloseRefundAmount) || 0;
    this.discloseRemainingSavings = Math.max(0, savings - refund);
  }

  onToggleAdjustWithSavings() {
    const savings = this.selectedCustomerForDisclose()?.totalSavingsBalance || 0;
    const outstanding = this.discloseOutstandingLoanAmount();
    if (this.adjustOutstandingWithSavings) {
      this.discloseRefundAmount = Math.max(0, savings - outstanding);
      this.discloseRemainingSavings = 0;
    } else {
      this.discloseRefundAmount = savings;
      this.discloseRemainingSavings = 0;
    }
  }

  setDiscloseReasonQuick(reasonText: string) {
    this.discloseReason = reasonText;
  }

  async confirmDiscloseAccount() {
    const customer = this.selectedCustomerForDisclose();
    if (!customer) return;
    this.discloseError.set('');

    if (!this.discloseReason.trim()) {
      this.discloseError.set('অনুগ্রহ করে হিসাব বন্ধ করার কারণ উল্লেখ করুন');
      return;
    }

    const outstanding = this.discloseOutstandingLoanAmount();
    if (outstanding > 0 && !this.adjustOutstandingWithSavings) {
      const confirmProceed = confirm(
        `সতর্কতা: এই গ্রাহকের বর্তমানে ৳ ${outstanding.toLocaleString()} টাকা ঋণ বকেয়া রয়েছে!\nআপনি কি ঋণ বকেয়া রেখেই গ্রাহক হিসাব সমাপ্ত ও সঞ্চয় হস্তান্তর করতে চান?`
      );
      if (!confirmProceed) return;
    }

    this.discloseSubmitting.set(true);
    const actor = this.actor;
    let currentSavings = customer.totalSavingsBalance || 0;
    let closedLoanCount = 0;
    let refunded = 0;
    const done: string[] = [];

    try {
      // (ক) সঞ্চয় হতে বকেয়া ঋণ সমন্বয় — ঋণ CLOSED, বাকি কিস্তি PAID ও সঞ্চয় খতিয়ানে ADJUSTMENT এন্ট্রি
      if (this.adjustOutstandingWithSavings && outstanding > 0) {
        const settlement = await this.kistiService.settleLoansFromSavings(
          customer.customerId,
          actor,
          `সদস্যপদ সমাপ্তি: ${this.discloseReason}`
        );
        currentSavings = settlement.newSavingsBalance;
        closedLoanCount = settlement.closedLoanIds.length;
        this.patchCustomerLocal(customer.customerId, { totalSavingsBalance: currentSavings });
        done.push(`৳ ${settlement.adjustedAmount.toLocaleString()} সঞ্চয় হতে ঋণ সমন্বয় (${closedLoanCount}টি ঋণ ক্লোজ)`);
      }

      // (খ) সঞ্চয় ফেরত — সমন্বয়ের পর যা আছে তার বেশি নয়; স্থিতি সার্ভিস নিজেই খতিয়ান থেকে হিসাব করে
      refunded = Math.min(Math.max(0, Number(this.discloseRefundAmount) || 0), currentSavings);
      let auditReason = `হিসাব সমাপ্তি (${this.discloseNewStatus}): সঞ্চয় ফেরত ৳ ${refunded.toLocaleString()} (${this.disclosePaymentMethod})। কারণ: ${this.discloseReason}`;
      if (closedLoanCount > 0) {
        auditReason += ` [বকেয়া ঋণ সঞ্চয় হতে সমন্বয়, ${closedLoanCount}টি ঋণ ক্লোজ]`;
      }

      if (refunded > 0) {
        const txn = await this.kistiService.recordSavingsTransaction(
          {
            customerId: customer.customerId,
            customerName: customer.fullName,
            branchId: customer.branchId,
            centerId: customer.centerId,
            type: 'ACCOUNT_CLOSURE',
            amount: refunded,
            isCredit: false,
            previousBalance: currentSavings,
            newBalance: currentSavings - refunded,
            paymentMethod: this.disclosePaymentMethod,
            transactionDate: new Date().toISOString(),
            performedByUserId: actor.userId,
            performedByName: actor.name,
            performedByRole: actor.role,
            reason: auditReason
          },
          actor,
          auditReason
        );
        currentSavings = txn.newBalance;
        this.patchCustomerLocal(customer.customerId, { totalSavingsBalance: currentSavings });
        done.push(`৳ ${refunded.toLocaleString()} সঞ্চয় ফেরত`);
      }

      // (গ) শুধু স্ট্যাটাস পরিবর্তন — সঞ্চয় স্থিতি খতিয়ান-নিয়ন্ত্রিত
      await this.kistiService.updateCustomer(customer.customerId, { status: this.discloseNewStatus }, actor, auditReason);
      this.patchCustomerLocal(customer.customerId, { status: this.discloseNewStatus });

      if (this.selectedCustomerForDetails()?.customerId === customer.customerId) {
        await this.loadCustomerSavingsHistory(customer.customerId);
        if (closedLoanCount > 0) {
          this.selectedCustomerLoans.set(await this.kistiService.getLoansByCustomerId(customer.customerId));
        }
      }

      this.closeDiscloseModal();
      this.notice.set({
        type: 'success',
        text: `সফল! সদস্য #${customer.customerId} (${customer.fullName}) এর হিসাব ${this.discloseNewStatus === 'CLOSED' ? 'সমাপ্ত/ক্লোজ' : 'নিষ্ক্রিয়'} করা হয়েছে। সঞ্চয় ফেরত ৳ ${refunded.toLocaleString()}, অবশিষ্ট সঞ্চয় ৳ ${currentSavings.toLocaleString()}।`
      });
    } catch (err) {
      console.error('Error disclosing account:', err);
      const partial = done.length ? ` (সম্পন্ন হয়েছে: ${done.join('; ')})` : '';
      this.discloseError.set('হিসাব সমাপ্তকরণে সমস্যা: ' + this.errorText(err, 'অজানা সমস্যা') + partial);
      if (this.selectedCustomerForDetails()?.customerId === customer.customerId && done.length) {
        await this.loadCustomerSavingsHistory(customer.customerId);
      }
    } finally {
      this.discloseSubmitting.set(false);
    }
  }

  // ==========================================
  // DIRECT EDIT SAVINGS OPERATIONS
  // ==========================================
  openEditSavingsModal(customer: Customer) {
    this.selectedCustomerForEditSavings.set(customer);
    this.editSavingsCurrentBalance = customer.totalSavingsBalance || 0;
    this.newSavingsBalance = customer.totalSavingsBalance || 0;
    this.savingsEditAdjustmentType = 'DIRECT';
    this.savingsEditAmount = 0;
    this.savingsEditReason = 'সঞ্চয় স্থিতি সমন্বয় / সংশোধন';
    this.savingsError.set('');
    this.showEditSavingsModal.set(true);
  }

  closeEditSavingsModal() {
    this.showEditSavingsModal.set(false);
    this.selectedCustomerForEditSavings.set(null);
  }

  onSavingsEditModeChange() {
    const current = this.editSavingsCurrentBalance;
    const amount = Number(this.savingsEditAmount) || 0;
    if (this.savingsEditAdjustmentType === 'DEPOSIT') {
      this.newSavingsBalance = current + amount;
      this.savingsEditReason = `সঞ্চয় জমা (+৳ ${amount})`;
    } else if (this.savingsEditAdjustmentType === 'WITHDRAW') {
      this.newSavingsBalance = Math.max(0, current - amount);
      this.savingsEditReason = `সঞ্চয় উত্তোলন (-৳ ${amount})`;
    } else {
      this.newSavingsBalance = current;
      this.savingsEditReason = 'সঞ্চয় স্থিতি সরাসরি সংশোধন';
    }
  }

  onSavingsEditAmountChange() {
    this.onSavingsEditModeChange();
  }

  async confirmEditSavings() {
    const customer = this.selectedCustomerForEditSavings();
    if (!customer) return;
    this.savingsError.set('');

    if (!this.savingsEditReason.trim()) {
      this.savingsError.set('সঞ্চয় পরিবর্তনের কারণ উল্লেখ করুন');
      return;
    }

    // সার্ভিস ডাটাবেসের সর্বশেষ স্থিতি থেকে amount + isCredit দিয়ে নতুন স্থিতি হিসাব করে
    const prevBalance = this.editSavingsCurrentBalance;
    let txType: 'DEPOSIT' | 'WITHDRAW' | 'ADJUSTMENT';
    let amount: number;
    let isCredit: boolean;

    if (this.savingsEditAdjustmentType === 'DIRECT') {
      const target = Math.round((Number(this.newSavingsBalance) || 0) * 100) / 100;
      if (target < 0) {
        this.savingsError.set('সঞ্চয় ব্যালেন্স শূন্য বা তার বেশি হতে হবে');
        return;
      }
      txType = 'ADJUSTMENT';
      amount = Math.abs(target - prevBalance);
      isCredit = target >= prevBalance;
    } else {
      txType = this.savingsEditAdjustmentType;
      amount = Number(this.savingsEditAmount) || 0;
      isCredit = txType === 'DEPOSIT';
      if (!isCredit && amount > prevBalance) {
        this.savingsError.set(`সঞ্চয় স্থিতি (৳ ${prevBalance.toLocaleString()}) এর চেয়ে বেশি উত্তোলন সম্ভব নয়`);
        return;
      }
    }

    if (!(amount > 0)) {
      this.savingsError.set(this.savingsEditAdjustmentType === 'DIRECT' ? 'নতুন ব্যালেন্স বর্তমান ব্যালেন্সের সমান — কোনো পরিবর্তন নেই' : 'সঠিক টাকার পরিমাণ দিন');
      return;
    }

    this.savingsSubmitting.set(true);
    try {
      const actor = this.actor;
      const txn = await this.kistiService.recordSavingsTransaction(
        {
          customerId: customer.customerId,
          customerName: customer.fullName,
          branchId: customer.branchId,
          centerId: customer.centerId,
          type: txType,
          amount,
          isCredit,
          previousBalance: prevBalance,
          newBalance: isCredit ? prevBalance + amount : prevBalance - amount,
          paymentMethod: 'CASH',
          transactionDate: new Date().toISOString(),
          performedByUserId: actor.userId,
          performedByName: actor.name,
          performedByRole: actor.role,
          reason: this.savingsEditReason
        },
        actor,
        this.savingsEditReason
      );

      const updatedBalance = txn.newBalance;
      this.patchCustomerLocal(customer.customerId, { totalSavingsBalance: updatedBalance });
      if (this.selectedCustomerForDetails()?.customerId === customer.customerId) {
        await this.loadCustomerSavingsHistory(customer.customerId);
      }

      this.closeEditSavingsModal();
      this.notice.set({ type: 'success', text: `সফল! সদস্য #${customer.customerId} (${customer.fullName}) এর সঞ্চয় ব্যালেন্স এখন ৳ ${updatedBalance.toLocaleString()}` });
    } catch (err) {
      console.error('Error updating savings:', err);
      this.savingsError.set(this.errorText(err, 'সঞ্চয় আপডেটে সমস্যা হয়েছে'));
    } finally {
      this.savingsSubmitting.set(false);
    }
  }

  async reactivateCustomer(customer: Customer) {
    const confirmReactivate = confirm(
      `আপনি কি সদস্য #${customer.customerId} (${customer.fullName}) এর অ্যাকাউন্ট পুনরায় সক্রিয় (ACTIVE) করতে চান?`
    );
    if (!confirmReactivate) return;

    try {
      const activeUser = this.authService.currentUser();
      await this.kistiService.updateCustomer(
        customer.customerId,
        { status: 'ACTIVE' },
        { userId: activeUser.userId, name: activeUser.name, role: activeUser.role },
        'গ্রাহক অ্যাকাউন্ট পুনরায় সক্রিয়করণ'
      );

      this.customers.update(list => list.map(c => {
        if (c.customerId === customer.customerId) {
          return { ...c, status: 'ACTIVE' };
        }
        return c;
      }));

      if (this.selectedCustomerForDetails()?.customerId === customer.customerId) {
        this.selectedCustomerForDetails.update(c => c ? { ...c, status: 'ACTIVE' } : null);
      }

      this.notice.set({ type: 'success', text: `সদস্য #${customer.customerId} এর অ্যাকাউন্ট সফলভাবে পুনরায় সক্রিয় করা হয়েছে` });
    } catch (err) {
      console.error('Error reactivating customer:', err);
      this.notice.set({ type: 'danger', text: 'অ্যাকাউন্ট পুনরায় সক্রিয় করতে সমস্যা হয়েছে' + ': ' + this.errorText(err, '') });
    }
  }

  async toggleCustomerStatus(customer: Customer) {
    const currentStatus = customer.status || 'ACTIVE';
    const newStatus: 'ACTIVE' | 'INACTIVE' = currentStatus === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const activeUser = this.authService.currentUser();
    const reason = `গ্রাহক স্ট্যাটাস পরিবর্তন: ${newStatus}`;

    try {
      await this.kistiService.updateCustomer(
        customer.customerId,
        { status: newStatus },
        { userId: activeUser.userId, name: activeUser.name, role: activeUser.role },
        reason
      );

      this.customers.update(list => list.map(c => {
        if (c.customerId === customer.customerId) {
          return { ...c, status: newStatus };
        }
        return c;
      }));
    } catch (err) {
      console.error('Error toggling customer status:', err);
      this.notice.set({ type: 'danger', text: 'স্ট্যাটাস পরিবর্তনে সমস্যা হয়েছে' + ': ' + this.errorText(err, '') });
    }
  }

  openHistory(customer: Customer) {
    this.selectedCustomerForHistory.set(customer);
  }

  closeHistory() {
    this.selectedCustomerForHistory.set(null);
  }

  openDeleteModal(customer: Customer) {
    this.selectedCustomerForDelete.set(customer);
    this.deleteReason = '';
  }

  closeDeleteModal() {
    this.selectedCustomerForDelete.set(null);
    this.deleteReason = '';
  }

  async confirmSoftDelete() {
    const customer = this.selectedCustomerForDelete();
    if (!customer) return;

    if (!this.deleteReason.trim()) {
      this.notice.set({ type: 'warning', text: 'অনুগ্রহ করে গ্রাহক বাতিলের কারণ উল্লেখ করুন' });
      return;
    }

    try {
      const activeUser = this.authService.currentUser();
      await this.kistiService.softDeleteCustomer(
        customer.customerId,
        { userId: activeUser.userId, name: activeUser.name, role: activeUser.role },
        this.deleteReason
      );

      this.closeDeleteModal();
      await this.loadCustomers();
      this.notice.set({ type: 'success', text: `গ্রাহক #${customer.customerId} সফলভাবে সফট-ডিলিট করা হয়েছে (হিস্ট্রি সংরক্ষিত)` });
    } catch (err) {
      console.error('Delete error:', err);
      this.notice.set({ type: 'danger', text: 'গ্রাহক ডিলিট করতে সমস্যা হয়েছে' + ': ' + this.errorText(err, '') });
    }
  }
}
