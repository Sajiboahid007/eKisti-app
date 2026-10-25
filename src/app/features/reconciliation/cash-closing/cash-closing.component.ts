import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PaymentCollection, Branch, DailyReconciliation } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';
import { ToastService } from '../../../core/services/toast.service';
import { FieldCashBreakdown, RECEIPT_TYPE_LABELS, fieldCashBreakdown, receiptTypeOf } from '../../../core/finance/field-cash';
import { SettingsService } from '../../../core/services/settings.service';

/** একজন মাঠকর্মীর কাছে জমা বাকি থাকা রসিদের গুচ্ছ */
interface OfficerHandoverGroup {
  userId: number;
  name: string;
  branchId: number;
  branchName: string;
  receipts: PaymentCollection[];
  cashAmount: number;     // নগদ — ভল্টে গুনে নিতে হবে
  digitalAmount: number;  // বিকাশ/নগদ/ব্যাংক — TrxID দিয়ে যাচাই
  totalAmount: number;
  oldestDate: string;
  isOverdue: boolean;     // আজকের আগের আদায় এখনো জমা হয়নি
  /** কিস্তি / সঞ্চয় / ফি / অবলোপিত আদায় — মাঠকর্মীর হাতে কোন খাতের কত টাকা */
  breakdown: FieldCashBreakdown;
}

type Tab = 'pending' | 'history';
type StatusFilter = 'ALL' | DailyReconciliation['cashierStatus'];

/** শাখা ফিল্টারে "সকল শাখা" */
const ALL_BRANCHES = 0;

// বাংলাদেশি টাকার নোট ও কয়েন
const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

