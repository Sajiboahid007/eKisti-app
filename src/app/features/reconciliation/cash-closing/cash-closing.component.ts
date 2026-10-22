import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PaymentCollection, Branch, DailyReconciliation } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';
import { FieldCashBreakdown, RECEIPT_TYPE_LABELS, fieldCashBreakdown, receiptTypeOf } from '../../../core/finance/field-cash';

/** একজন মাঠকর্মীর কাছে জমা বাকি থাকা রসিদের গুচ্ছ */
interface OfficerHandoverGroup {
  userId: number;
  name: string;
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
  private kistiService = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);

  readonly denominationList = DENOMINATIONS;

  // ---------- ডেটা ----------
  readonly branches = signal<Branch[]>([]);
  readonly collections = signal<PaymentCollection[]>([]);
  readonly reconciliations = signal<DailyReconciliation[]>([]);
  readonly loading = signal<boolean>(true);
  readonly loadError = signal<string>('');

  // ---------- UI অবস্থা ----------
  readonly activeTab = signal<Tab>('pending');
  readonly selectedBranchId = signal<number>(0);
  readonly successMessage = signal<string>('');
  readonly historyDateFrom = signal<string>('');
  readonly historyDateTo = signal<string>('');
  readonly historyStatus = signal<StatusFilter>('ALL');

  // ---------- ক্লোজিং মডাল ----------
  readonly closingGroup = signal<OfficerHandoverGroup | null>(null);
  readonly selectedReceiptIds = signal<Set<number>>(new Set());
  readonly denominationCounts = signal<Record<number, number>>({});
  readonly useDenominations = signal<boolean>(true);
  readonly manualCashAmount = signal<number | null>(null);
  readonly closingNotes = signal<string>('');
  readonly confirmStep = signal<boolean>(false);
  readonly submitting = signal<boolean>(false);
  readonly closingError = signal<string>('');

  // ---------- স্লিপ (প্রিন্ট) ----------
  readonly slipRecord = signal<DailyReconciliation | null>(null);

  readonly today = toLocalDayKey(new Date());
  readonly canVerify = computed(() => this.authService.canVerifyCash());

  /** ব্যবহারকারী যে শাখাগুলো দেখতে পারেন */
  readonly accessibleBranches = computed(() =>
    this.branches().filter(b => this.authService.canAccessBranch(b.branchId))
  );

  readonly selectedBranch = computed(() =>
    this.branches().find(b => b.branchId === this.selectedBranchId()) || null
  );

  /** নির্বাচিত শাখার এখনো জমা না হওয়া রসিদ (মাঠকর্মী শুধু নিজেরটা দেখবেন) */
  readonly pendingReceipts = computed(() => {
    const branchId = this.selectedBranchId();
    const user = this.authService.currentUser();
    return this.collections().filter(c =>
      !c.isHandedOverToBranch &&
      !c.isReversed &&
      Number(c.branchId) === branchId &&
      (!this.authService.isFieldOfficer() || c.collectedByUserId === user.userId)
    );
  });

  readonly officerGroups = computed<OfficerHandoverGroup[]>(() => {
    const map = new Map<number, OfficerHandoverGroup>();
    for (const c of this.pendingReceipts()) {
      let g = map.get(c.collectedByUserId);
      if (!g) {
        g = {
          userId: c.collectedByUserId,
          name: c.collectedByName || `কর্মী #${c.collectedByUserId}`,
          receipts: [], cashAmount: 0, digitalAmount: 0, totalAmount: 0,
          oldestDate: c.collectionDate, isOverdue: false, breakdown: fieldCashBreakdown([])
        };
        map.set(c.collectedByUserId, g);
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
    this.reconciliations().filter(r => Number(r.branchId) === this.selectedBranchId())
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

      // প্রথমবার: নিজের শাখা, না থাকলে প্রথম অনুমোদিত শাখা
      const accessible = this.accessibleBranches();
      if (!accessible.some(b => b.branchId === this.selectedBranchId())) {
        const own = accessible.find(b => b.branchId === this.authService.currentUser().branchId);
        this.selectedBranchId.set((own || accessible[0])?.branchId || 0);
      }
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

  // ---------- ক্লোজিং মডাল ----------
  openClosing(group: OfficerHandoverGroup) {
    if (!this.canVerify()) return;
    this.closingGroup.set(group);
    this.selectedReceiptIds.set(new Set(group.receipts.map(r => r.receiptId)));
    this.denominationCounts.set({});
    this.useDenominations.set(true);
    this.manualCashAmount.set(null);
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
    this.confirmStep.set(false);
  }

  toggleAllReceipts() {
    const group = this.closingGroup();
    if (!group) return;
    const allSelected = this.selectedReceiptIds().size === group.receipts.length;
    this.selectedReceiptIds.set(allSelected ? new Set() : new Set(group.receipts.map(r => r.receiptId)));
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
    this.confirmStep.set(false);
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
        branchId: this.selectedBranchId(),
        fieldOfficerUserId: group.userId,
        fieldOfficerName: group.name,
        receiptIds: this.selectedReceipts().map(r => r.receiptId),
        countedCashAmount: this.countedCash(),
        denominations,
        notes: this.closingNotes(),
        cashier: { userId: user.userId, name: user.name, role: user.role }
      });

      this.closingGroup.set(null);
      this.showSuccess(
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

  private showSuccess(msg: string) {
    this.successMessage.set(msg);
    setTimeout(() => {
      if (this.successMessage() === msg) this.successMessage.set('');
    }, 6000);
  }
}
