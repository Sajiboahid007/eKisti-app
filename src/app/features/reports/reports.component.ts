import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  Branch, CenterOrSamity, Customer, InstallmentSchedule, JournalEntry, Loan, PaymentCollection, UserStaff, VaultTransaction
} from '../../core/models/database.models';
import { AuthStateService } from '../../core/services/auth-state.service';
import { CashService } from '../../core/services/cash.service';
import { KistiDatabaseService } from '../../core/services/kisti-database.service';
import { addDaysKey, toDhakaDayKey, todayDhaka } from '../../core/finance/dates';
import { remainingOf } from '../../core/finance/allocation';
import { CLASSIFICATION_RULES, loanOverdueState, outstandingPrincipal, portfolioQuality, recoveryRates } from '../../core/finance/classification';
import { CHART_OF_ACCOUNTS, accountName } from '../../core/finance/accounts';
import { SkeletonComponent } from '../../shared/components/skeleton/skeleton.component';

type ReportTab = 'DAILY' | 'DUE' | 'PORTFOLIO' | 'DAYBOOK' | 'TRIAL' | 'MIS';

const TAB_LABELS: Record<ReportTab, { label: string; icon: string }> = {
  DAILY: { label: 'দৈনিক আদায়', icon: 'payments' },
  DUE: { label: 'দেয় ও বকেয়া তালিকা', icon: 'warning' },
  PORTFOLIO: { label: 'পোর্টফোলিও ও শ্রেণীকরণ', icon: 'donut_large' },
  DAYBOOK: { label: 'দিনের হিসাব / ক্যাশ বই', icon: 'menu_book' },
  TRIAL: { label: 'ট্রায়াল ব্যালেন্স', icon: 'balance' },
  MIS: { label: 'শাখা MIS', icon: 'domain' }
};

const VAULT_TYPE_LABELS: Record<string, string> = {
  OPENING: 'প্রারম্ভিক স্থিতি', CLOSING_IN: 'মাঠকর্মীর ক্যাশ জমা', DISBURSEMENT_OUT: 'ঋণ বিতরণ', FEE_IN: 'ফি জমা',
  SAVINGS_DEPOSIT_IN: 'সঞ্চয় জমা', SAVINGS_WITHDRAW_OUT: 'সঞ্চয় উত্তোলন', BANK_DEPOSIT: 'ব্যাংকে জমা', BANK_WITHDRAW: 'ব্যাংক থেকে উত্তোলন',
  EXPENSE: 'খরচ', HO_TRANSFER_IN: 'প্রধান কার্যালয় থেকে', HO_TRANSFER_OUT: 'প্রধান কার্যালয়ে', ADJUSTMENT: 'সমন্বয়'
};

export interface CollectionAgg {
  key: number;
  name: string;
  count: number;
  kisti: number;
  savings: number;
  total: number;
  cash: number;
  digital: number;
  handedOver: number;
  pending: number;
}

export interface DueRow {
  loan: Loan;
  customer: Customer | undefined;
  centerName: string;
  foName: string;
  dueToday: number;
  overdueAmount: number;
  missed: number;
  daysPastDue: number;
}

export interface TrialRow {
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
}

export interface MisRow {
  branch: Branch;
  members: number;
  activeBorrowers: number;
  outstandingPrincipal: number;
  disbursed: number;
  disbursedCount: number;
  collected: number;
  par30Percent: number;
  vaultCash: number;
}

const ACTIVE = (l: Loan) => !l.isDeleted && (l.status === 'DISBURSED' || l.status === 'OVERDUE');

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, SkeletonComponent],
  templateUrl: './reports.component.html',
  styleUrl: './reports.component.scss'
})
export class ReportsComponent implements OnInit {
  private cash = inject(CashService);
  private kisti = inject(KistiDatabaseService);
  readonly auth = inject(AuthStateService);

  readonly today = todayDhaka();
  readonly tabLabels = TAB_LABELS;
  readonly rules = CLASSIFICATION_RULES;

