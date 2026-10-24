import { Component, inject, OnInit, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { Loan, InstallmentSchedule, CenterOrSamity, Branch, Customer } from '../../../core/models/database.models';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { FinanceService, PaymentMethod } from '../../../core/services/finance.service';
import { CashService } from '../../../core/services/cash.service';
import { MemberService } from '../../../core/services/member.service';
import { CollectionView, amountForInstallments, collectionView, describeAllocation, nextOpenAfterPayment, upcomingInstallment } from '../../../core/finance/allocation';
import { formatBnDate, todayDhaka, toDhakaDayKey } from '../../../core/finance/dates';
import { AuthStateService, ActiveUserSession } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

/**
 * মাঠ শিটের একটি সারি — কিস্তির নির্ধারিত তারিখ অনুযায়ী (দৈনিক/সাপ্তাহিক/মাসিক সব ঋণে সঠিক),
 * "শেষ আদায়ের পর ৭ দিন" নিয়ম নয়।
 */
export interface DailySheetItem {
  loan: Loan;
  customer?: Customer;
  view: CollectionView;
  installments: InstallmentSchedule[];
  collectedTodayAmount: number;
  /** আজকের পরের প্রথম কিস্তি (পরবর্তী কিস্তি কবে) */
  upcoming: InstallmentSchedule | null;
}

@Component({
  selector: 'app-daily-sheet',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './daily-sheet.component.html',
  styleUrl: './daily-sheet.component.scss'
})
export class DailySheetComponent implements OnInit {
  private kistiService = inject(KistiDatabaseService);
  private finance = inject(FinanceService);
  private cashService = inject(CashService);
  private memberService = inject(MemberService);
  private route = inject(ActivatedRoute);
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
  readonly selectedCenterId = signal<number>(0);
  readonly sheetItems = signal<DailySheetItem[]>([]);
  readonly loading = signal<boolean>(true);

  readonly today = todayDhaka();
  readonly notice = signal<{ kind: 'success' | 'danger'; text: string } | null>(null);

  // Quick Collect Modal state
  readonly activeItemForCollect = signal<DailySheetItem | null>(null);
  readonly collectAmount = signal<number>(0);
  readonly collectSavings = signal<number>(0);
  readonly collectMethod = signal<PaymentMethod>('CASH');
  readonly collectTrxId = signal<string>('');
  readonly allowAdvance = signal<boolean>(false);
  readonly isProcessing = signal<boolean>(false);
  readonly collectError = signal<string>('');
  readonly selectedCount = signal<number>(1);

  // সাপ্তাহিক মিটিং হাজিরা
  // শুধু সঞ্চয় জমা (কিস্তি ছাড়া) — মাঠ রসিদ, টাকা মাঠকর্মীর হাতে
  readonly savingsItem = signal<DailySheetItem | null>(null);
  readonly savingsAmount = signal<number>(0);
  readonly savingsMethod = signal<PaymentMethod>('CASH');
  readonly savingsBusy = signal<boolean>(false);
  readonly savingsError = signal<string>('');

  readonly present = signal<Set<number>>(new Set());
  readonly attendanceSaved = signal<boolean>(false);
  readonly printing = signal<boolean>(false);
  readonly memberCount = computed(() => new Set(this.sheetItems().map(i => i.loan.customerId)).size);
  readonly presentCount = computed(() => {
    const present = this.present();
    return new Set(this.sheetItems().map(i => i.loan.customerId).filter(id => present.has(id))).size;
  });

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

      // ড্যাশবোর্ডের "আজকের রুট" থেকে নির্দিষ্ট সমিতি খোলা
      const requested = Number(this.route.snapshot.queryParamMap.get('centerId'));
      if (requested) this.selectedCenterId.set(requested);
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
      // মাঠকর্মী শুধু সেই রুট/সমিতি দেখবেন যেখানে সমিতিতে তাকেই দায়িত্বপ্রাপ্ত করা আছে
      // (কর্মীর পুরোনো assignedCenterIds তালিকা নয় — সমিতির fieldOfficerUserId-ই একমাত্র উৎস)
      permitted = centers.filter(c => Number(c.fieldOfficerUserId) === Number(user.userId) && !c.isDeleted);
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
      const [allLoans, allCustomers, attendance, todaysReceipts] = await Promise.all([
        this.kistiService.getLoans(),
        this.kistiService.getCustomers(),
        this.memberService.getAttendance(centerId, this.today),
        this.cashService.receiptsBetween(this.today, this.today)
      ]);
      const collectedByLoan = new Map<number, number>();
      todaysReceipts.filter(r => !r.isReversed && r.centerId === centerId).forEach(r =>
        collectedByLoan.set(r.loanId, (collectedByLoan.get(r.loanId) || 0) + (r.totalAmountCollected || 0)));

      // সমিতির চলমান ঋণ (অনুমোদন প্রবাহের ঋণ বাদ)
      let activeLoans = allLoans.filter(l =>
        l.centerId === centerId &&
        (l.status === 'DISBURSED' || l.status === 'OVERDUE') &&
        !l.isDeleted
      );

      // Enforce role-based isolation on loans
      if (currentUser.role === 'FIELD_OFFICER') {
        // নিজের দায়িত্বের সমিতি না হলে কোনো ঋণ দেখাবে না
        if (!this.filteredCenters().some(c => c.centerId === centerId)) activeLoans = [];
      } else if (currentUser.role === 'BRANCH_MANAGER' || currentUser.role === 'CASHIER') {
        activeLoans = activeLoans.filter(l => l.branchId === currentUser.branchId);
      } else if (this.authService.isAreaScoped()) {
        activeLoans = activeLoans.filter(l => this.authService.canAccessBranch(l.branchId));
      }

      // সমিতির সব ঋণের কিস্তি একবারে লোড (প্রতি ঋণে আলাদা কুয়েরি নয়)
      const allInstallments = await this.kistiService.getInstallmentsByLoanIds(activeLoans.map(l => l.loanId));
      const installmentsByLoan = new Map<number, InstallmentSchedule[]>();
      for (const inst of allInstallments) {
        const list = installmentsByLoan.get(inst.loanId) || [];
        list.push(inst);
        installmentsByLoan.set(inst.loanId, list);
      }
      const customers = new Map(allCustomers.map(c => [c.customerId, c]));

      const items: DailySheetItem[] = activeLoans.map(loan => ({
        loan,
        customer: customers.get(loan.customerId),
        view: collectionView(installmentsByLoan.get(loan.loanId) || [], this.today, toDhakaDayKey),
        installments: installmentsByLoan.get(loan.loanId) || [],
        collectedTodayAmount: collectedByLoan.get(loan.loanId) || 0,
        upcoming: upcomingInstallment(installmentsByLoan.get(loan.loanId) || [], this.today)
      })).sort((a, b) => (a.customer?.groupNo || 999) - (b.customer?.groupNo || 999) || a.loan.customerName.localeCompare(b.loan.customerName));

      this.sheetItems.set(items);

      // হাজিরা: আগে সংরক্ষিত থাকলে সেটি, না হলে সবাই উপস্থিত ধরে শুরু
      const memberIds = [...new Set(items.map(i => i.loan.customerId))];
      this.attendanceSaved.set(!!attendance);
      this.present.set(new Set(attendance ? attendance.presentCustomerIds : memberIds));
    } catch (err) {
      console.error('Error loading daily sheet loans:', err);
      this.notice.set({ kind: 'danger', text: 'কালেকশন শিট লোড করা যায়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।' });
    } finally {
      this.loading.set(false);
    }
  }

  onCenterChange(event: Event) {
    const val = Number((event.target as HTMLSelectElement).value);
    this.selectedCenterId.set(val);
    this.loadSheetData();
  }

  rowState(item: DailySheetItem): { cls: string; label: string } {
    const v = item.view;
    if (item.collectedTodayAmount > 0 && !v.hasDue) return { cls: 'badge-paid', label: 'আজ আদায় সম্পন্ন' };
    if (v.overdueCount > 0) return { cls: 'badge-danger', label: `${v.overdueCount}টি বকেয়া` };
    if (v.hasDue) return { cls: 'badge-warning', label: 'আজ দেয়' };
    return { cls: 'badge-secondary', label: 'আজ দেয় নেই' };
  }

  openCollectModal(item: DailySheetItem) {
    this.activeItemForCollect.set(item);
    this.collectError.set('');
    this.collectMethod.set('CASH');
    this.collectTrxId.set('');
    this.allowAdvance.set(false);
    // মাঠে সাধারণত একবারে একটি কিস্তি — পুরাতনতম অপরিশোধিত কিস্তি দিয়ে শুরু
    this.pickInstallments(1);
  }

  /** দ্রুত নির্বাচন: পুরাতন থেকে n টি কিস্তি (0 = আজ পর্যন্ত সব দেয়) */
  pickInstallments(n: number) {
    const item = this.activeItemForCollect();
    if (!item) return;
    const count = n === 0 ? item.view.dueInstallments.length : n;
    const pick = amountForInstallments(item.installments, count);
    this.selectedCount.set(n);
    this.collectAmount.set(pick.amount);
    this.collectSavings.set(pick.savings);
  }

  setCollectAmount(value: number) {
    this.collectAmount.set(value);
    this.selectedCount.set(-1); // নিজে লেখা পরিমাণ
  }

  /** আজ পর্যন্ত দেয় কিস্তির সংখ্যা অনুযায়ী দ্রুত বাটন */
  readonly quickPicks = computed(() => {
    const item = this.activeItemForCollect();
    if (!item) return [];
    const due = item.view.dueInstallments.length;
    const picks: { n: number; label: string; amount: number }[] = [];
    for (const n of [1, 2, 3]) {
      if (n > 1 && n >= due) break;
      const p = amountForInstallments(item.installments, n);
      if (p.count < n) break;
      picks.push({ n, label: `${this.bn(n)}টি কিস্তি`, amount: p.amount });
    }
    if (due > 1) picks.push({ n: 0, label: `সব দেয় (${this.bn(due)}টি)`, amount: item.view.dueAmount });
    return picks;
  });

  /** এই আদায়ের পর যে কিস্তি বাকি থাকবে — "পরবর্তী কিস্তি কবে" */
  readonly nextAfterPayment = computed(() => {
    const item = this.activeItemForCollect();
    if (!item) return null;
    const next = nextOpenAfterPayment(item.installments, Number(this.collectAmount()) || 0, this.today);
    return next ? { no: next.installment.installmentNo, date: next.installment.dueDate, label: formatBnDate(next.installment.dueDate), remaining: next.remaining, overdue: next.installment.dueDate < this.today } : null;
  });

  dayLabel(key: string | undefined | null, short = true): string {
    return formatBnDate(key, short);
  }

  /** প্রবেশ করা টাকায় কোন কিস্তি পূর্ণ / আংশিক হবে */
  readonly allocationPreview = computed(() => {
    const item = this.activeItemForCollect();
    return item ? describeAllocation(item.installments, Number(this.collectAmount()) || 0, this.today) : [];
  });

  closeCollectModal() {
    if (!this.isProcessing()) this.activeItemForCollect.set(null);
  }

  readonly advanceNeeded = computed(() => {
    const item = this.activeItemForCollect();
    return !!item && this.collectAmount() > item.view.dueAmount;
  });

  async confirmCollection() {
    const item = this.activeItemForCollect();
    if (!item) return;

    this.isProcessing.set(true);
    this.collectError.set('');
    const currentUser = this.authService.currentUser();

    try {
      // রসিদ + কিস্তি + ঋণ + সঞ্চয় + খতিয়ান একটি ট্রানজ্যাকশনে
      const receipt = await this.finance.collectPayment({
        loanId: item.loan.loanId,
        loanAmount: Number(this.collectAmount()) || 0,
        savingsAmount: Number(this.collectSavings()) || 0,
        paymentMethod: this.collectMethod(),
        trxId: this.collectTrxId(),
        allowAdvance: this.allowAdvance(),
        reason: `মাঠপর্যায়ে কিস্তি আদায় (সমিতি ${this.selectedCenterId()})`
      }, { userId: currentUser.userId, name: currentUser.name, role: currentUser.role });

      const next = this.nextAfterPayment();
      this.activeItemForCollect.set(null);
      const nextText = next
        ? ` • পরবর্তী কিস্তি #${next.no}: ${next.label}, ৳${next.remaining.toLocaleString('en-IN')}${next.overdue ? ' (বকেয়া)' : ''}`
        : ' • ঋণ সম্পূর্ণ পরিশোধিত';
      this.notice.set({ kind: 'success', text: `রসিদ #${receipt.receiptId}: ${item.loan.customerName}-এর ৳${receipt.totalAmountCollected} আদায় হয়েছে${nextText}` });
      await this.loadSheetData();
    } catch (err: any) {
      console.error('Error collecting in daily sheet:', err);
      this.collectError.set(err?.message || 'কালেকশন সম্পন্ন করতে সমস্যা হয়েছে');
    } finally {
      this.isProcessing.set(false);
    }
  }

  // ---------- হাজিরা ----------

  // ---------- শুধু সঞ্চয় জমা ----------

  openSavingsModal(item: DailySheetItem) {
    this.savingsItem.set(item);
    this.savingsAmount.set(item.loan.savingsPerInstallment || 0);
    this.savingsMethod.set('CASH');
    this.savingsError.set('');
  }

  closeSavingsModal() {
    if (!this.savingsBusy()) this.savingsItem.set(null);
  }

  async confirmSavingsDeposit() {
    const item = this.savingsItem();
    const amount = Number(this.savingsAmount()) || 0;
    if (!item || amount <= 0) {
      this.savingsError.set('সঠিক পরিমাণ দিন');
      return;
    }
    const u = this.authService.currentUser();
    this.savingsBusy.set(true);
    this.savingsError.set('');
    try {
      const txn = await this.cashService.recordSavings({
        customerId: item.loan.customerId, type: 'DEPOSIT', amount, isCredit: true,
        paymentMethod: this.savingsMethod(), channel: 'FIELD',
        reason: `মাঠে সঞ্চয় জমা (সমিতি ${this.centerName()})`
      }, { userId: u.userId, name: u.name, role: u.role });
      this.savingsItem.set(null);
      this.notice.set({ kind: 'success', text: `${txn.receiptNo}: ${item.loan.customerName}-এর সঞ্চয় ৳${amount.toLocaleString('en-IN')} জমা হয়েছে (নতুন স্থিতি ৳${txn.newBalance.toLocaleString('en-IN')}) — টাকা আপনার হাতে, ক্যাশিয়ারকে জমা দিন` });
      await this.loadSheetData();
    } catch (err: any) {
      this.savingsError.set(err?.message || 'সঞ্চয় জমা করা যায়নি');
    } finally {
      this.savingsBusy.set(false);
    }
  }

  togglePresent(customerId: number) {
    const next = new Set(this.present());
    if (next.has(customerId)) next.delete(customerId); else next.add(customerId);
    this.present.set(next);
    this.attendanceSaved.set(false);
  }

  async saveAttendance() {
    const center = this.filteredCenters().find(c => c.centerId === this.selectedCenterId());
    if (!center) return;
    const memberIds = [...new Set(this.sheetItems().map(i => i.loan.customerId))];
    const present = this.present();
    const user = this.authService.currentUser();
    try {
      await this.memberService.saveAttendance({
        centerId: center.centerId, branchId: center.branchId, date: this.today,
        presentCustomerIds: memberIds.filter(id => present.has(id)),
        absentCustomerIds: memberIds.filter(id => !present.has(id))
      }, { userId: user.userId, name: user.name, role: user.role });
      this.attendanceSaved.set(true);
      this.notice.set({ kind: 'success', text: `হাজিরা সংরক্ষিত: ${memberIds.filter(id => present.has(id)).length}/${memberIds.length} জন উপস্থিত` });
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'হাজিরা সংরক্ষণ করা যায়নি' });
    }
  }

  printSheet() {
    this.printing.set(true);
    setTimeout(() => {
      window.print();
      this.printing.set(false);
    }, 50);
  }

  /** দেয় কিস্তির নম্বর সংক্ষেপে: ধারাবাহিক হলে "#৩–#৩২", না হলে "#৩, #৫"; সাথে মোট সংখ্যা */
  dueNos(item: DailySheetItem): string {
    const nos = item.view.dueInstallments.map(i => i.installmentNo).sort((a, b) => a - b);
    if (nos.length === 0) return '';
    const ranges: string[] = [];
    let start = nos[0], prev = nos[0];
    for (const n of [...nos.slice(1), Number.NaN]) {
      if (n === prev + 1) { prev = n; continue; }
      ranges.push(start === prev ? `#${this.bn(start)}` : `#${this.bn(start)}–#${this.bn(prev)}`);
      start = prev = n;
    }
    const text = ranges.length > 2 ? `${ranges.slice(0, 2).join(', ')} …` : ranges.join(', ');
    return nos.length > 1 ? `${text} (${this.bn(nos.length)}টি)` : text;
  }

  /** হোভারে পূর্ণ তালিকা */
  dueNosFull(item: DailySheetItem): string {
    return 'দেয় কিস্তি নং: ' + item.view.dueInstallments.map(i => i.installmentNo).sort((a, b) => a - b).join(', ');
  }

  private bn(n: number): string {
    return String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[Number(d)]);
  }

  centerName(): string {
    return this.filteredCenters().find(c => c.centerId === this.selectedCenterId())?.name || '';
  }

  getTotalExpectedToday(): number {
    return this.sheetItems().reduce((sum, item) => sum + item.view.dueAmount + item.view.dueSavings, 0);
  }

  getTotalCollectedToday(): number {
    return this.sheetItems().reduce((sum, item) => sum + item.collectedTodayAmount, 0);
  }
}
