import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { Firestore, collection, getDocs, query, where, QueryConstraint } from '@angular/fire/firestore';
import { AuthStateService } from '../../core/services/auth-state.service';
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

export interface HandoverQueueItem {
  userId: number;
  name: string;
  receiptsCount: number;
  amount: number;
}

export interface OverdueFollowup {
  loan: Loan;
  phone: string;
  guarantorName: string;
  guarantorPhone: string;
}

export interface ProductShare {
  productId: number;
  name: string;
  outstanding: number;
  percent: number;
}

/** স্থানীয় সময় অনুযায়ী YYYY-MM-DD (UTC নয়, যাতে বাংলাদেশ সময় রাত ১২টা–সকাল ৬টার আদায় ভুল দিনে না পড়ে) */
function localDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** তারিখ-স্ট্রিং (শুধু তারিখ অথবা পূর্ণ ISO) কে স্থানীয় দিনের কী-তে রূপান্তর */
function toDayKey(value: string | undefined | null): string {
  if (!value) return '';
  if (value.length === 10) return value;
  const d = new Date(value);
  return isNaN(d.getTime()) ? value.slice(0, 10) : localDateKey(d);
}

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

  readonly todayKey = signal<string>(localDateKey(new Date()));

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
  readonly todayKistiCollected = computed(() => this.todayCollectedAmount() - this.todaySavingsCollected());
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

  /** PAR % = বকেয়াযুক্ত ঋণের মোট বাকি ÷ সকল চলমান ঋণের মোট বাকি × ১০০ */
  readonly atRiskLoans = computed(() =>
    this.activeLoans().filter(l => l.status === 'OVERDUE' || (l.overdueAmount || 0) > 0)
  );
  readonly parPercent = computed(() => {
    const total = this.totalOutstanding();
    if (total <= 0) return 0;
    return (this.sum(this.atRiskLoans(), l => l.outstandingBalance) / total) * 100;
  });

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
    const weekday = new Date().toLocaleDateString('en-US', { weekday: 'long' });
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
        { userId: c.collectedByUserId, name: c.collectedByName || `#${c.collectedByUserId}`, receiptsCount: 0, amount: 0 };
      item.receiptsCount++;
      item.amount += c.totalAmountCollected || 0;
      map.set(c.collectedByUserId, item);
    });
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  });

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

  readonly recentLoans = computed(() => this.loans().slice().sort((a, b) => b.loanId - a.loanId).slice(0, 5));
  readonly recentCollections = computed(() =>
    this.windowCollections().slice().sort((a, b) => b.receiptId - a.receiptId).slice(0, 5)
  );

  // ==========================================
  // চার্ট ডেটা
  // ==========================================

  readonly trend = computed<TrendPoint[]>(() => {
    const days: TrendPoint[] = [];
    const base = new Date();
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
      days.push({
        dateKey: localDateKey(d),
        label: d.toLocaleDateString(this.lang.isBangla() ? 'bn-BD' : 'en-US', { weekday: 'short' }),
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
  }

  onBranchChange(value: string) {
    this.selectedBranchId.set(Number(value) || 0);
    this.loadDashboardData();
  }

  async loadDashboardData() {
    this.loading.set(true);
    this.todayKey.set(localDateKey(new Date()));
    try {
      const branchIds = this.scopeBranchIds();
      const windowStart = new Date();
      windowStart.setHours(0, 0, 0, 0);
      windowStart.setDate(windowStart.getDate() - (TREND_DAYS - 1));

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
      this.windowCollections.set(windowCols.filter(c => inScope(c.branchId) && (!fo || c.collectedByUserId === user.userId)));
      this.unhandedCollections.set(unhanded.filter(c => inScope(c.branchId) && (!fo || c.collectedByUserId === user.userId)));
      this.lastUpdated.set(new Date());
    } catch (err) {
      console.error('Dashboard data loading error from Firestore:', err);
    } finally {
      this.loading.set(false);
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
