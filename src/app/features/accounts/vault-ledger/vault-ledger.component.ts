import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Branch, DailyBranchSummary, Expense, MonthlyPortfolioSnapshot, PeriodClosing, VaultTransaction } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { CashService, EXPENSE_HEADS, VOUCHER_PREFIX, VaultOperation } from '../../../core/services/cash.service';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { addDaysKey, monthKeyDhaka, todayDhaka } from '../../../core/finance/dates';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

type Tab = 'LEDGER' | 'EXPENSES' | 'SUMMARIES';

/** শাখা ফিল্টারে "সকল শাখা" — শুধু দেখা যায়, লেনদেন/সমাপনী একটি শাখা বেছে করতে হয় */
const ALL_BRANCHES = 0;

const OPERATION_LABELS: Record<VaultOperation, { label: string; icon: string; hint: string }> = {
  BANK_DEPOSIT: { label: 'ব্যাংকে জমা', icon: 'account_balance', hint: 'ভল্টের নগদ ব্যাংক হিসাবে জমা (স্লিপ নং আবশ্যক)' },
  BANK_WITHDRAW: { label: 'ব্যাংক থেকে উত্তোলন', icon: 'local_atm', hint: 'ব্যাংক থেকে চেক দিয়ে ভল্টে নগদ আনা' },
  EXPENSE: { label: 'খরচ', icon: 'receipt', hint: 'শাখার খরচ ভাউচারসহ' },
  HO_TRANSFER_IN: { label: 'প্রধান কার্যালয় থেকে তহবিল', icon: 'call_received', hint: 'ঋণ বিতরণের জন্য প্রধান কার্যালয়ের পাঠানো টাকা' },
  HO_TRANSFER_OUT: { label: 'প্রধান কার্যালয়ে প্রেরণ', icon: 'call_made', hint: 'উদ্বৃত্ত নগদ প্রধান কার্যালয়ে পাঠানো' },
  OPENING: { label: 'প্রারম্ভিক স্থিতি', icon: 'start', hint: 'খতিয়ান শুরুর আগে একবার — ভল্টে প্রকৃত গণনাকৃত নগদ' }
};

const VAULT_TYPE_LABELS: Record<string, string> = {
  OPENING: 'প্রারম্ভিক স্থিতি', CLOSING_IN: 'মাঠকর্মীর ক্যাশ জমা', DISBURSEMENT_OUT: 'ঋণ বিতরণ', FEE_IN: 'ফি জমা',
  SAVINGS_DEPOSIT_IN: 'সঞ্চয় জমা', SAVINGS_WITHDRAW_OUT: 'সঞ্চয় উত্তোলন', BANK_DEPOSIT: 'ব্যাংকে জমা', BANK_WITHDRAW: 'ব্যাংক থেকে উত্তোলন',
  EXPENSE: 'খরচ', HO_TRANSFER_IN: 'প্রধান কার্যালয় থেকে', HO_TRANSFER_OUT: 'প্রধান কার্যালয়ে', ADJUSTMENT: 'সমন্বয়'
};

