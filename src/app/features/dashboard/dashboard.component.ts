import { Component, computed, DestroyRef, effect, inject, OnInit, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Firestore, collection, getDocs, query, where, QueryConstraint } from '@angular/fire/firestore';
import { AuthStateService } from '../../core/services/auth-state.service';
import { OverdueEngineService, OverdueRunResult } from '../../core/services/overdue-engine.service';
import { SettingsService, DEFAULT_GENERAL_SETTINGS } from '../../core/services/settings.service';
import { addDaysKey, dayOfWeekKey, formatBnDate, todayDhaka, toDhakaDayKey } from '../../core/finance/dates';
import { isSettledStatus, remainingOf } from '../../core/finance/allocation';
import { FieldCashBreakdown, fieldCashBreakdown } from '../../core/finance/field-cash';
import { portfolioQuality } from '../../core/finance/classification';
import { LanguageService } from '../../core/services/language.service';
import {
  Branch, CenterOrSamity, Customer, InstallmentSchedule, Loan, LoanProduct, PaymentCollection
} from '../../core/models/database.models';

// গত কত দিনের আদায় বনাম বিতরণ ট্রেন্ড দেখানো হবে
const TREND_DAYS = 7;
// Firestore 'in' কোয়েরিতে সর্বোচ্চ ৩০টি মান দেওয়া যায়
const IN_QUERY_LIMIT = 30;

export interface TrendPoint {
  dateKey: string;
  label: string;
  collected: number;
  disbursed: number;
}

export interface OfficerProgress {
  userId: number;
  name: string;
  target: number;
  collected: number;
  percent: number;
}

export interface SamityToday {
  center: CenterOrSamity;
  target: number;
  collected: number;
  percent: number;
}

/** মাঠকর্মীর আজকের রুটের একটি সমিতি */
export interface RouteStop extends SamityToday {
  /** কেন আজ যেতে হবে: মিটিং-বার, প্রতিদিন, বা কিস্তি দেয় */
  reason: 'MEETING' | 'DAILY' | 'DUE';
  dueMembers: number;
  dueRemaining: number;
  overdueLoans: number;
  overdueAmount: number;
}

/** আগামী দিনগুলোর রুট পরিকল্পনা */
export interface RouteDay {
  date: string;
  label: string;
  centers: CenterOrSamity[];
}

export interface HandoverQueueItem {
  userId: number;
  name: string;
  receiptsCount: number;
  amount: number;
  /** শুধু নগদ (CASH) রসিদ — মাঠকর্মীর হাতে থাকা টাকা */
  cashAmount: number;
  /** নগদ টাকা সাধারণ সেটিংসের foCashInHandLimit ছাড়িয়েছে */
  overLimit: boolean;
}

export interface OverdueFollowup {
  loan: Loan;
  phone: string;
  guarantorName: string;
  guarantorPhone: string;
}

/** আজ কিস্তি দেয় বা বকেয়া আছে এমন গ্রাহক (ড্যাশবোর্ড তালিকা) */
export interface DueCustomer {
  loan: Loan;
  phone: string;
  centerId: number;
  centerName: string;
  /** আজকের কিস্তির বাকি (আসল + লাভ + সঞ্চয়) */
  dueToday: number;
  /** আগের তারিখের জমে থাকা বকেয়া */
  overdue: number;
  total: number;
  isOverdue: boolean;
}

export interface ProductShare {
  productId: number;
  name: string;
  outstanding: number;
  percent: number;
}

/** তারিখ-স্ট্রিং (শুধু তারিখ অথবা পূর্ণ ISO) কে ঢাকার (Asia/Dhaka) দিনের কী-তে রূপান্তর */
function toDayKey(value: string | undefined | null): string {
  if (!value) return '';
  if (value.length === 10) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? value.slice(0, 10) : toDhakaDayKey(d);
}

