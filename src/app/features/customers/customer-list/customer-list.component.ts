import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Firestore, collection, getDocs, doc, setDoc } from '@angular/fire/firestore';
import { Customer, EditHistoryEntry, Branch, CenterOrSamity, UserStaff, Loan, LoanStatus, SavingsTransaction } from '../../../core/models/database.models';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { HistoryModalComponent } from '../../../shared/components/history-modal/history-modal.component';
import { CustomerRegisterFormComponent } from '../customer-register-form/customer-register-form.component';

@Component({
  selector: 'app-customer-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, HistoryModalComponent, CustomerRegisterFormComponent],
  templateUrl: './customer-list.component.html',
  styleUrl: './customer-list.component.scss'
})
export class CustomerListComponent implements OnInit {
  private router = inject(Router);
  private firestore = inject(Firestore);
  private kistiService = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly customers = signal<Customer[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
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

  // Customer Creation Form Modal (Official Member Admission Form)
  showCustomerCreateModal = signal<boolean>(false);

  // Blank Form Printable State
  showBlankFormModal = signal<boolean>(false);
  isDirectPrintingBlank = signal<boolean>(false);
  blankFormSelectedBranchId = signal<number>(1);

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
    } else if (user.role === 'AREA_MANAGER' || user.role === 'REGIONAL_MANAGER') {
      const areaBranches = this.branches().filter(b => b.areaName === user.areaName || b.branchId === user.branchId);
      const branchIds = areaBranches.map(b => b.branchId);
      list = list.filter(c => branchIds.includes(c.branchId) || c.branchId === user.branchId);
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
    if (officerId === 502) return 'মোঃ রফিকুল ইসলাম (মাঠকর্মী)';
    if (officerId === 501) return 'মোঃ কামরুল ইসলাম (BM)';
    return `মাঠ কর্মকর্তা #${officerId}`;
  }

  async openCustomerDetails(customer: Customer) {
    this.selectedCustomerForDetails.set(customer);
    this.savingsExpanded.set(false); // Collapsed / hidden by default when customer info is opened
    this.showDetailsModal.set(true);
    await Promise.all([
      this.loadCustomerLoans(customer.customerId),
      this.loadCustomerSavingsHistory(customer.customerId)
    ]);
  }