  // ---- ভিত্তি তথ্য ----
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly staff = signal<UserStaff[]>([]);
  readonly customers = signal<Customer[]>([]);
  readonly loans = signal<Loan[]>([]);
  readonly installments = signal<InstallmentSchedule[] | null>(null);

  // ---- ফিল্টার ----
  readonly tab = signal<ReportTab>('DAILY');
  readonly branchId = signal<number>(0);           // 0 = সব (প্রবেশযোগ্য) শাখা
  readonly centerId = signal<number>(0);
  readonly onlyOverdue = signal<boolean>(false);
  readonly date = signal<string>(this.today);
  readonly from = signal<string>(addDaysKey(this.today, -29));
  readonly to = signal<string>(this.today);

  // ---- রিপোর্ট ডেটা ----
  readonly dailyReceipts = signal<PaymentCollection[]>([]);
  readonly vaultRows = signal<VaultTransaction[]>([]);
  readonly journals = signal<JournalEntry[]>([]);
  readonly rangeReceipts = signal<PaymentCollection[]>([]);

  readonly baseLoading = signal<boolean>(true);
  readonly loading = signal<boolean>(false);
  readonly notice = signal<{ kind: 'success' | 'info' | 'warning' | 'danger'; text: string } | null>(null);

  readonly isFO = computed(() => this.auth.isFieldOfficer());
  readonly userId = computed(() => this.auth.currentUser().userId);

  readonly tabs = computed<ReportTab[]>(() =>
    this.isFO() ? ['DAILY', 'DUE', 'PORTFOLIO', 'MIS'] : ['DAILY', 'DUE', 'PORTFOLIO', 'DAYBOOK', 'TRIAL', 'MIS']
  );

  readonly branchMap = computed(() => new Map(this.branches().map(b => [b.branchId, b])));
  readonly centerMap = computed(() => new Map(this.centers().map(c => [c.centerId, c])));
  readonly staffMap = computed(() => new Map(this.staff().map(s => [s.userId, s])));
  readonly customerMap = computed(() => new Map(this.customers().map(c => [c.customerId, c])));

  readonly selectedBranch = computed(() => this.branchMap().get(this.branchId()) || null);
  readonly branchLabel = computed(() => this.selectedBranch()?.name || 'সকল শাখা');
  readonly filterCenters = computed(() => this.centers().filter(c => this.inBranchFilter(c.branchId)));

  /** ঋণের ব্যবহারকারী-স্কোপ (শাখা প্রবেশাধিকার + মাঠকর্মী নিজের) — শাখা ফিল্টার ছাড়া */
  readonly scopedLoans = computed(() => this.loans().filter(l =>
    this.auth.canAccessBranch(l.branchId) && (!this.isFO() || Number(l.fieldOfficerUserId) === this.userId())
  ));

  readonly scopedActiveLoans = computed(() => this.scopedLoans().filter(ACTIVE));

  readonly instByLoan = computed(() => {
    const map = new Map<number, InstallmentSchedule[]>();
    for (const i of this.installments() || []) {
      const list = map.get(i.loanId);
      if (list) list.push(i); else map.set(i.loanId, [i]);
    }
    return map;
  });

  /** কিস্তি থেকে হালনাগাদ বকেয়া দিন (রাত্রিকালীন ইঞ্জিনের পুরাতন মান থাকলেও সঠিক) */
  readonly activeLoansWithDpd = computed<Loan[]>(() => {
    const byLoan = this.instByLoan();
    const hasInst = this.installments() !== null;
    return this.scopedActiveLoans().map(l => {
      const list = byLoan.get(l.loanId);
      if (!hasInst || !list) return l;
      return { ...l, daysPastDue: loanOverdueState(list, this.today).daysPastDue };
    });
  });

  // =====================================================================
  // ১. দৈনিক আদায়
  // =====================================================================
  readonly dailyScoped = computed(() => this.dailyReceipts().filter(r =>
    !r.isReversed && !r.isDeleted && this.inBranchFilter(r.branchId) &&
    (!this.isFO() || Number(r.collectedByUserId) === this.userId())
  ));