/** dayOfWeekKey (0 = রবিবার) → CenterOrSamity.meetingDay নাম */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const ACTIVE_LOAN_STATUSES = ['DISBURSED', 'OVERDUE'];
const PENDING_APPROVAL_STATUSES = ['APPLIED', 'FIELD_VERIFIED'];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss'
})
export class DashboardComponent implements OnInit {
  /** প্রতিষ্ঠানের নাম/ঠিকানা (সেটিংস → প্রতিষ্ঠান) */
  readonly org = inject(SettingsService).org;
  private firestore = inject(Firestore);
  private destroyRef = inject(DestroyRef);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly loading = signal<boolean>(true);
  readonly lastUpdated = signal<Date | null>(null);
  readonly isOnline = signal<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);

  // শাখা ফিল্টার (0 = অনুমোদিত সকল শাখা)
  readonly branches = signal<Branch[]>([]);
  readonly selectedBranchId = signal<number>(0);

  // কাঁচা ডেটা (রোল অনুযায়ী স্কোপ করা)
  private readonly loans = signal<Loan[]>([]);
  private readonly todayInstallments = signal<InstallmentSchedule[]>([]);
  private readonly windowCollections = signal<PaymentCollection[]>([]);
  private readonly unhandedCollections = signal<PaymentCollection[]>([]);
  private readonly customers = signal<Customer[]>([]);
  private readonly centers = signal<CenterOrSamity[]>([]);
  private readonly products = signal<LoanProduct[]>([]);

  readonly todayKey = signal<string>(todayDhaka());

  // বকেয়া ইঞ্জিন ও মাঠকর্মীর নগদ সীমা
  private readonly overdueEngine = inject(OverdueEngineService);
  private readonly settingsService = inject(SettingsService);
  private overdueAutoRunDone = false;
  readonly overdueRunning = signal<boolean>(false);
  readonly overdueResult = signal<OverdueRunResult | null>(null);
  readonly overdueError = signal<string>('');
  readonly foCashLimit = signal<number>(DEFAULT_GENERAL_SETTINGS.foCashInHandLimit);

  /** একই URL-এ রোল বদলালে রাউটার কম্পোনেন্ট পুনরায় লোড করে না — তাই নিজে থেকেই নতুন ব্যবহারকারীর ডেটা আনা হয় */
  private loadedForUserId: number | null = null;
  /** পুরোনো (আগের রোলের) লোড দেরিতে শেষ হলে নতুন ডেটা যেন মুছে না দেয় */
  private loadSeq = 0;

  constructor() {
    effect(() => {
      const userId = this.authService.currentUser().userId;
      untracked(() => {
        if (this.loadedForUserId === null || this.loadedForUserId === userId) return;
        this.selectedBranchId.set(0);
        this.overdueResult.set(null);
        this.overdueAutoRunDone = false;
        void this.loadDashboardData().then(() => this.autoRunOverdueEngine());
      });
    });
  }

  // UI টগল
  readonly showTrendTable = signal<boolean>(false);
  readonly hoveredTrendIndex = signal<number | null>(null);
  readonly showPrintSummary = signal<boolean>(false);

  // ==========================================
  // রোল ও স্কোপ
  // ==========================================

  /** শাখা ড্রপডাউন কেবল একাধিক শাখা দেখার অনুমতি থাকলে দেখাবে */
  readonly switchableBranches = computed(() =>
    this.branches().filter(b => this.authService.canAccessBranch(b.branchId))
  );
  readonly canSwitchBranch = computed(() =>
    this.authService.accessibleBranchIds() === null || this.switchableBranches().length > 1
  );

  /** কার্যকর শাখা তালিকা। null = সকল শাখা */
  readonly scopeBranchIds = computed<number[] | null>(() => {
    const selected = this.selectedBranchId();
    if (selected > 0 && this.authService.canAccessBranch(selected)) return [selected];
    return this.authService.accessibleBranchIds();
  });

  readonly scopeLabel = computed(() => {
    const ids = this.scopeBranchIds();
    if (ids === null) return this.lang.isBangla() ? 'সকল শাখা' : 'All Branches';
    const names = this.branches().filter(b => ids.includes(b.branchId)).map(b => b.name);
    if (names.length > 0) return names.join(', ');
    return this.authService.currentUser().branchName;
  });

  private readonly isFieldOfficerScope = computed(() => this.authService.isFieldOfficer());

  // ==========================================
  // KPI
  // ==========================================

  private readonly todayCollections = computed(() =>
    this.windowCollections().filter(c => toDayKey(c.collectionDate) === this.todayKey())
  );

  readonly todayCollectedAmount = computed(() => this.sum(this.todayCollections(), c => c.totalAmountCollected));
  readonly todaySavingsCollected = computed(() => this.sum(this.todayCollections(), c => c.savingsAmountCollected));
  /** শুধু কিস্তির আসল + লাভ (ফি / সঞ্চয়-জমা রসিদ বাদ) */
  readonly todayKistiCollected = computed(() => this.sum(this.todayCollections(), c => (c.principalAmountCollected || 0) + (c.profitAmountCollected || 0)));
  readonly todayExpectedTarget = computed(() => this.sum(this.todayInstallments(), i => i.expectedTotalAmount));

  /** আদায় কার্যকারিতা (%) = আজকের আদায় ÷ আজকের টার্গেট × ১০০ */
  readonly recoveryRate = computed(() => {
    const target = this.todayExpectedTarget();
    if (target <= 0) return null;
    return Math.min(100, (this.todayCollectedAmount() / target) * 100);
  });

  readonly recoveryTone = computed(() => {
    const rate = this.recoveryRate();
    if (rate === null) return 'neutral';
    if (rate >= 95) return 'good';
    if (rate >= 80) return 'warn';
    return 'bad';
  });

  private readonly activeLoans = computed(() => this.loans().filter(l => ACTIVE_LOAN_STATUSES.includes(l.status)));

  readonly activeLoansCount = computed(() => this.activeLoans().length);
  readonly totalOutstanding = computed(() => this.sum(this.activeLoans(), l => l.outstandingBalance));
  readonly overdueAmount = computed(() => this.sum(this.activeLoans(), l => l.overdueAmount));

  /** বকেয়া ইঞ্জিন কর্তৃক নির্ধারিত daysPastDue > 0 (পুরাতন ডেটায় OVERDUE / overdueAmount) ঋণ */
  readonly atRiskLoans = computed(() =>
    this.activeLoans().filter(l => (l.daysPastDue || 0) > 0 || l.status === 'OVERDUE' || (l.overdueAmount || 0) > 0)
  );
  /** PAR (Portfolio at Risk) — বাকি আসলের উপর, বকেয়া ইঞ্জিনের daysPastDue অনুযায়ী (MRA ধাঁচ) */
  readonly portfolio = computed(() => portfolioQuality(this.activeLoans()));
  readonly parPercent = computed(() => this.portfolio().par1Percent);
  readonly par30Percent = computed(() => this.portfolio().par30Percent);

  readonly totalSavingsBalance = computed(() => this.sum(this.customers(), c => c.totalSavingsBalance));

  /** মাঠকর্মীদের হাতে থাকা টাকা যা এখনও শাখায় জমা হয়নি */
  readonly fieldCash = computed(() =>
    this.sum(this.unhandedCollections().filter(c => c.paymentMethod === 'CASH' || !c.paymentMethod), c => c.totalAmountCollected)
  );

  readonly totalVaultCash = computed(() => {
    const ids = this.scopeBranchIds();
    return this.sum(this.branches().filter(b => ids === null || ids.includes(b.branchId)), b => b.currentVaultCash);
  });

  readonly pendingApprovalsCount = computed(() =>
    this.loans().filter(l => PENDING_APPROVAL_STATUSES.includes(l.status)).length
  );

  // ==========================================
  // রোল-ভিত্তিক উইজেট
  // ==========================================

  /** মাঠকর্মী: আজকের নির্ধারিত সমিতি ও প্রতিটির আদায় অগ্রগতি */
  readonly todaySamities = computed<SamityToday[]>(() => {
    const user = this.authService.currentUser();
    const weekday = WEEKDAY_NAMES[dayOfWeekKey(this.todayKey())];
    const mine = this.centers().filter(c =>
      (c.fieldOfficerUserId === user.userId || user.assignedCenterIds.includes(c.centerId)) &&
      (c.meetingDay === weekday || c.meetingDay === 'Daily') &&
      c.status !== 'INACTIVE'
    );
    return mine.map(center => {
      const target = this.sum(this.todayInstallments().filter(i => i.centerId === center.centerId), i => i.expectedTotalAmount);
      const collected = this.sum(this.todayCollections().filter(c => c.centerId === center.centerId), c => c.totalAmountCollected);
      return { center, target, collected, percent: this.percent(collected, target) };
    });
  });

  /** মাঠকর্মীর নিজের সমিতিগুলো */
  private readonly myCenters = computed(() => {
    const user = this.authService.currentUser();
    return this.centers().filter(c =>
      (c.fieldOfficerUserId === user.userId || (user.assignedCenterIds || []).includes(c.centerId)) && c.status !== 'INACTIVE');
  });

  /**
   * মাঠকর্মী: আজকের রুট — মিটিং-বারের সমিতি, দৈনিক সমিতি, এবং যেসব সমিতিতে আজ কিস্তি দেয়।
   * প্রতিটিতে দেয় সদস্য, বাকি টাকা, আদায় অগ্রগতি ও বকেয়া ঋণ; মিটিং সময় অনুযায়ী সাজানো।
   */
  readonly todayRoute = computed<RouteStop[]>(() => {
    const weekday = WEEKDAY_NAMES[dayOfWeekKey(this.todayKey())];
    const installments = this.todayInstallments();
    const stops: RouteStop[] = [];
    for (const center of this.myCenters()) {
      const insts = installments.filter(i => i.centerId === center.centerId);
      const open = insts.filter(i => !isSettledStatus(i.status));
      const reason: RouteStop['reason'] | null = center.meetingDay === 'Daily' ? 'DAILY'
        : center.meetingDay === weekday ? 'MEETING'
          : open.length > 0 ? 'DUE' : null;
      if (!reason) continue;
      const target = this.sum(insts, i => i.expectedTotalAmount);
      const collected = this.sum(this.todayCollections().filter(c => c.centerId === center.centerId), c => c.totalAmountCollected);
      const overdue = this.loans().filter(l => l.centerId === center.centerId && l.status === 'OVERDUE');
      stops.push({
        center, reason, target, collected,
        percent: this.percent(collected, target),
        dueMembers: new Set(open.map(i => i.customerId)).size,
        dueRemaining: this.sum(open, i => remainingOf(i).total + Math.max(0, (i.expectedSavings || 0) - (i.paidSavings || 0))),
        overdueLoans: overdue.length,
        overdueAmount: this.sum(overdue, l => l.overdueAmount)
      });
    }
    return stops.sort((a, b) => this.minutesOf(a.center.meetingTime) - this.minutesOf(b.center.meetingTime));
  });

  readonly routeTotals = computed(() => ({
    stops: this.todayRoute().length,
    members: this.sum(this.todayRoute(), s => s.dueMembers),
    remaining: this.sum(this.todayRoute(), s => s.dueRemaining),
    collected: this.sum(this.todayRoute(), s => s.collected)
  }));

  /** আগামী ৬ দিনের রুট (মিটিং-বার অনুযায়ী) */
  readonly weekPlan = computed<RouteDay[]>(() => {
    const days: RouteDay[] = [];
    for (let i = 1; i <= 6; i++) {
      const date = addDaysKey(this.todayKey(), i);
      const weekday = WEEKDAY_NAMES[dayOfWeekKey(date)];
      days.push({
        date,
        label: formatBnDate(date, true),
        centers: this.myCenters().filter(c => c.meetingDay === weekday || c.meetingDay === 'Daily')
      });
    }
    return days;
  });

  readonly todayLabel = computed(() => formatBnDate(this.todayKey()));

  /** মাঠকর্মী: আমার হাতে থাকা (ক্যাশিয়ারকে এখনো বুঝিয়ে না দেওয়া) টাকা — খাতভিত্তিক */
  readonly myFieldCash = computed<FieldCashBreakdown>(() => fieldCashBreakdown(this.unhandedCollections()));
  /** আগের দিনের টাকা এখনো ক্যাশিয়ারকে দেওয়া হয়নি (ঢাকার তারিখ অনুযায়ী) */
  readonly myCashStale = computed(() => {
    const oldest = this.myFieldCash().oldest;
    return !!oldest && toDhakaDayKey(oldest) < this.todayKey();
  });

  /** ক্যাশিয়ার: প্রতিটি মাঠকর্মীর হাতে খাতভিত্তিক টাকা */
  readonly fieldCashByOfficer = computed(() => {
    const map = new Map<number, FieldCashBreakdown>();
    const groups = new Map<number, PaymentCollection[]>();
    for (const r of this.unhandedCollections()) {
      const list = groups.get(r.collectedByUserId) || [];
      list.push(r);
      groups.set(r.collectedByUserId, list);
    }
    groups.forEach((list, id) => map.set(id, fieldCashBreakdown(list)));
    return map;
  });

  breakdownText(userId: number): string {
    const b = this.fieldCashByOfficer().get(userId);
    if (!b) return '';
    const parts = [
      b.kisti ? `কিস্তি ৳${b.kisti.toLocaleString('en-IN')}` : '',
      b.savings ? `সঞ্চয় ৳${b.savings.toLocaleString('en-IN')}` : '',
      b.fees ? `ফি ৳${b.fees.toLocaleString('en-IN')}` : '',
      b.recovery ? `অবলোপিত আদায় ৳${b.recovery.toLocaleString('en-IN')}` : ''
    ].filter(Boolean);
    return parts.join(' • ');
  }

  /** "10:30 AM" → মিনিট (সাজানোর জন্য) */
  private minutesOf(time: string | undefined): number {
    const m = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(time || '');
    if (!m) return 24 * 60;
    let h = Number(m[1]) % 12;
    if ((m[3] || '').toUpperCase() === 'PM') h += 12;
    if (!m[3] && Number(m[1]) === 12) h = 12;
    return h * 60 + Number(m[2]);
  }

  /** শাখা ব্যবস্থাপক: মাঠকর্মী অনুযায়ী আজকের টার্গেট বনাম আদায় */
  readonly officerLeaderboard = computed<OfficerProgress[]>(() => {
    const map = new Map<number, OfficerProgress>();
    const nameOf = (id: number, fallback?: string) =>
      fallback || this.authService.availableUsers().find(u => u.userId === id)?.name || `#${id}`;
    const entry = (id: number, name?: string) => {
      if (!map.has(id)) map.set(id, { userId: id, name: nameOf(id, name), target: 0, collected: 0, percent: 0 });
      return map.get(id)!;
    };
    this.todayInstallments().forEach(i => { if (i.fieldOfficerUserId) entry(i.fieldOfficerUserId).target += i.expectedTotalAmount || 0; });
    this.todayCollections().forEach(c => { if (c.collectedByUserId) entry(c.collectedByUserId, c.collectedByName).collected += c.totalAmountCollected || 0; });
    return [...map.values()]
      .map(o => ({ ...o, percent: this.percent(o.collected, o.target) }))
      .sort((a, b) => b.percent - a.percent || b.collected - a.collected);
  });

  /** ক্যাশিয়ার: কোন মাঠকর্মীর কাছে কত টাকা জমা দেওয়া বাকি */
  readonly handoverQueue = computed<HandoverQueueItem[]>(() => {
    const map = new Map<number, HandoverQueueItem>();
    this.unhandedCollections().forEach(c => {
      const item = map.get(c.collectedByUserId) ||
        { userId: c.collectedByUserId, name: c.collectedByName || `#${c.collectedByUserId}`, receiptsCount: 0, amount: 0, cashAmount: 0, overLimit: false };
      item.receiptsCount++;
      item.amount += c.totalAmountCollected || 0;
      if (c.paymentMethod === 'CASH' || !c.paymentMethod) item.cashAmount += c.totalAmountCollected || 0;
      map.set(c.collectedByUserId, item);
    });
    const limit = this.foCashLimit();
    return [...map.values()]
      .map(item => ({ ...item, overLimit: limit > 0 && item.cashAmount > limit }))
      .sort((a, b) => Number(b.overLimit) - Number(a.overLimit) || b.amount - a.amount);
  });

  /** নগদ সীমা অতিক্রমকারী মাঠকর্মী */
  readonly overLimitOfficers = computed(() => this.handoverQueue().filter(q => q.overLimit));

  /** সর্বোচ্চ বকেয়া ৫ জন গ্রাহক, ফোন ও জামিনদারসহ */
  readonly topDefaulters = computed<OverdueFollowup[]>(() => {
    const customerMap = new Map(this.customers().map(c => [c.customerId, c]));
    return this.atRiskLoans()
      .slice()
      .sort((a, b) => (b.overdueAmount || 0) - (a.overdueAmount || 0))
      .slice(0, 5)
      .map(loan => {
        const cust = customerMap.get(loan.customerId);
        return {
          loan,
          phone: cust?.phonePrimary || '',
          guarantorName: cust?.primaryGuarantor?.name || '',
          guarantorPhone: cust?.primaryGuarantor?.phone || ''
        };
      });
  });

  /**
   * আজ কিস্তি দেয় (নির্ধারিত তারিখ আজ, এখনো পরিশোধ হয়নি) অথবা বকেয়া আছে এমন গ্রাহক।
   * বকেয়া আগে, তারপর বেশি টাকা আগে।
   */
  readonly dueCustomers = computed<DueCustomer[]>(() => {
    const customerMap = new Map(this.customers().map(c => [c.customerId, c]));
    const centerMap = new Map(this.centers().map(c => [c.centerId, c.name]));
    const loanMap = new Map(this.activeLoans().map(l => [l.loanId, l]));
    const dueTodayByLoan = new Map<number, number>();
    for (const i of this.todayInstallments()) {
      if (isSettledStatus(i.status) || !loanMap.has(i.loanId)) continue;
      const amount = remainingOf(i).total + Math.max(0, (i.expectedSavings || 0) - (i.paidSavings || 0));
      dueTodayByLoan.set(i.loanId, (dueTodayByLoan.get(i.loanId) || 0) + amount);
    }
    const loanIds = new Set([...dueTodayByLoan.keys(), ...this.atRiskLoans().map(l => l.loanId)]);
    return [...loanIds].map(id => {
      const loan = loanMap.get(id)!;
      const dueToday = dueTodayByLoan.get(id) || 0;
      const overdue = loan.overdueAmount || 0;
      return {
        loan,
        phone: customerMap.get(loan.customerId)?.phonePrimary || '',
        centerId: loan.centerId,
        centerName: centerMap.get(loan.centerId) || `সমিতি #${loan.centerId}`,
        dueToday, overdue, total: dueToday + overdue,
        isOverdue: overdue > 0 || (loan.daysPastDue || 0) > 0 || loan.status === 'OVERDUE'
      };
    }).sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || b.total - a.total);
  });

  readonly dueCustomersTotal = computed(() => this.sum(this.dueCustomers(), d => d.total));
  readonly dueCustomersOverdueCount = computed(() => this.dueCustomers().filter(d => d.isOverdue).length);
  /** তালিকা ছোট রাখতে প্রথমে ৮ জন, "সব দেখুন" চাপলে সবাই */
  readonly showAllDue = signal<boolean>(false);
  readonly visibleDueCustomers = computed(() =>
    this.showAllDue() ? this.dueCustomers() : this.dueCustomers().slice(0, 8));

  readonly recentLoans = computed(() => this.loans().slice().sort((a, b) => b.loanId - a.loanId).slice(0, 5));
  readonly recentCollections = computed(() =>
    this.windowCollections().slice().sort((a, b) => b.receiptId - a.receiptId).slice(0, 5)
  );

  // ==========================================
  // চার্ট ডেটা
  // ==========================================

  readonly trend = computed<TrendPoint[]>(() => {
    const days: TrendPoint[] = [];
    const today = this.todayKey();
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const key = addDaysKey(today, -i);
      days.push({
        dateKey: key,
        // দুপুর ১২টা (ঢাকা) ধরে সপ্তাহের দিন — টাইমজোন পার্থক্যে দিন বদলায় না
        label: new Date(`${key}T12:00:00+06:00`).toLocaleDateString(this.lang.isBangla() ? 'bn-BD' : 'en-US', { weekday: 'short', timeZone: 'Asia/Dhaka' }),
        collected: 0,
        disbursed: 0
      });
    }
    const byKey = new Map(days.map(p => [p.dateKey, p]));
    this.windowCollections().forEach(c => {
      const p = byKey.get(toDayKey(c.collectionDate));
      if (p) p.collected += c.totalAmountCollected || 0;
    });
    this.loans().forEach(l => {
      const p = byKey.get(toDayKey(l.disbursementDate));
      if (p && l.status !== 'CANCELLED') p.disbursed += l.principalAmount || 0;
    });
    return days;
  });

  readonly trendMax = computed(() => {
    const max = Math.max(0, ...this.trend().map(p => Math.max(p.collected, p.disbursed)));
    return max > 0 ? this.niceCeil(max) : 1;
  });

  readonly trendTotals = computed(() => ({
    collected: this.sum(this.trend(), p => p.collected),
    disbursed: this.sum(this.trend(), p => p.disbursed)
  }));

  readonly productMix = computed<ProductShare[]>(() => {
    const productNames = new Map(this.products().map(p => [p.productId, p.productName]));
    const map = new Map<number, number>();
    this.activeLoans().forEach(l => map.set(l.productId, (map.get(l.productId) || 0) + (l.outstandingBalance || 0)));
    const total = [...map.values()].reduce((a, b) => a + b, 0);
    return [...map.entries()]
      .map(([productId, outstanding]) => ({
        productId,
        name: productNames.get(productId) || `${this.lang.isBangla() ? 'পণ্য' : 'Product'} #${productId}`,
        outstanding,
        percent: total > 0 ? (outstanding / total) * 100 : 0
      }))
      .sort((a, b) => b.outstanding - a.outstanding);
  });

  // প্রিন্ট সামারির জন্য আজকের নতুন বিতরণ
  readonly todayDisbursedLoans = computed(() =>
    this.loans().filter(l => toDayKey(l.disbursementDate) === this.todayKey() && l.status !== 'CANCELLED')
  );

  // ==========================================
  // লাইফসাইকেল
  // ==========================================

  async ngOnInit() {
    this.watchConnectivity();
    await this.loadDashboardData();
    await this.autoRunOverdueEngine();
  }

  /** দিনে একবার বকেয়া ইঞ্জিন (এই পরিধিতে আজ না চললে); ঋণ হালনাগাদ হলে ড্যাশবোর্ড পুনরায় লোড */
  private async autoRunOverdueEngine() {
    if (this.overdueAutoRunDone) return;
    this.overdueAutoRunDone = true;
    try {
      const result = await this.overdueEngine.runIfDue(this.authService.accessibleBranchIds(), this.authService.currentUser());
      if (result) {
        this.overdueResult.set(result);
        if (result.loansUpdated > 0) await this.loadDashboardData();
      }
    } catch (err) {
      // অফলাইনে বা অনুমতি না থাকলে ড্যাশবোর্ড বন্ধ হবে না
      console.warn('Overdue engine auto-run skipped:', err);
    }
  }

  /** ম্যানুয়াল বকেয়া পুনঃহিসাব (অ্যাডমিন / শাখা ব্যবস্থাপক) */
  async rerunOverdueEngine() {
    if (!this.authService.canApproveLoans() || this.overdueRunning()) return;
    this.overdueRunning.set(true);
    this.overdueError.set('');
    try {
      const result = await this.overdueEngine.run(this.authService.accessibleBranchIds(), this.authService.currentUser());
      this.overdueResult.set(result);
      await this.loadDashboardData();
    } catch (err) {
      console.error('Overdue engine run failed:', err);
      this.overdueError.set(this.lang.isBangla() ? 'বকেয়া পুনঃহিসাব ব্যর্থ হয়েছে (ইন্টারনেট সংযোগ দেখুন)' : 'Overdue recalculation failed (check connection)');
    } finally {
      this.overdueRunning.set(false);
    }
  }

  onBranchChange(value: string) {
    this.selectedBranchId.set(Number(value) || 0);
    this.loadDashboardData();
  }

  async loadDashboardData() {
    const seq = ++this.loadSeq;
    this.loadedForUserId = this.authService.currentUser().userId;
    this.loading.set(true);
    this.todayKey.set(todayDhaka());
    try {
      const branchIds = this.scopeBranchIds();
      // ট্রেন্ড উইন্ডোর প্রথম দিনের ঢাকা মধ্যরাত (collectionDate ISO টাইমস্ট্যাম্প হিসেবে সংরক্ষিত)
      const windowStart = new Date(`${addDaysKey(this.todayKey(), -(TREND_DAYS - 1))}T00:00:00+06:00`);
      this.settingsService.getGeneralSettings()
        .then(g => this.foCashLimit.set(Number(g?.foCashInHandLimit) || 0))
        .catch(() => { /* ডিফল্ট সীমা বহাল */ });

      // প্রতিটি কোয়েরিতে একটি মাত্র ফিল্টার রাখা হয়েছে যাতে কম্পোজিট ইনডেক্স ছাড়াই চলে;
      // সম্পূর্ণ কিস্তি/আদায় কালেকশন আর পড়া হয় না
      const [branches, loans, installments, windowCols, unhanded, customers, centers, products] = await Promise.all([
        this.fetchAll<Branch>('branches'),
        this.fetchByBranches<Loan>('loans', branchIds),
        this.fetchAll<InstallmentSchedule>('installments', [where('dueDate', '==', this.todayKey())]),
        this.fetchAll<PaymentCollection>('collections', [where('collectionDate', '>=', windowStart.toISOString())]),
        this.fetchAll<PaymentCollection>('collections', [where('isHandedOverToBranch', '==', false)]),
        this.fetchByBranches<Customer>('customers', branchIds),
        this.fetchAll<CenterOrSamity>('centers'),
        this.fetchAll<LoanProduct>('loanProducts')
      ]);
      if (seq !== this.loadSeq) return;

      const inScope = (b: number) => branchIds === null || branchIds.includes(Number(b));
      const user = this.authService.currentUser();
      const foOwnsLoan = (l: { fieldOfficerUserId: number; centerId: number }) =>
        l.fieldOfficerUserId === user.userId || user.assignedCenterIds.includes(l.centerId);
      const fo = this.isFieldOfficerScope();

      this.branches.set(branches);
      this.centers.set(centers.filter(c => inScope(c.branchId)));
      this.products.set(products);
      this.loans.set(loans.filter(l => !fo || foOwnsLoan(l)));
      this.customers.set(customers.filter(c => !fo || c.assignedFieldOfficerId === user.userId || user.assignedCenterIds.includes(c.centerId)));
      this.todayInstallments.set(installments.filter(i => inScope(i.branchId) && (!fo || foOwnsLoan(i))));
      // বাতিলকৃত (reversed) রসিদ কখনো মোছা হয় না — সব আদায়/হস্তান্তর হিসাব থেকে বাদ
      this.windowCollections.set(windowCols.filter(c => !c.isReversed && inScope(c.branchId) && (!fo || c.collectedByUserId === user.userId)));
      this.unhandedCollections.set(unhanded.filter(c => !c.isReversed && inScope(c.branchId) && (!fo || c.collectedByUserId === user.userId)));
      this.lastUpdated.set(new Date());
    } catch (err) {
      console.error('Dashboard data loading error from Firestore:', err);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  // ==========================================
  // টেমপ্লেট হেল্পার
  // ==========================================

  readonly ringRadius = 34;
  readonly ringCircumference = 2 * Math.PI * 34;

  ringOffset(rate: number | null): number {
    return this.ringCircumference * (1 - (rate ?? 0) / 100);
  }

  barHeight(value: number): number {
    return (value / this.trendMax()) * 100;
  }

  progressTone(percent: number): string {
    if (percent >= 95) return 'good';
    if (percent >= 80) return 'warn';
    return 'bad';
  }

  smsLink(item: OverdueFollowup): string {
    const body = `প্রিয় ${item.loan.customerName}, আপনার ঋণ হিসাব ${item.loan.loanAccountNo} এ ${item.loan.overdueAmount} টাকা বকেয়া রয়েছে। অনুগ্রহ করে দ্রুত পরিশোধ করুন। - eKisti`;
    return `sms:${item.phone}?body=${encodeURIComponent(body)}`;
  }

  printSummary() {
    window.print();
  }

  // ==========================================
  // প্রাইভেট
  // ==========================================

  private async fetchAll<T extends { isDeleted?: boolean }>(name: string, constraints: QueryConstraint[] = []): Promise<T[]> {
    const snap = await getDocs(query(collection(this.firestore, name), ...constraints));
    const list: T[] = [];
    snap.forEach(d => {
      const data = d.data() as T;
      if (!data.isDeleted) list.push(data);
    });
    return list;
  }

  /** শাখা স্কোপ থাকলে কেবল সেই শাখাগুলোর ডকুমেন্ট পড়া হয় (৩০টির ব্যাচে) */
  private async fetchByBranches<T extends { isDeleted?: boolean }>(name: string, branchIds: number[] | null): Promise<T[]> {
    if (branchIds === null) return this.fetchAll<T>(name);
    if (branchIds.length === 0) return [];
    const batches: number[][] = [];
    for (let i = 0; i < branchIds.length; i += IN_QUERY_LIMIT) batches.push(branchIds.slice(i, i + IN_QUERY_LIMIT));
    const results = await Promise.all(batches.map(ids => this.fetchAll<T>(name, [where('branchId', 'in', ids)])));
    return results.flat();
  }

  private watchConnectivity() {
    if (typeof window === 'undefined') return;
    const update = () => this.isOnline.set(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    });
  }

  private sum<T>(items: T[], pick: (item: T) => number | undefined): number {
    return items.reduce((total, item) => total + (pick(item) || 0), 0);
  }

  private percent(value: number, target: number): number {
    if (target <= 0) return value > 0 ? 100 : 0;
    return Math.min(100, (value / target) * 100);
  }

  private niceCeil(value: number): number {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    const steps = [1, 2, 2.5, 5, 10];
    const step = steps.find(s => s * magnitude >= value) ?? 10;
    return step * magnitude;
  }
}