function toLocalDayKey(value: string | Date): string {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-cash-closing',
  standalone: true,
  imports: [CommonModule, FormsModule, SkeletonComponent],
  templateUrl: './cash-closing.component.html',
  styleUrl: './cash-closing.component.scss'
})
export class CashClosingComponent implements OnInit {
  /** প্রতিষ্ঠানের নাম/ঠিকানা (সেটিংস → প্রতিষ্ঠান) */
  readonly org = inject(SettingsService).org;
  private kistiService = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);
  private toast = inject(ToastService);

  readonly denominationList = DENOMINATIONS;
  readonly ALL_BRANCHES = ALL_BRANCHES;

  // ---------- ডেটা ----------
  readonly branches = signal<Branch[]>([]);
  readonly collections = signal<PaymentCollection[]>([]);
  readonly reconciliations = signal<DailyReconciliation[]>([]);
  readonly loading = signal<boolean>(true);
  readonly loadError = signal<string>('');

  // ---------- UI অবস্থা ----------
  readonly activeTab = signal<Tab>('pending');
  readonly selectedBranchId = signal<number>(ALL_BRANCHES);
  private branchInitialized = false;
  readonly historyDateFrom = signal<string>('');
  readonly historyDateTo = signal<string>('');
  readonly historyStatus = signal<StatusFilter>('ALL');

  // ---------- ক্লোজিং মডাল ----------
  readonly closingGroup = signal<OfficerHandoverGroup | null>(null);
  readonly selectedReceiptIds = signal<Set<number>>(new Set());
  readonly denominationCounts = signal<Record<number, number>>({});
  readonly useDenominations = signal<boolean>(true);
  readonly manualCashAmount = signal<number | null>(null);
  /** ক্যাশিয়ার নিজে পরিমাণ বদলালে আর স্বয়ংক্রিয়ভাবে প্রত্যাশিত নগদ বসানো হবে না */
  private manualAmountEdited = false;
  readonly closingNotes = signal<string>('');
  readonly confirmStep = signal<boolean>(false);
  readonly submitting = signal<boolean>(false);
  readonly closingError = signal<string>('');

  // ---------- রসিদের বিস্তারিত (কে কত দিয়েছে) ----------
  readonly detailsGroup = signal<OfficerHandoverGroup | null>(null);
  readonly detailsMemberCount = computed(() => new Set((this.detailsGroup()?.receipts || []).map(r => r.customerId)).size);

  // ---------- স্লিপ (প্রিন্ট) ----------
  readonly slipRecord = signal<DailyReconciliation | null>(null);

  readonly today = toLocalDayKey(new Date());
  readonly canVerify = computed(() => this.authService.canVerifyCash());

  /** ব্যবহারকারী যে শাখাগুলো দেখতে পারেন */
  readonly accessibleBranches = computed(() =>
    this.branches().filter(b => this.authService.canAccessBranch(b.branchId))
  );

  /** একাধিক শাখা দেখার অনুমতি থাকলেই "সকল শাখা" অপশন দেখাবে */
  readonly canSeeAllBranches = computed(() => this.accessibleBranches().length > 1);

  readonly isAllBranches = computed(() => this.selectedBranchId() === ALL_BRANCHES && this.canSeeAllBranches());

  /** নির্দিষ্ট একটি শাখা নির্বাচিত থাকলে সেটি, "সকল শাখা" হলে null */
  readonly selectedBranch = computed(() =>
    this.isAllBranches() ? null : this.accessibleBranches().find(b => b.branchId === this.selectedBranchId()) || null
  );

  /** বর্তমান ফিল্টারের আওতাভুক্ত শাখা — অনুমতির বাইরের শাখার তথ্য কখনো দেখাবে না */
  readonly scopeBranches = computed(() => {
    if (this.isAllBranches()) return this.accessibleBranches();
    const b = this.selectedBranch();
    return b ? [b] : [];
  });

  private readonly scopeBranchIds = computed(() => new Set(this.scopeBranches().map(b => b.branchId)));

  /** আওতাভুক্ত শাখাগুলোর মোট ভল্ট ক্যাশ */
  readonly scopeVaultCash = computed(() =>
    this.scopeBranches().reduce((s, b) => s + (b.currentVaultCash || 0), 0)
  );

  /** আওতাভুক্ত শাখার এখনো জমা না হওয়া রসিদ (মাঠকর্মী শুধু নিজেরটা দেখবেন) */
  readonly pendingReceipts = computed(() => {
    const branchIds = this.scopeBranchIds();
    const user = this.authService.currentUser();
    return this.collections().filter(c =>
      !c.isHandedOverToBranch &&
      !c.isReversed &&
      branchIds.has(Number(c.branchId)) &&
      (!this.authService.isFieldOfficer() || c.collectedByUserId === user.userId)
    );
  });

  readonly officerGroups = computed<OfficerHandoverGroup[]>(() => {
    // শাখা + মাঠকর্মী অনুযায়ী গুচ্ছ — প্রতিটি ক্লোজিং একটি শাখার ভল্টে যায়
    const map = new Map<string, OfficerHandoverGroup>();
    for (const c of this.pendingReceipts()) {
      const branchId = Number(c.branchId);
      const key = `${branchId}_${c.collectedByUserId}`;
      let g = map.get(key);
      if (!g) {
        g = {
          userId: c.collectedByUserId,
          name: c.collectedByName || `কর্মী #${c.collectedByUserId}`,
          branchId,
          branchName: this.getBranchName(branchId),
          receipts: [], cashAmount: 0, digitalAmount: 0, totalAmount: 0,
          oldestDate: c.collectionDate, isOverdue: false, breakdown: fieldCashBreakdown([])
        };
        map.set(key, g);
      }
      const amount = c.totalAmountCollected || 0;
      g.receipts.push(c);
      g.totalAmount += amount;
      if (c.paymentMethod === 'CASH') g.cashAmount += amount; else g.digitalAmount += amount;
      if (c.collectionDate < g.oldestDate) g.oldestDate = c.collectionDate;
    }
    return [...map.values()]
      .map(g => ({
        ...g,
        receipts: g.receipts.sort((a, b) => a.receiptId - b.receiptId),
        isOverdue: toLocalDayKey(g.oldestDate) < this.today,
        breakdown: fieldCashBreakdown(g.receipts)
      }))
      .sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue) || b.totalAmount - a.totalAmount);
  });

  readonly branchReconciliations = computed(() =>
    this.reconciliations().filter(r => this.scopeBranchIds().has(Number(r.branchId)))
  );

  readonly filteredHistory = computed(() => {
    const from = this.historyDateFrom();
    const to = this.historyDateTo();
    const status = this.historyStatus();
    return this.branchReconciliations().filter(r =>
      (!from || r.date >= from) &&
      (!to || r.date <= to) &&
      (status === 'ALL' || r.cashierStatus === status)
    );
  });

  readonly stats = computed(() => {
    const pending = this.pendingReceipts();
    const todays = this.branchReconciliations().filter(r => r.date === this.today);
    return {
      pendingCash: pending.filter(c => c.paymentMethod === 'CASH').reduce((s, c) => s + (c.totalAmountCollected || 0), 0),
      pendingDigital: pending.filter(c => c.paymentMethod !== 'CASH').reduce((s, c) => s + (c.totalAmountCollected || 0), 0),
      pendingOfficers: this.officerGroups().length,
      todayAccepted: todays.reduce((s, r) => s + (r.cashHandedOverAmount || 0), 0),
      todayClosings: todays.length,
      todayShortage: todays.reduce((s, r) => s + Math.max(0, r.shortageOrDeficitAmount || 0), 0),
      todayMismatches: todays.filter(r => r.cashierStatus === 'MISMATCH_DISCREPANCY').length
    };
  });

  // ---------- মডাল হিসাব ----------
  /** যে শাখার ভল্টে এই ক্লোজিং জমা হবে */
  readonly closingBranch = computed(() => {
    const g = this.closingGroup();
    return g ? this.branches().find(b => b.branchId === g.branchId) || null : null;
  });

  readonly selectedReceipts = computed(() => {
    const ids = this.selectedReceiptIds();
    return (this.closingGroup()?.receipts || []).filter(r => ids.has(r.receiptId));
  });

  /** নির্বাচিত রসিদের খাতভিত্তিক বিভাজন (মডালে) */
  readonly selectedBreakdown = computed(() => fieldCashBreakdown(this.selectedReceipts()));

  /** শাখার সব মাঠকর্মীর হাতে মোট (খাতভিত্তিক) */
  readonly fieldTotals = computed(() => fieldCashBreakdown(this.pendingReceipts()));

  readonly receiptTypeLabels = RECEIPT_TYPE_LABELS;

  typeOf(r: PaymentCollection) {
    return receiptTypeOf(r);
  }

  readonly expectedCash = computed(() =>
    this.selectedReceipts().filter(r => r.paymentMethod === 'CASH').reduce((s, r) => s + (r.totalAmountCollected || 0), 0)
  );

  readonly expectedDigital = computed(() =>
    this.selectedReceipts().filter(r => r.paymentMethod !== 'CASH').reduce((s, r) => s + (r.totalAmountCollected || 0), 0)
  );

  readonly denominationTotal = computed(() => {
    const counts = this.denominationCounts();
    return DENOMINATIONS.reduce((s, d) => s + d * (counts[d] || 0), 0);
  });

  readonly countedCash = computed(() =>
    this.useDenominations() ? this.denominationTotal() : (Number(this.manualCashAmount()) || 0)
  );

  /** + ঘাটতি (কম দিয়েছে), − অতিরিক্ত */
  readonly difference = computed(() => Math.round((this.expectedCash() - this.countedCash()) * 100) / 100);

  readonly closingValidationError = computed(() => {
    if (this.selectedReceipts().length === 0) return 'কমপক্ষে একটি রসিদ নির্বাচন করুন';
    if (!this.useDenominations() && (this.manualCashAmount() === null || Number(this.manualCashAmount()) < 0)) {
      return 'গণনাকৃত নগদ টাকার পরিমাণ লিখুন';
    }
    if (this.difference() !== 0 && !this.closingNotes().trim()) {
      return 'টাকার অমিল আছে — কারণ / নোট লেখা বাধ্যতামূলক';
    }
    return '';
  });

  async ngOnInit() {
    await this.loadData();
  }

  async loadData() {
    this.loading.set(true);
    this.loadError.set('');
    try {
      const [branchList, collectionList, reconciliationList] = await Promise.all([
        this.kistiService.getBranches(),
        this.kistiService.getPaymentCollections(),
        this.kistiService.getReconciliations(this.authService.accessibleBranchIds())
      ]);
      this.branches.set(branchList);
      this.collections.set(collectionList);
      this.reconciliations.set(reconciliationList);

      // প্রথমবার: নিজের শাখা; না থাকলে একাধিক শাখায় "সকল শাখা", নইলে একমাত্র শাখা
      const accessible = this.accessibleBranches();
      const current = this.selectedBranchId();
      const stillValid = current === ALL_BRANCHES ? this.canSeeAllBranches() : accessible.some(b => b.branchId === current);
      if (!this.branchInitialized || !stillValid) {
        const own = accessible.find(b => b.branchId === this.authService.currentUser().branchId);
        this.selectedBranchId.set(own?.branchId ?? (accessible.length > 1 ? ALL_BRANCHES : accessible[0]?.branchId ?? ALL_BRANCHES));
      }
      this.branchInitialized = true;
    } catch (err) {
      console.error('Error loading reconciliation data:', err);
      this.loadError.set('ক্যাশ ক্লোজিং ডেটা লোড করা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।');
    } finally {
      this.loading.set(false);
    }
  }

  onBranchChange(branchId: number | string) {
    this.selectedBranchId.set(Number(branchId));
  }

  // ---------- রসিদের বিস্তারিত ----------
  openDetails(group: OfficerHandoverGroup) {
    this.detailsGroup.set(group);
  }

  closeDetails() {
    this.detailsGroup.set(null);
  }

  /** একাধিক কিস্তিতে বণ্টিত রসিদের কিস্তি নম্বর — "#৩, #৪" */
  installmentNos(r: PaymentCollection): string {
    return (r.allocations || []).map(a => `#${a.installmentNo}`).join(', ');
  }

  // ---------- ক্লোজিং মডাল ----------
  openClosing(group: OfficerHandoverGroup) {
    if (!this.canVerify()) return;
    this.closingGroup.set(group);
    this.selectedReceiptIds.set(new Set(group.receipts.map(r => r.receiptId)));
    this.denominationCounts.set({});
    // ডিফল্ট: সরাসরি পরিমাণ, প্রত্যাশিত নগদ আগে থেকেই বসানো
    this.useDenominations.set(false);
    this.manualAmountEdited = false;
    this.syncManualAmount();
    this.closingNotes.set('');
    this.confirmStep.set(false);
    this.closingError.set('');
  }

  closeClosing() {
    if (this.submitting()) return;
    this.closingGroup.set(null);
  }

  toggleReceipt(receiptId: number) {
    const next = new Set(this.selectedReceiptIds());
    if (next.has(receiptId)) next.delete(receiptId); else next.add(receiptId);
    this.selectedReceiptIds.set(next);
    this.syncManualAmount();
    this.confirmStep.set(false);
  }

  toggleAllReceipts() {
    const group = this.closingGroup();
    if (!group) return;
    const allSelected = this.selectedReceiptIds().size === group.receipts.length;
    this.selectedReceiptIds.set(allSelected ? new Set() : new Set(group.receipts.map(r => r.receiptId)));
    this.syncManualAmount();
    this.confirmStep.set(false);
  }

  setDenomination(note: number, value: number | string) {
    const count = Math.max(0, Math.floor(Number(value) || 0));
    this.denominationCounts.update(c => ({ ...c, [note]: count }));
    this.confirmStep.set(false);
  }

  setCountMode(useDenominations: boolean) {
    this.useDenominations.set(useDenominations);
    this.confirmStep.set(false);
  }

  setManualAmount(value: number | string | null) {
    this.manualCashAmount.set(value === null || value === '' ? null : Number(value));
    this.manualAmountEdited = true;
    this.confirmStep.set(false);
  }

  /** রসিদ নির্বাচন বদলালে (ক্যাশিয়ার হাতে না বদলানো পর্যন্ত) প্রত্যাশিত নগদ বসায় */
  private syncManualAmount() {
    if (!this.manualAmountEdited) this.manualCashAmount.set(this.expectedCash());
  }

  reviewClosing() {
    if (this.closingValidationError()) return;
    this.closingError.set('');
    this.confirmStep.set(true);
  }

  async submitClosing() {
    const group = this.closingGroup();
    if (!group || this.closingValidationError() || this.submitting()) return;

    const user = this.authService.currentUser();
    const counts = this.denominationCounts();
    const denominations: Record<string, number> = {};
    if (this.useDenominations()) {
      DENOMINATIONS.forEach(d => { if (counts[d]) denominations[String(d)] = counts[d]; });
    }

    this.submitting.set(true);
    this.closingError.set('');
    try {
      const record = await this.kistiService.reconcileFieldOfficerCash({
        branchId: group.branchId,
        fieldOfficerUserId: group.userId,
        fieldOfficerName: group.name,
        receiptIds: this.selectedReceipts().map(r => r.receiptId),
        countedCashAmount: this.countedCash(),
        denominations,
        notes: this.closingNotes(),
        cashier: { userId: user.userId, name: user.name, role: user.role }
      });

      this.closingGroup.set(null);
      this.toast.success(
        record.cashierStatus === 'ACCEPTED'
          ? `ক্লোজিং #${record.reconciliationId} সম্পন্ন — ${group.name} থেকে ৳${record.cashHandedOverAmount.toLocaleString('en-IN')} ভল্টে জমা হয়েছে`
          : `ক্লোজিং #${record.reconciliationId} অমিলসহ সংরক্ষিত — ${record.shortageOrDeficitAmount > 0 ? 'ঘাটতি' : 'অতিরিক্ত'} ৳${Math.abs(record.shortageOrDeficitAmount).toLocaleString('en-IN')}`
      );
      await this.loadData();
      this.slipRecord.set(record);
    } catch (err: any) {
      console.error('Reconciliation error:', err);
      this.closingError.set(err?.message || 'ক্যাশ গ্রহণে সমস্যা হয়েছে। আবার চেষ্টা করুন।');
      this.confirmStep.set(false);
    } finally {
      this.submitting.set(false);
    }
  }

  // ---------- স্লিপ ----------
  openSlip(record: DailyReconciliation) {
    this.slipRecord.set(record);
  }

  closeSlip() {
    this.slipRecord.set(null);
  }

  printSlip() {
    window.print();
  }

  slipDenominations(record: DailyReconciliation): { note: number; count: number }[] {
    const d = record.denominations || {};
    return DENOMINATIONS.filter(n => d[String(n)]).map(n => ({ note: n, count: d[String(n)] }));
  }

  getBranchName(branchId: number): string {
    return this.branches().find(b => b.branchId === Number(branchId))?.name || `শাখা #${branchId}`;
  }

  clearHistoryFilters() {
    this.historyDateFrom.set('');
    this.historyDateTo.set('');
    this.historyStatus.set('ALL');
  }
}