  readonly dailyByOfficer = computed(() => this.aggregate(this.dailyScoped(), r => r.collectedByUserId,
    (id, r) => this.staffMap().get(id)?.name || r.collectedByName || `#${id}`));

  readonly dailyByCenter = computed(() => this.aggregate(this.dailyScoped(), r => r.centerId,
    id => this.centerMap().get(id)?.name || `সমিতি #${id}`));

  readonly dailyTotal = computed(() => this.sumAgg(this.dailyByOfficer()));

  // =====================================================================
  // ২. দেয় ও বকেয়া
  // =====================================================================
  readonly dueRows = computed<DueRow[]>(() => {
    const byLoan = this.instByLoan();
    const rows: DueRow[] = [];
    for (const loan of this.scopedActiveLoans()) {
      if (!this.inBranchFilter(loan.branchId)) continue;
      if (this.centerId() && Number(loan.centerId) !== this.centerId()) continue;
      const list = byLoan.get(loan.loanId) || [];
      const od = loanOverdueState(list, this.today);
      const dueToday = list.filter(i => !i.isDeleted && i.dueDate === this.today).reduce((s, i) => s + remainingOf(i).total, 0);
      if (od.overdueAmount <= 0 && dueToday <= 0) continue;
      if (this.onlyOverdue() && od.overdueAmount <= 0) continue;
      rows.push({
        loan,
        customer: this.customerMap().get(loan.customerId),
        centerName: this.centerMap().get(loan.centerId)?.name || `#${loan.centerId}`,
        foName: this.staffMap().get(loan.fieldOfficerUserId)?.name || `#${loan.fieldOfficerUserId}`,
        dueToday,
        overdueAmount: od.overdueAmount,
        missed: od.missedInstallmentsCount,
        daysPastDue: od.daysPastDue
      });
    }
    return rows.sort((a, b) => b.daysPastDue - a.daysPastDue || b.overdueAmount - a.overdueAmount);
  });

  readonly dueTotals = computed(() => {
    const rows = this.dueRows();
    return {
      dueToday: rows.reduce((s, r) => s + r.dueToday, 0),
      overdue: rows.reduce((s, r) => s + r.overdueAmount, 0),
      overdueLoans: rows.filter(r => r.overdueAmount > 0).length
    };
  });

  // =====================================================================
  // ৩. পোর্টফোলিও
  // =====================================================================
  readonly pq = computed(() => portfolioQuality(this.activeLoansWithDpd().filter(l => this.inBranchFilter(l.branchId))));

  readonly rates = computed(() => {
    const ids = new Set(this.scopedActiveLoans().filter(l => this.inBranchFilter(l.branchId)).map(l => l.loanId));
    return recoveryRates((this.installments() || []).filter(i => ids.has(i.loanId)), this.today, toDhakaDayKey);
  });

  // =====================================================================
  // ৪. ক্যাশ বই
  // =====================================================================
  readonly daybook = computed(() => {
    const rows = this.vaultRows();
    let inn = 0, out = 0;
    for (const v of rows) { if (v.direction === 'IN') inn += v.amount; else out += v.amount; }
    const opening = rows.length ? rows[0].balanceBefore : (this.selectedBranch()?.currentVaultCash || 0);
    const closing = rows.length ? rows[rows.length - 1].balanceAfter : opening;
    return { opening, inn, out, closing, computedClosing: opening + inn - out };
  });