  toggleSavingsExpanded() {
    this.savingsExpanded.update(v => !v);
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

  printCustomerDetails() {
    document.body.classList.add('print-customer-details');
    document.body.classList.remove('print-id-card');

    if (this.savingsExpanded()) {
      document.body.classList.add('print-savings-included');
      document.body.classList.remove('print-savings-excluded');
    } else {
      document.body.classList.add('print-savings-excluded');
      document.body.classList.remove('print-savings-included');
    }

    const cleanup = () => {
      document.body.classList.remove('print-customer-details');
      document.body.classList.remove('print-savings-included');
      document.body.classList.remove('print-savings-excluded');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);

    setTimeout(() => {
      window.print();
    }, 50);
  }

  printFullCustomerProfile() {
    this.printCustomerDetails();
  }

  // ==========================================
  // CUSTOMER CREATION & OFFICIAL ADMISSION FORM
  // ==========================================
  get selectedBlankBranch(): Branch | undefined {
    return this.branches().find(b => b.branchId === Number(this.blankFormSelectedBranchId()));
  }

  openCustomerCreateModal() {
    this.router.navigate(['/customers/new']);
  }

  openBlankCustomerForm(branchId?: number) {
    this.printBlankCustomerForm(branchId);
  }

  closeBlankCustomerForm() {
    this.showBlankFormModal.set(false);
    this.isDirectPrintingBlank.set(false);
  }

  printBlankCustomerForm(branchId?: number) {
    if (branchId) {
      this.blankFormSelectedBranchId.set(branchId);
    } else if (this.branches().length > 0) {
      this.blankFormSelectedBranchId.set(this.branches()[0].branchId);
    }

    // Direct save to local machine: Set PDF file title and trigger print without modal
    const origTitle = document.title;
    document.title = 'eKisti-সদস্য-ভর্তি-খালি-আবেদন-ফরম';
    this.isDirectPrintingBlank.set(true);

    setTimeout(() => {
      window.print();
      setTimeout(() => {
        this.isDirectPrintingBlank.set(false);
        document.title = origTitle;
      }, 500);
    }, 100);
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

    if (!this.discloseReason.trim()) {
      alert('অনুগ্রহ করে হিসাব বন্ধ করার কারণ উল্লেখ করুন');
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
    try {
      const activeUser = this.authService.currentUser();
      const newSavings = Math.max(0, Math.round(Number(this.discloseRemainingSavings) || 0));
      const refunded = Number(this.discloseRefundAmount) || 0;

      let auditReason = `হিসাব সমাপ্তি (${this.discloseNewStatus}): সঞ্চয় ফেরত ৳ ${refunded.toLocaleString()} (${this.disclosePaymentMethod}) প্রদান। অবশিষ্ট সঞ্চয়: ৳ ${newSavings.toLocaleString()}। কারণ: ${this.discloseReason}`;
      if (this.adjustOutstandingWithSavings && outstanding > 0) {
        auditReason += ` [বকেয়া ঋণ ৳ ${outstanding.toLocaleString()} সঞ্চয় হতে সমন্বয় করা হয়েছে]`;
      }

      await this.kistiService.updateCustomer(
        customer.customerId,
        {
          status: this.discloseNewStatus,
          totalSavingsBalance: newSavings
        },
        { userId: activeUser.userId, name: activeUser.name, role: activeUser.role },
        auditReason
      );

      if (refunded > 0) {
        await this.kistiService.recordSavingsTransaction(
          {
            customerId: customer.customerId,
            customerName: customer.fullName,
            branchId: customer.branchId,
            centerId: customer.centerId,
            type: 'ACCOUNT_CLOSURE',
            amount: refunded,
            isCredit: false,
            previousBalance: customer.totalSavingsBalance || 0,
            newBalance: newSavings,
            paymentMethod: this.disclosePaymentMethod === 'BANK' ? 'BANK' : (this.disclosePaymentMethod === 'BKASH' ? 'BKASH' : 'CASH'),
            transactionDate: new Date().toISOString(),
            performedByUserId: activeUser.userId,
            performedByName: activeUser.name,
            performedByRole: activeUser.role,
            reason: auditReason
          },
          { userId: activeUser.userId, name: activeUser.name, role: activeUser.role },
          auditReason
        );
      }

      // Update customers signal
      this.customers.update(list => list.map(c => {
        if (c.customerId === customer.customerId) {
          return {
            ...c,
            status: this.discloseNewStatus,
            totalSavingsBalance: newSavings
          };
        }
        return c;
      }));

      // Update details modal customer if open
      if (this.selectedCustomerForDetails()?.customerId === customer.customerId) {
        this.selectedCustomerForDetails.update(c => c ? {
          ...c,
          status: this.discloseNewStatus,
          totalSavingsBalance: newSavings
        } : null);
        await this.loadCustomerSavingsHistory(customer.customerId);
      }

      this.closeDiscloseModal();
      alert(`সফল! সদস্য #${customer.customerId} (${customer.fullName}) এর হিসাব ${this.discloseNewStatus === 'CLOSED' ? 'সমাপ্ত/ক্লোজ' : 'নিষ্ক্রিয়'} করা হয়েছে এবং সঞ্চয় ফেরত (৳ ${refunded.toLocaleString()}) নিষ্পত্তি রেকর্ড করা হয়েছে।`);
    } catch (err) {
      console.error('Error disclosing account:', err);
      alert('হিসাব সমাপ্তকরণে সমস্যা হয়েছে');
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

    if (this.newSavingsBalance < 0) {
      alert('সঞ্চয় ব্যালেন্স শূন্য বা তার বেশি হতে হবে');
      return;
    }

    if (!this.savingsEditReason.trim()) {
      alert('সঞ্চয় পরিবর্তনের কারণ উল্লেখ করুন');
      return;
    }

    this.savingsSubmitting.set(true);
    try {
      const activeUser = this.authService.currentUser();
      const prevBalance = customer.totalSavingsBalance || 0;
      const updatedBalance = Math.max(0, Math.round(Number(this.newSavingsBalance) || 0));
      const amountChange = Math.abs(updatedBalance - prevBalance);

      let txType: 'DEPOSIT' | 'WITHDRAW' | 'ADJUSTMENT' = 'ADJUSTMENT';
      if (this.savingsEditAdjustmentType === 'WITHDRAW') {
        txType = 'WITHDRAW';
      } else if (this.savingsEditAdjustmentType === 'DEPOSIT') {
        txType = 'DEPOSIT';
      }

      await this.kistiService.recordSavingsTransaction(
        {
          customerId: customer.customerId,
          customerName: customer.fullName,
          branchId: customer.branchId,
          centerId: customer.centerId,
          type: txType,
          amount: this.savingsEditAdjustmentType === 'DIRECT' ? amountChange : (Number(this.savingsEditAmount) || amountChange),
          isCredit: updatedBalance >= prevBalance,
          previousBalance: prevBalance,
          newBalance: updatedBalance,
          paymentMethod: 'CASH',
          transactionDate: new Date().toISOString(),
          performedByUserId: activeUser.userId,
          performedByName: activeUser.name,
          performedByRole: activeUser.role,
          reason: this.savingsEditReason
        },
        { userId: activeUser.userId, name: activeUser.name, role: activeUser.role },
        this.savingsEditReason
      );

      // Update in local signals
      this.customers.update(list => list.map(c => {
        if (c.customerId === customer.customerId) {
          return { ...c, totalSavingsBalance: updatedBalance };
        }
        return c;
      }));

      if (this.selectedCustomerForDetails()?.customerId === customer.customerId) {
        this.selectedCustomerForDetails.update(c => c ? { ...c, totalSavingsBalance: updatedBalance } : null);
        await this.loadCustomerSavingsHistory(customer.customerId);
      }

      this.closeEditSavingsModal();
      alert(`সফল! সদস্য #${customer.customerId} (${customer.fullName}) এর সঞ্চয় ব্যালেন্স ৳ ${updatedBalance.toLocaleString()} এ সফলভাবে সংরক্ষিত হয়েছে।`);
    } catch (err) {
      console.error('Error updating savings:', err);
      alert('সঞ্চয় আপডেটে সমস্যা হয়েছে: ' + (err instanceof Error ? err.message : ''));
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

      alert(`সদস্য #${customer.customerId} এর অ্যাকাউন্ট সফলভাবে পুনরায় সক্রিয় করা হয়েছে`);
    } catch (err) {
      console.error('Error reactivating customer:', err);
      alert('অ্যাকাউন্ট পুনরায় সক্রিয় করতে সমস্যা হয়েছে');
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
      alert('স্ট্যাটাস পরিবর্তনে সমস্যা হয়েছে');
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
      alert('অনুগ্রহ করে গ্রাহক বাতিলের কারণ উল্লেখ করুন');
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
      alert(`গ্রাহক #${customer.customerId} সফলভাবে সফট-ডিলিট করা হয়েছে (হিস্ট্রি সংরক্ষিত)`);
    } catch (err) {
      console.error('Delete error:', err);
      alert('গ্রাহক ডিলিট করতে সমস্যা হয়েছে');
    }
  }
}