@Component({
  selector: 'app-vault-ledger',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './vault-ledger.component.html',
  styleUrl: './vault-ledger.component.scss'
})
export class VaultLedgerComponent implements OnInit {
  private cash = inject(CashService);
  private kisti = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);

  readonly expenseHeads = EXPENSE_HEADS;
  readonly opLabels = OPERATION_LABELS;
  readonly operations: VaultOperation[] = ['BANK_DEPOSIT', 'BANK_WITHDRAW', 'EXPENSE', 'HO_TRANSFER_IN', 'HO_TRANSFER_OUT'];
  readonly ALL_BRANCHES = ALL_BRANCHES;

  readonly branches = signal<Branch[]>([]);
  readonly branchId = signal<number>(0);
  readonly from = signal<string>(todayDhaka());
  readonly to = signal<string>(todayDhaka());
  readonly ledger = signal<VaultTransaction[]>([]);
  readonly expenses = signal<Expense[]>([]);
  readonly summaries = signal<DailyBranchSummary[]>([]);
  readonly snapshots = signal<MonthlyPortfolioSnapshot[]>([]);
  readonly dayStatus = signal<PeriodClosing | null>(null);
  /** "সকল শাখা": কয়টি শাখার আজকের দিবস সমাপনী হয়েছে */
  readonly closedBranchCount = signal<number>(0);
  readonly hasLedger = signal<boolean>(true);
  readonly loading = signal<boolean>(true);
  readonly tab = signal<Tab>('LEDGER');
  readonly notice = signal<{ kind: 'success' | 'danger'; text: string } | null>(null);

  // modal
  readonly op = signal<VaultOperation | 'CLOSE_DAY' | 'CLOSE_MONTH' | 'REOPEN' | 'INTEREST' | null>(null);
  readonly amount = signal<number>(0);
  readonly slipNo = signal<string>('');
  /** মোডাল খোলার সময় দেখানো স্বয়ংক্রিয় নং — অপরিবর্তিত থাকলে জমার সময় পরবর্তী ক্রমিক নং বরাদ্দ হয় */
  private autoSlipPreview = '';
  readonly note = signal<string>('');
  readonly head = signal<string>(EXPENSE_HEADS[0]);
  readonly paidTo = signal<string>('');
  readonly month = signal<string>(monthKeyDhaka());
  readonly reopenDate = signal<string>(todayDhaka());
  readonly busy = signal<boolean>(false);
  readonly modalError = signal<string>('');
  readonly progress = signal<string>('');

  readonly today = todayDhaka();
  /** একাধিক শাখা দেখার অনুমতি থাকলেই "সকল শাখা" অপশন দেখাবে */
  readonly canSeeAllBranches = computed(() => this.branches().length > 1);
  readonly isAllBranches = computed(() => this.branchId() === ALL_BRANCHES && this.canSeeAllBranches());
  readonly branch = computed(() =>
    this.isAllBranches() ? null : this.branches().find(b => b.branchId === this.branchId()) || null
  );
  /** বর্তমান ফিল্টারের আওতাভুক্ত শাখা (অনুমতির বাইরের শাখা কখনো নয়) */
  readonly scopeBranches = computed(() => {
    if (this.isAllBranches()) return this.branches();
    const b = this.branch();
    return b ? [b] : [];
  });
  readonly scopeTotals = computed(() => this.scopeBranches().reduce(
    (t, b) => ({ vault: t.vault + (Number(b.currentVaultCash) || 0), bank: t.bank + (Number(b.currentBankBalance) || 0) }),
    { vault: 0, bank: 0 }
  ));
  readonly dayClosed = computed(() => this.dayStatus()?.status === 'CLOSED');
  readonly totals = computed(() => {
    let inn = 0, out = 0;
    for (const v of this.ledger()) { if (v.direction === 'IN') inn += v.amount; else out += v.amount; }
    return { inn, out };
  });

  async ngOnInit() {
    const all = await this.kisti.getBranches();
    const accessible = all.filter(b => this.authService.canAccessBranch(b.branchId));
    this.branches.set(accessible);
    const own = accessible.find(b => b.branchId === this.authService.currentUser().branchId);
    this.branchId.set(own?.branchId ?? (accessible.length > 1 ? ALL_BRANCHES : accessible[0]?.branchId ?? ALL_BRANCHES));
    await this.load();
  }

  async load() {
    if (this.isAllBranches()) return this.loadAll();
    if (!this.branchId()) { this.loading.set(false); return; }
    this.loading.set(true);
    try {
      const id = this.branchId();
      const [branches, ledger, expenses, summaries, snapshots, status, any] = await Promise.all([
        this.kisti.getBranches(),
        this.cash.getVaultTransactions(id, this.from(), this.to()),
        this.cash.getExpenses(id, this.from(), this.to()),
        this.cash.getDailySummaries(id),
        this.cash.getMonthlySnapshots(id),
        this.cash.getDayStatus(id),
        this.cash.getVaultTransactions(id, '2000-01-01', this.today)
      ]);
      this.branches.set(branches.filter(b => this.authService.canAccessBranch(b.branchId)));
      this.ledger.set(ledger);
      this.expenses.set(expenses);
      this.summaries.set(summaries);
      this.snapshots.set(snapshots);
      this.dayStatus.set(status);
      this.hasLedger.set(any.length > 0);
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'তথ্য লোড করা যায়নি' });
    } finally {
      this.loading.set(false);
    }
  }

  /** সকল অনুমোদিত শাখার খতিয়ান একসাথে (শুধু দেখা) */
  private async loadAll() {
    this.loading.set(true);
    try {
      const all = await this.kisti.getBranches();
      const accessible = all.filter(b => this.authService.canAccessBranch(b.branchId));
      this.branches.set(accessible);
      const ids = new Set(accessible.map(b => b.branchId));
      const inScope = (x: { branchId: number }) => ids.has(Number(x.branchId));
      const [ledger, expenses, summaries, snapshots, statuses] = await Promise.all([
        this.cash.getVaultTransactions(null, this.from(), this.to()),
        this.cash.getExpenses(null, this.from(), this.to()),
        Promise.all(accessible.map(b => this.cash.getDailySummaries(b.branchId))),
        Promise.all(accessible.map(b => this.cash.getMonthlySnapshots(b.branchId))),
        Promise.all(accessible.map(b => this.cash.getDayStatus(b.branchId)))
      ]);
      this.ledger.set(ledger.filter(inScope));
      this.expenses.set(expenses.filter(inScope));
      this.summaries.set(summaries.flat().sort((a, b) => b.date.localeCompare(a.date) || a.branchId - b.branchId));
      this.snapshots.set(snapshots.flat().sort((a, b) => b.month.localeCompare(a.month) || a.branchId - b.branchId));
      this.closedBranchCount.set(statuses.filter(s => s?.status === 'CLOSED').length);
      this.dayStatus.set(null);
      this.hasLedger.set(true);
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'তথ্য লোড করা যায়নি' });
    } finally {
      this.loading.set(false);
    }
  }

  branchName(branchId: number): string {
    return this.branches().find(b => b.branchId === Number(branchId))?.name || `শাখা #${branchId}`;
  }

  setRange(days: number) {
    this.to.set(this.today);
    this.from.set(addDaysKey(this.today, -days));
    void this.load();
  }

  opInfo(op: string): { label: string; icon: string; hint: string } {
    return OPERATION_LABELS[op as VaultOperation] || { label: op, icon: 'help', hint: '' };
  }

  typeLabel(type: string): string {
    return VAULT_TYPE_LABELS[type] || type;
  }

  open(op: NonNullable<ReturnType<VaultLedgerComponent['op']>>) {
    this.op.set(op);
    this.amount.set(op === 'OPENING' ? (Number(this.branch()?.currentVaultCash) || 0) : 0);
    this.slipNo.set('');
    this.autoSlipPreview = '';
    if (op in VOUCHER_PREFIX) void this.loadAutoSlipNo(op as VaultOperation);
    this.note.set('');
    this.paidTo.set('');
    this.modalError.set('');
    this.progress.set('');
  }

  close() {
    if (!this.busy()) this.op.set(null);
  }

  /** পরবর্তী ক্রমিক স্লিপ / ভাউচার নং (যেমন BD-001) — প্রকৃত ব্যাংক স্লিপ নং দিয়ে বদলানো যায় */
  private async loadAutoSlipNo(op: VaultOperation) {
    const next = await this.cash.peekVoucherNo(this.branchId(), op);
    if (this.op() !== op || this.slipNo()) return;
    this.autoSlipPreview = next;
    this.slipNo.set(next);
  }

  private actor() {
    const u = this.authService.currentUser();
    return { userId: u.userId, name: u.name, role: u.role, category: u.category };
  }

  async submit() {
    const op = this.op();
    if (!op) return;
    this.busy.set(true);
    this.modalError.set('');
    try {
      let text = '';
      if (op === 'CLOSE_DAY') {
        const s = await this.cash.closeDay(this.branchId(), this.actor());
        text = `দিবস সমাপনী সম্পন্ন — সমাপনী ভল্ট ৳${s.closingVault.toLocaleString('en-IN')}, আদায় ৳${s.collectionsTotal.toLocaleString('en-IN')}`;
      } else if (op === 'CLOSE_MONTH') {
        const s = await this.cash.closeMonth(this.branchId(), this.month(), this.actor());
        text = `${s.month} মাস সমাপনী — PAR>৩০ ${s.par30Percent}%, প্রয়োজনীয় সঞ্চিতি ৳${s.requiredProvision.toLocaleString('en-IN')}`;
      } else if (op === 'REOPEN') {
        await this.cash.reopenDay(this.branchId(), this.reopenDate(), this.note(), this.actor());
        text = `${this.reopenDate()} তারিখ পুনরায় খোলা হয়েছে`;
      } else if (op === 'INTEREST') {
        const r = await this.cash.postSavingsInterest(this.branchId(), this.month(), this.actor(), (d, t) => this.progress.set(`${d}/${t}`));
        text = `${r.posted} জন সদস্যের হিসাবে মোট ৳${r.totalInterest.toLocaleString('en-IN')} মুনাফা জমা হয়েছে`;
      } else {
        const row = await this.cash.vaultOperation({
          branchId: this.branchId(), operation: op, amount: Number(this.amount()) || 0,
          slipNo: this.slipNo(), autoSlipNo: !!this.autoSlipPreview && this.slipNo().trim() === this.autoSlipPreview, note: this.note(), expenseHead: op === 'EXPENSE' ? this.head() : undefined, paidTo: this.paidTo()
        }, this.actor());
        text = `${OPERATION_LABELS[op].label}${row.slipNo ? ` (${row.slipNo})` : ''}: ৳${row.amount.toLocaleString('en-IN')} — ভল্ট এখন ৳${row.balanceAfter.toLocaleString('en-IN')}`;
      }
      this.op.set(null);
      this.notice.set({ kind: 'success', text });
      await this.load();
    } catch (err: any) {
      this.modalError.set(err?.message || 'কাজটি সম্পন্ন করা যায়নি');
    } finally {
      this.busy.set(false);
    }
  }

  vaultInOut(s: DailyBranchSummary, dir: 'IN' | 'OUT'): number {
    const rec = dir === 'IN' ? s.vaultIn : s.vaultOut;
    return Object.values(rec || {}).reduce((a, b) => a + b, 0);
  }
}