  // =====================================================================
  // ৫. ট্রায়াল ব্যালেন্স
  // =====================================================================
  readonly trialRows = computed<TrialRow[]>(() => {
    const map = new Map<string, TrialRow>();
    for (const j of this.journals()) {
      if (!this.auth.canAccessBranch(j.branchId)) continue;
      for (const l of j.lines || []) {
        let row = map.get(l.account);
        if (!row) {
          const def = CHART_OF_ACCOUNTS.find(a => a.code === l.account);
          row = { code: l.account, name: accountName(l.account), type: def?.type || '—', debit: 0, credit: 0 };
          map.set(l.account, row);
        }
        row.debit += Number(l.debit) || 0;
        row.credit += Number(l.credit) || 0;
      }
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code));
  });

  readonly trialTotals = computed(() => {
    const debit = this.round(this.trialRows().reduce((s, r) => s + r.debit, 0));
    const credit = this.round(this.trialRows().reduce((s, r) => s + r.credit, 0));
    return { debit, credit, diff: this.round(debit - credit), balanced: Math.abs(debit - credit) < 0.01 };
  });

  readonly incomeStatement = computed(() => {
    const income = this.trialRows().filter(r => r.type === 'INCOME').map(r => ({ ...r, net: this.round(r.credit - r.debit) }));
    const expense = this.trialRows().filter(r => r.type === 'EXPENSE').map(r => ({ ...r, net: this.round(r.debit - r.credit) }));
    const totalIncome = income.reduce((s, r) => s + r.net, 0);
    const totalExpense = expense.reduce((s, r) => s + r.net, 0);
    return { income, expense, totalIncome, totalExpense, surplus: this.round(totalIncome - totalExpense) };
  });

  // =====================================================================
  // ৬. শাখা MIS
  // =====================================================================
  readonly misRows = computed<MisRow[]>(() => {
    const from = this.from(), to = this.to();
    return this.branches().filter(b => this.inBranchFilter(b.branchId)).map(b => {
      const bid = b.branchId;
      const members = this.customers().filter(c => Number(c.branchId) === bid &&
        (!this.isFO() || Number(c.assignedFieldOfficerId) === this.userId())).length;
      const active = this.activeLoansWithDpd().filter(l => Number(l.branchId) === bid);
      const disbursedLoans = this.scopedLoans().filter(l => Number(l.branchId) === bid && !!l.disbursementDate &&
        l.status !== 'CANCELLED' && l.status !== 'REJECTED' && l.status !== 'APPLIED' && l.status !== 'FIELD_VERIFIED' && l.status !== 'APPROVED' &&
        this.inRange(toDhakaDayKey(l.disbursementDate), from, to));
      const collected = this.rangeReceipts().filter(r => !r.isReversed && !r.isDeleted && Number(r.branchId) === bid &&
        (!this.isFO() || Number(r.collectedByUserId) === this.userId()));
      return {
        branch: b,
        members,
        activeBorrowers: new Set(active.map(l => l.customerId)).size,
        outstandingPrincipal: active.reduce((s, l) => s + outstandingPrincipal(l), 0),
        disbursed: disbursedLoans.reduce((s, l) => s + (l.principalAmount || 0), 0),
        disbursedCount: disbursedLoans.length,
        collected: collected.reduce((s, r) => s + (r.totalAmountCollected || 0), 0),
        par30Percent: portfolioQuality(active).par30Percent,
        vaultCash: b.currentVaultCash || 0
      };
    });
  });

  readonly misTotals = computed(() => {
    const rows = this.misRows();
    const sum = (f: (r: MisRow) => number) => rows.reduce((s, r) => s + f(r), 0);
    return {
      members: sum(r => r.members), activeBorrowers: sum(r => r.activeBorrowers), outstandingPrincipal: sum(r => r.outstandingPrincipal),
      disbursed: sum(r => r.disbursed), disbursedCount: sum(r => r.disbursedCount), collected: sum(r => r.collected),
      par30Percent: portfolioQuality(this.activeLoansWithDpd().filter(l => this.inBranchFilter(l.branchId))).par30Percent,
      vaultCash: sum(r => r.vaultCash)
    };
  });

  // =====================================================================
  // লোডিং
  // =====================================================================
  async ngOnInit() {
    this.baseLoading.set(true);
    try {
      const [branches, centers, staff, customers, loans] = await Promise.all([
        this.kisti.getBranches(), this.kisti.getCenters(), this.kisti.getStaff(), this.kisti.getCustomers(), this.kisti.getLoans()
      ]);
      const accessible = branches.filter(b => this.auth.canAccessBranch(b.branchId));
      this.branches.set(accessible);
      this.centers.set(centers.filter(c => this.auth.canAccessBranch(c.branchId) &&
        (!this.isFO() || Number(c.fieldOfficerUserId) === this.userId() || (this.auth.currentUser().assignedCenterIds || []).includes(c.centerId))));
      this.staff.set(staff);
      this.customers.set(customers.filter(c => this.auth.canAccessBranch(c.branchId)));
      this.loans.set(loans);
      if (accessible.length === 1) this.branchId.set(accessible[0].branchId);
      else {
        const own = accessible.find(b => b.branchId === this.auth.currentUser().branchId);
        if (own) this.branchId.set(own.branchId);
      }
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'ভিত্তি তথ্য লোড করা যায়নি' });
    } finally {
      this.baseLoading.set(false);
    }
    await this.loadTab();
  }

  setTab(t: ReportTab) {
    this.tab.set(t);
    this.notice.set(null);
    void this.loadTab();
  }

  onBranchChange(id: number) {
    this.branchId.set(Number(id) || 0);
    this.centerId.set(0);
    const t = this.tab();
    if (t === 'DAYBOOK' || t === 'TRIAL') void this.loadTab();
  }

  setRange(days: number) {
    this.to.set(this.today);
    this.from.set(addDaysKey(this.today, -days));
    void this.loadTab();
  }

  async loadTab() {
    if (this.baseLoading()) return;
    this.loading.set(true);
    try {
      switch (this.tab()) {
        case 'DAILY':
          this.dailyReceipts.set(await this.cash.receiptsBetween(this.date(), this.date()));
          break;
        case 'DUE':
        case 'PORTFOLIO':
          await this.ensureInstallments();
          break;
        case 'DAYBOOK':
          if (!this.validRange()) break;
          if (!this.branchId()) { this.vaultRows.set([]); break; }
          this.vaultRows.set(await this.cash.getVaultTransactions(this.branchId(), this.from(), this.to()));
          break;
        case 'TRIAL':
          if (!this.validRange()) break;
          this.journals.set(await this.cash.getJournalEntries(this.branchId() || null, this.from(), this.to()));
          break;
        case 'MIS': {
          if (!this.validRange()) break;
          const [receipts] = await Promise.all([this.cash.receiptsBetween(this.from(), this.to()), this.ensureInstallments()]);
          this.rangeReceipts.set(receipts);
          break;
        }
      }
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'রিপোর্ট লোড করা যায়নি' });
    } finally {
      this.loading.set(false);
    }
  }

  async refresh() {
    this.installments.set(null);
    this.notice.set(null);
    await this.ngOnInit();
  }

  private async ensureInstallments() {
    if (this.installments() !== null) return;
    const ids = this.scopedActiveLoans().map(l => l.loanId);
    this.installments.set(ids.length ? await this.kisti.getInstallmentsByLoanIds(ids) : []);
  }

  private validRange(): boolean {
    if (this.from() > this.to()) {
      this.notice.set({ kind: 'warning', text: 'শুরুর তারিখ শেষের তারিখের পরে হতে পারে না।' });
      return false;
    }
    return true;
  }

  // =====================================================================
  // সহায়ক
  // =====================================================================
  private inBranchFilter(branchId: number): boolean {
    return this.auth.canAccessBranch(branchId) && (!this.branchId() || Number(branchId) === this.branchId());
  }

  private inRange(key: string, from: string, to: string): boolean {
    return key >= from && key <= to;
  }

  private round(n: number): number {
    return Math.round(n * 100) / 100;
  }

  private aggregate(list: PaymentCollection[], keyOf: (r: PaymentCollection) => number,
                    nameOf: (id: number, r: PaymentCollection) => string): CollectionAgg[] {
    const map = new Map<number, CollectionAgg>();
    for (const r of list) {
      const key = Number(keyOf(r)) || 0;
      let a = map.get(key);
      if (!a) {
        a = { key, name: nameOf(key, r), count: 0, kisti: 0, savings: 0, total: 0, cash: 0, digital: 0, handedOver: 0, pending: 0 };
        map.set(key, a);
      }
      const total = r.totalAmountCollected || 0;
      a.count++;
      a.kisti += (r.principalAmountCollected || 0) + (r.profitAmountCollected || 0);
      a.savings += r.savingsAmountCollected || 0;
      a.total += total;
      if (r.paymentMethod === 'CASH') a.cash += total; else a.digital += total;
      if (r.isHandedOverToBranch) a.handedOver += total; else a.pending += total;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }

  private sumAgg(rows: CollectionAgg[]): CollectionAgg {
    const t: CollectionAgg = { key: 0, name: 'মোট', count: 0, kisti: 0, savings: 0, total: 0, cash: 0, digital: 0, handedOver: 0, pending: 0 };
    for (const r of rows) {
      t.count += r.count; t.kisti += r.kisti; t.savings += r.savings; t.total += r.total;
      t.cash += r.cash; t.digital += r.digital; t.handedOver += r.handedOver; t.pending += r.pending;
    }
    return t;
  }

  typeLabel(type: string): string {
    return VAULT_TYPE_LABELS[type] || type;
  }

  pct(rate: number): number {
    return Math.round(rate * 10000) / 100;
  }

  periodLabel(): string {
    const t = this.tab();
    if (t === 'DAILY') return this.date();
    if (t === 'DUE' || t === 'PORTFOLIO') return `${this.today} পর্যন্ত`;
    return `${this.from()} — ${this.to()}`;
  }

  // =====================================================================
  // প্রিন্ট ও CSV
  // =====================================================================
  print() {
    window.print();
  }

  exportCsv() {
    const t = this.tab();
    const branch = this.selectedBranch()?.branchCode || 'ALL';
    const file = (name: string) => `${name}_${branch}_${this.periodLabel().replace(/[^0-9A-Za-z-]+/g, '_')}.csv`;
    const aggRows = (rows: CollectionAgg[]) => rows.map(r => [r.name, r.count, r.kisti, r.savings, r.total, r.cash, r.digital, r.handedOver, r.pending]);
    const aggHead = ['নাম', 'রসিদ', 'কিস্তি (আসল+লাভ)', 'সঞ্চয়', 'মোট', 'নগদ', 'ডিজিটাল', 'জমা দেওয়া', 'জমা বাকি'];

    switch (t) {
      case 'DAILY': {
        const tot = this.dailyTotal();
        this.downloadCsv(file('daily-collection'), [
          ['দৈনিক আদায় রিপোর্ট', this.branchLabel(), this.date()],
          [],
          ['মাঠকর্মী অনুযায়ী'], aggHead, ...aggRows(this.dailyByOfficer()),
          aggRows([tot])[0],
          [],
          ['সমিতি অনুযায়ী'], aggHead, ...aggRows(this.dailyByCenter()),
          aggRows([tot])[0]
        ]);
        break;
      }
      case 'DUE':
        this.downloadCsv(file('due-overdue'), [
          ['ঋণ হিসাব', 'সদস্য', 'মোবাইল', 'সমিতি', 'মাঠকর্মী', 'আজ দেয়', 'বকেয়া', 'বাদ পড়া কিস্তি', 'বকেয়া দিন',
            'প্রথম জামিনদার', 'জামিনদার মোবাইল', 'দ্বিতীয় জামিনদার', 'জামিনদার মোবাইল'],
          ...this.dueRows().map(r => [
            r.loan.loanAccountNo, r.customer?.fullName || r.loan.customerName, r.customer?.phonePrimary || '', r.centerName, r.foName,
            r.dueToday, r.overdueAmount, r.missed, r.daysPastDue,
            r.customer?.primaryGuarantor?.name || '', r.customer?.primaryGuarantor?.phone || '',
            r.customer?.secondaryGuarantor?.name || '', r.customer?.secondaryGuarantor?.phone || ''
          ])
        ]);
        break;
      case 'PORTFOLIO': {
        const q = this.pq(), r = this.rates();
        this.downloadCsv(file('portfolio-quality'), [
          ['শ্রেণী', 'বকেয়া দিন', 'ঋণ সংখ্যা', 'বাকি আসল', 'সঞ্চিতি হার %', 'সঞ্চিতি'],
          ...q.byClass.map(b => [b.rule.labelBn, this.dayRange(b.rule.minDays, b.rule.maxDays), b.loans, b.outstanding, this.pct(b.rule.provisionRate), b.provision]),
          ['মোট', '', q.loansCount, q.outstandingPrincipal, '', q.requiredProvision],
          [],
          ['PAR>1 টাকা', q.par1Amount, 'PAR>1 %', q.par1Percent],
          ['PAR>30 টাকা', q.par30Amount, 'PAR>30 %', q.par30Percent],
          ['OTR %', r.otrPercent, 'CRR %', r.crrPercent]
        ]);
        break;
      }
      case 'DAYBOOK': {
        const d = this.daybook();
        this.downloadCsv(file('day-book'), [
          ['নং', 'তারিখ', 'বিবরণ', 'নোট', 'স্লিপ', 'জমা', 'খরচ/বের', 'স্থিতি', 'কর্মী'],
          ['', '', 'প্রারম্ভিক স্থিতি', '', '', '', '', d.opening, ''],
          ...this.vaultRows().map(v => [
            v.vaultTransactionId, v.businessDate, this.typeLabel(v.type), v.note || '', v.slipNo || '',
            v.direction === 'IN' ? v.amount : '', v.direction === 'OUT' ? v.amount : '', v.balanceAfter, v.createdBy?.name || ''
          ]),
          ['', '', 'মোট', '', '', d.inn, d.out, d.closing, '']
        ]);
        break;
      }
      case 'TRIAL': {
        const tt = this.trialTotals(), is = this.incomeStatement();
        this.downloadCsv(file('trial-balance'), [
          ['খাত কোড', 'খাতের নাম', 'ধরন', 'ডেবিট', 'ক্রেডিট'],
          ...this.trialRows().map(r => [r.code, r.name, r.type, r.debit, r.credit]),
          ['', 'মোট', '', tt.debit, tt.credit],
          [],
          ['আয়-ব্যয় বিবরণী'],
          ...is.income.map(r => [r.code, r.name, 'আয়', r.net]),
          ['', 'মোট আয়', '', is.totalIncome],
          ...is.expense.map(r => [r.code, r.name, 'ব্যয়', r.net]),
          ['', 'মোট ব্যয়', '', is.totalExpense],
          ['', 'নিট উদ্বৃত্ত / (ঘাটতি)', '', is.surplus]
        ]);
        break;
      }
      case 'MIS': {
        const tot = this.misTotals();
        this.downloadCsv(file('branch-mis'), [
          ['শাখা', 'সদস্য', 'সক্রিয় ঋণগ্রহীতা', 'বাকি আসল', 'বিতরণ (সংখ্যা)', 'বিতরণ (টাকা)', 'আদায়', 'PAR>30 %', 'ভল্ট নগদ'],
          ...this.misRows().map(r => [r.branch.name, r.members, r.activeBorrowers, r.outstandingPrincipal, r.disbursedCount, r.disbursed, r.collected, r.par30Percent, r.vaultCash]),
          ['মোট', tot.members, tot.activeBorrowers, tot.outstandingPrincipal, tot.disbursedCount, tot.disbursed, tot.collected, tot.par30Percent, tot.vaultCash]
        ]);
        break;
      }
    }
  }

  dayRange(min: number, max: number): string {
    if (max >= Number.MAX_SAFE_INTEGER) return `${min}+`;
    return min === max ? `${min}` : `${min}–${max}`;
  }

  /** UTF-8 BOM সহ CSV — Excel-এ বাংলা ঠিকভাবে দেখায় */
  private downloadCsv(filename: string, rows: (string | number)[][]) {
    const esc = (v: string | number) => {
      if (typeof v === 'number') return String(v);
      let s = v ?? '';
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // স্প্রেডশিট ফর্মুলা ইনজেকশন প্রতিরোধ
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = '﻿' + rows.map(r => r.map(esc).join(',')).join('\r\n');
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.notice.set({ kind: 'success', text: `${filename} ডাউনলোড হয়েছে।` });
  }
}
