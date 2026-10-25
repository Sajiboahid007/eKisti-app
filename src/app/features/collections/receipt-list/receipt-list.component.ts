import { Component, computed, inject, OnInit, signal, WritableSignal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Branch, CenterOrSamity, PaymentCollection } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';
import { FinanceService } from '../../../core/services/finance.service';
import { formatBnDate, toDhakaDayKey } from '../../../core/finance/dates';
import { isSettledStatus, remainingOf } from '../../../core/finance/allocation';
import { RECEIPT_TYPE_LABELS, receiptTypeOf } from '../../../core/finance/field-cash';
import { SettingsService } from '../../../core/services/settings.service';

type PaymentMethod = PaymentCollection['paymentMethod'];
type HandoverFilter = 'ALL' | 'PENDING' | 'HANDED_OVER';

// ISO timestamp → স্থানীয় তারিখ "YYYY-MM-DD" (UTC নয়, যাতে রাত ১২টার আগের রসিদ ভুল দিনে না যায়)
function toLocalDayKey(value: string | Date): string {
  const d = new Date(value);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

@Component({
  selector: 'app-receipt-list',
  standalone: true,
  imports: [CommonModule, FormsModule, SkeletonComponent],
  templateUrl: './receipt-list.component.html',
  styleUrl: './receipt-list.component.scss'
})
export class ReceiptListComponent implements OnInit {
  /** প্রতিষ্ঠানের নাম/ঠিকানা (সেটিংস → প্রতিষ্ঠান) */
  readonly org = inject(SettingsService).org;
  private kistiService = inject(KistiDatabaseService);
  private finance = inject(FinanceService);
  private route = inject(ActivatedRoute);

  // রসিদ বাতিল (রিভার্সাল) — মোছা নয়, উল্টো এন্ট্রি
  readonly reversing = signal<PaymentCollection | null>(null);
  readonly reverseReason = signal<string>('');
  readonly reverseBusy = signal<boolean>(false);
  readonly reverseError = signal<string>('');
  readonly notice = signal<string>('');
  readonly authService = inject(AuthStateService);

  readonly receipts = signal<PaymentCollection[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly loading = signal<boolean>(true);
  readonly loadError = signal<boolean>(false);

  // ফিল্টার
  readonly searchQuery = signal<string>('');
  readonly dateFrom = signal<string>('');
  readonly dateTo = signal<string>('');
  readonly methodFilter = signal<PaymentMethod | 'ALL'>('ALL');
  readonly collectorFilter = signal<number>(0); // 0 = সকল কর্মী
  readonly handoverFilter = signal<HandoverFilter>('ALL');

  // পেজিনেশন
  readonly currentPage = signal<number>(1);
  readonly pageSize = signal<number>(20); // 0 = সব

  // রসিদ প্রিভিউ মডাল
  readonly selectedReceiptForPrint = signal<PaymentCollection | null>(null);

  readonly paymentMethods: { value: PaymentMethod; label: string }[] = [
    { value: 'CASH', label: 'নগদ (Cash)' },
    { value: 'BKASH', label: 'বিকাশ' },
    { value: 'NAGAD', label: 'নগদ (Nagad)' },
    { value: 'BANK', label: 'ব্যাংক' },
    { value: 'SAVINGS', label: 'সঞ্চয় হতে' }
  ];

  /** ভূমিকা অনুযায়ী যে রসিদগুলো দেখার অনুমতি আছে */
  readonly permittedReceipts = computed<PaymentCollection[]>(() => {
    const all = this.receipts();
    const user = this.authService.currentUser();

    if (user.role === 'FIELD_OFFICER') {
      // মাঠকর্মী শুধু নিজের আদায় ও বরাদ্দকৃত সমিতির রসিদ দেখবেন
      const foCenterIds = new Set([
        ...(user.assignedCenterIds || []),
        ...this.centers().filter(c => c.fieldOfficerUserId === user.userId).map(c => c.centerId)
      ]);
      return all.filter(r => r.collectedByUserId === user.userId || foCenterIds.has(r.centerId));
    }

    return all.filter(r => this.authService.canAccessBranch(r.branchId));
  });

  /** কালেক্টর ড্রপডাউনের জন্য অনন্য কর্মী তালিকা */
  readonly collectors = computed(() => {
    const map = new Map<number, string>();
    this.permittedReceipts().forEach(r => map.set(r.collectedByUserId, r.collectedByName));
    return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });

  readonly filteredReceipts = computed<PaymentCollection[]>(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const from = this.dateFrom();
    const to = this.dateTo();
    const method = this.methodFilter();
    const collector = Number(this.collectorFilter());
    const handover = this.handoverFilter();

    return this.permittedReceipts().filter(r => {
      if (method !== 'ALL' && r.paymentMethod !== method) return false;
      if (collector && r.collectedByUserId !== collector) return false;
      if (handover === 'PENDING' && r.isHandedOverToBranch) return false;
      if (handover === 'HANDED_OVER' && !r.isHandedOverToBranch) return false;

      if (from || to) {
        const day = toLocalDayKey(r.collectionDate);
        if (from && day < from) return false;
        if (to && day > to) return false;
      }

      if (!q) return true;
      return (
        (r.customerName || '').toLowerCase().includes(q) ||
        String(r.receiptId).includes(q) ||
        String(r.loanId).includes(q) ||
        `ln-${r.loanId}`.includes(q) ||
        (r.receiptNumberManual || '').toLowerCase().includes(q) ||
        (r.trxId || '').toLowerCase().includes(q) ||
        (r.collectedByName || '').toLowerCase().includes(q)
      );
    });
  });

  /** ফিল্টার করা রসিদের সারসংক্ষেপ */
  readonly summary = computed(() => {
    let kisti = 0, savings = 0, fine = 0, total = 0, pendingHandover = 0;
    for (const r of this.filteredReceipts()) {
      if (r.isReversed) continue;
      kisti +=(r.principalAmountCollected || 0) + (r.profitAmountCollected || 0);
      savings += r.savingsAmountCollected || 0;
      fine += r.fineAmountCollected || 0;
      total += r.totalAmountCollected || 0;
      if (!r.isHandedOverToBranch) pendingHandover += r.totalAmountCollected || 0;
    }
    return { kisti, savings, fine, total, pendingHandover };
  });

  readonly hasActiveFilters = computed(() =>
    !!this.searchQuery().trim() || !!this.dateFrom() || !!this.dateTo() ||
    this.methodFilter() !== 'ALL' || !!this.collectorFilter() || this.handoverFilter() !== 'ALL'
  );

  readonly totalPages = computed(() => {
    const size = this.pageSize();
    if (size <= 0) return 1;
    return Math.max(1, Math.ceil(this.filteredReceipts().length / size));
  });

  readonly paginatedReceipts = computed(() => {
    const list = this.filteredReceipts();
    const size = this.pageSize();
    if (size <= 0) return list;
    const current = Math.min(Math.max(1, this.currentPage()), this.totalPages());
    const start = (current - 1) * size;
    return list.slice(start, start + size);
  });

  readonly visiblePages = computed(() => {
    const total = this.totalPages();
    const current = this.currentPage();
    let start = Math.max(1, current - 2);
    const end = Math.min(total, start + 4);
    start = Math.max(1, end - 4);
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
  });

  constructor() {
    // অন্য পেজ থেকে নির্দিষ্ট রসিদ/ঋণ খুঁজে আসা: /collections/receipts?search=40008 — বাকি ফিল্টার মুছে শুধু সেটি
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params => {
      const search = params.get('search');
      if (search) {
        this.clearFilters();
        this.searchQuery.set(search);
      }
    });
  }

  async ngOnInit() {
    await this.loadReceipts();
  }

  async loadReceipts() {
    this.loading.set(true);
    this.loadError.set(false);
    try {
      const [receiptList, branchList, centerList] = await Promise.all([
        this.kistiService.getPaymentCollections(),
        this.kistiService.getBranches(),
        this.kistiService.getCenters()
      ]);
      this.receipts.set(receiptList);
      this.branches.set(branchList);
      this.centers.set(centerList);
    } catch (err) {
      console.error('Error loading receipts:', err);
      this.loadError.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  /** যেকোনো ফিল্টার পরিবর্তনে প্রথম পৃষ্ঠায় ফিরে যাওয়া */
  updateFilter<T>(target: WritableSignal<T>, value: T) {
    target.set(value);
    this.currentPage.set(1);
  }

  setTodayFilter() {
    const today = toLocalDayKey(new Date());
    this.dateFrom.set(today);
    this.dateTo.set(today);
    this.currentPage.set(1);
  }

  clearFilters() {
    this.searchQuery.set('');
    this.dateFrom.set('');
    this.dateTo.set('');
    this.methodFilter.set('ALL');
    this.collectorFilter.set(0);
    this.handoverFilter.set('ALL');
    this.currentPage.set(1);
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
    }
  }

  onPageSizeChange(size: number | string) {
    this.pageSize.set(Number(size));
    this.currentPage.set(1);
  }

  getBranch(branchId: number): Branch | undefined {
    return this.branches().find(b => b.branchId === branchId);
  }

  getCenterName(centerId: number): string {
    return this.centers().find(c => c.centerId === centerId)?.name || `সমিতি #${centerId}`;
  }

  getMethodLabel(method: PaymentMethod): string {
    return this.paymentMethods.find(m => m.value === method)?.label || method;
  }

  /** রসিদে "পরবর্তী কিস্তি" — রসিদের তারিখের পরের প্রথম অপরিশোধিত কিস্তি */
  readonly receiptNextInstallment = signal<{ no: number; label: string; amount: number } | null>(null);

  readonly receiptTypeLabels = RECEIPT_TYPE_LABELS;

  typeOf(r: PaymentCollection) {
    return receiptTypeOf(r);
  }

  async viewReceipt(r: PaymentCollection) {
    this.selectedReceiptForPrint.set(r);
    this.receiptNextInstallment.set(null);
    if (r.isReversed || receiptTypeOf(r) !== 'KISTI') return;
    try {
      const day = toDhakaDayKey(r.collectionDate);
      const next = (await this.kistiService.getInstallmentsByLoanId(r.loanId))
        .filter(i => !isSettledStatus(i.status) && i.dueDate > day)
        .sort((a, b) => a.installmentNo - b.installmentNo)[0];
      if (next && this.selectedReceiptForPrint()?.receiptId === r.receiptId) {
        this.receiptNextInstallment.set({ no: next.installmentNo, label: formatBnDate(next.dueDate), amount: remainingOf(next).total + Math.max(0, (next.expectedSavings || 0) - (next.paidSavings || 0)) });
      }
    } catch (err) {
      console.error('Could not load next installment for receipt:', err);
    }
  }

  openReverse(r: PaymentCollection) {
    this.reversing.set(r);
    this.reverseReason.set('');
    this.reverseError.set('');
  }

  closeReverse() {
    if (!this.reverseBusy()) this.reversing.set(null);
  }

  async confirmReverse() {
    const r = this.reversing();
    if (!r || !this.reverseReason().trim()) return;
    const u = this.authService.currentUser();
    this.reverseBusy.set(true);
    this.reverseError.set('');
    try {
      await this.finance.reverseReceipt(r.receiptId, this.reverseReason(), { userId: u.userId, name: u.name, role: u.role });
      this.reversing.set(null);
      this.notice.set(`রসিদ #${r.receiptId} বাতিল হয়েছে — কিস্তি, ঋণ ও সঞ্চয় স্থিতি ফেরত সমন্বয় করা হয়েছে`);
      await this.loadReceipts();
    } catch (err: any) {
      this.reverseError.set(err?.message || 'রসিদ বাতিল করা যায়নি');
    } finally {
      this.reverseBusy.set(false);
    }
  }

  closeReceipt() {
    this.selectedReceiptForPrint.set(null);
  }

  printReceipt() {
    window.print();
  }
}
