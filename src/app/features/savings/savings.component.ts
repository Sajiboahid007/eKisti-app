import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Branch, CenterOrSamity, Customer, SavingsTransaction, SavingsTransactionType } from '../../core/models/database.models';
import { AuthStateService } from '../../core/services/auth-state.service';
import { CashService } from '../../core/services/cash.service';
import { KistiDatabaseService } from '../../core/services/kisti-database.service';
import { SettingsService } from '../../core/services/settings.service';
import { addDaysKey, todayDhaka } from '../../core/finance/dates';
import { SkeletonComponent } from '../../shared/components/skeleton/skeleton.component';

type Tab = 'MEMBERS' | 'TRANSACTIONS';
type SortKey = 'BALANCE_DESC' | 'BALANCE_ASC' | 'NAME';

export const SAVINGS_TYPE_LABELS: Record<SavingsTransactionType, string> = {
  DEPOSIT: 'সরাসরি জমা',
  WITHDRAW: 'উত্তোলন',
  KISTI_COLLECTION: 'কিস্তির সাথে সঞ্চয়',
  ADJUSTMENT: 'সমন্বয়',
  ACCOUNT_CLOSURE: 'হিসাব সমাপ্তি / ফেরত',
  INTEREST: 'সঞ্চয় মুনাফা',
  REVERSAL: 'রসিদ বাতিলে ফেরত'
};

/** সদস্যের পাসবুক স্টেটমেন্টের একটি সারি — চলতি স্থিতি খতিয়ান থেকে নতুন করে হিসাব */
interface StatementRow {
  txn: SavingsTransaction;
  credit: number;
  debit: number;
  runningBalance: number;
  /** লেনদেনে লেখা newBalance এবং হিসাবকৃত চলতি স্থিতি না মিললে */
  mismatch: boolean;
}

/**
 * সঞ্চয় (Savings) — সব সদস্যের সঞ্চয় স্থিতি, জমা/উত্তোলনের খতিয়ান, সদস্যভিত্তিক পাসবুক স্টেটমেন্ট
 * এবং ক্যাশিয়ার/BM-এর জমা ও উত্তোলন। সব টাকার কাজ CashService.recordSavings দিয়ে — ভল্ট খতিয়ান,
 * জার্নাল ও অডিট একই ট্রানজ্যাকশনে।
 */
@Component({
  selector: 'app-savings',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './savings.component.html',
  styleUrl: './savings.component.scss'
})
export class SavingsComponent implements OnInit {
  /** প্রতিষ্ঠানের নাম/ঠিকানা (সেটিংস → প্রতিষ্ঠান) */
  readonly org = inject(SettingsService).org;
  private kisti = inject(KistiDatabaseService);
  private cash = inject(CashService);
  private settings = inject(SettingsService);
  readonly authService = inject(AuthStateService);

  readonly typeLabels = SAVINGS_TYPE_LABELS;
  readonly today = todayDhaka();

  // ---------- data ----------
  readonly customers = signal<Customer[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly transactions = signal<SavingsTransaction[]>([]);
  readonly loading = signal<boolean>(true);
  readonly loadingTxns = signal<boolean>(false);
  readonly notice = signal<{ kind: 'success' | 'danger' | 'info'; text: string } | null>(null);
  readonly interestRate = signal<number>(0);
  readonly withdrawLock = signal<boolean>(true);

  // ---------- filters ----------
  readonly tab = signal<Tab>('MEMBERS');
  readonly branchId = signal<number>(0);          // 0 = সব অনুমোদিত শাখা
  readonly centerId = signal<number>(0);
  readonly search = signal<string>('');
  readonly sort = signal<SortKey>('BALANCE_DESC');
  readonly onlyWithBalance = signal<boolean>(false);
  readonly from = signal<string>(addDaysKey(todayDhaka(), -29));
  readonly to = signal<string>(todayDhaka());
  readonly typeFilter = signal<SavingsTransactionType | 'ALL'>('ALL');

  // ---------- statement ----------
  readonly statementCustomer = signal<Customer | null>(null);
  readonly statementRows = signal<StatementRow[]>([]);
  readonly statementLoading = signal<boolean>(false);

  // ---------- deposit / withdraw ----------
  readonly entry = signal<{ customer: Customer; kind: 'DEPOSIT' | 'WITHDRAW' } | null>(null);
  readonly entryAmount = signal<number>(0);
  readonly entryMethod = signal<SavingsTransaction['paymentMethod']>('CASH');
  readonly entryReason = signal<string>('');
  readonly entryBusy = signal<boolean>(false);
  readonly entryError = signal<string>('');

  /** উত্তোলন: শুধু শাখায় ক্যাশিয়ার / BM (ভল্ট থেকে টাকা দেওয়া) */
  readonly canTransact = computed(() => this.authService.canManageAccounts());
  /** জমা: ক্যাশিয়ার/BM (কাউন্টারে → ভল্ট) এবং মাঠকর্মী (মাঠে → মাঠকর্মীর হাতে, ক্যাশ ক্লোজিংয়ে ভল্টে) */
  readonly canDeposit = computed(() => this.authService.canManageAccounts() || this.authService.isFieldOfficer());

  readonly branchCenters = computed(() => {
    const b = this.branchId();
    return this.centers().filter(c => !b || Number(c.branchId) === b);
  });

  /** ভূমিকা অনুযায়ী দৃশ্যমান সদস্য (মাঠকর্মী শুধু নিজের সমিতির) */
  readonly scopedCustomers = computed(() => {
    const user = this.authService.currentUser();
    const foCenters = new Set([
      ...(user.assignedCenterIds || []),
      ...this.centers().filter(c => c.fieldOfficerUserId === user.userId).map(c => c.centerId)
    ]);
    return this.customers().filter(c => {
      if (c.isDeleted || !this.authService.canAccessBranch(c.branchId)) return false;
      if (this.authService.isFieldOfficer()) return c.assignedFieldOfficerId === user.userId || foCenters.has(c.centerId);
      return true;
    });
  });

  readonly filteredMembers = computed(() => {
    const b = this.branchId();
    const center = this.centerId();
    const q = this.search().trim().toLowerCase();
    const list = this.scopedCustomers().filter(c =>
      (!b || Number(c.branchId) === b) &&
      (!center || Number(c.centerId) === center) &&
      (!this.onlyWithBalance() || (c.totalSavingsBalance || 0) > 0) &&
      (!q || c.fullName.toLowerCase().includes(q) || c.customerCode?.toLowerCase().includes(q) ||
        String(c.customerId).includes(q) || (c.phonePrimary || '').includes(q) || (c.nidNumber || '').includes(q))
    );
    const sort = this.sort();
    return [...list].sort((x, y) =>
      sort === 'NAME' ? x.fullName.localeCompare(y.fullName)
        : sort === 'BALANCE_ASC' ? (x.totalSavingsBalance || 0) - (y.totalSavingsBalance || 0)
          : (y.totalSavingsBalance || 0) - (x.totalSavingsBalance || 0));
  });

  private readonly visibleCustomerIds = computed(() => new Set(this.scopedCustomers().map(c => c.customerId)));

  readonly filteredTransactions = computed(() => {
    const b = this.branchId();
    const center = this.centerId();
    const type = this.typeFilter();
    const q = this.search().trim().toLowerCase();
    const ids = this.visibleCustomerIds();
    return this.transactions().filter(t =>
      ids.has(t.customerId) &&
      (!b || Number(t.branchId) === b) &&
      (!center || Number(t.centerId) === center) &&
      (type === 'ALL' || t.type === type) &&
      (!q || t.customerName.toLowerCase().includes(q) || String(t.customerId).includes(q) || (t.receiptNo || '').toLowerCase().includes(q))
    );
  });

  readonly summary = computed(() => {
    const members = this.filteredMembers();
    const totalBalance = members.reduce((s, c) => s + (c.totalSavingsBalance || 0), 0);
    let deposits = 0, withdrawals = 0, interest = 0, kisti = 0;
    for (const t of this.filteredTransactions()) {
      if (t.isCredit) {
        deposits += t.amount;
        if (t.type === 'INTEREST') interest += t.amount;
        if (t.type === 'KISTI_COLLECTION') kisti += t.amount;
      } else {
        withdrawals += t.amount;
      }
    }
    const withBalance = members.filter(c => (c.totalSavingsBalance || 0) > 0).length;
    return {
      totalBalance,
      members: members.length,
      withBalance,
      average: withBalance ? Math.round(totalBalance / withBalance) : 0,
      deposits, withdrawals, interest, kisti,
      net: deposits - withdrawals
    };
  });

  /** দিনভিত্তিক জমা/উত্তোলন (লেনদেন ট্যাবের সারাংশ) */
  readonly dailyFlow = computed(() => {
    const map = new Map<string, { date: string; inn: number; out: number }>();
    for (const t of this.filteredTransactions()) {
      const date = this.dayOf(t);
      const row = map.get(date) || { date, inn: 0, out: 0 };
      if (t.isCredit) row.inn += t.amount; else row.out += t.amount;
      map.set(date, row);
    }
    return [...map.values()].sort((a, b) => b.date.localeCompare(a.date));
  });

  async ngOnInit() {
    try {
      const [customers, branches, centers, general] = await Promise.all([
        this.kisti.getCustomers(),
        this.kisti.getBranches(),
        this.kisti.getCenters(),
        this.settings.getGeneralSettings()
      ]);
      this.customers.set(customers);
      this.branches.set(branches.filter(b => this.authService.canAccessBranch(b.branchId)));
      this.centers.set(centers.filter(c => this.authService.canAccessBranch(c.branchId)));
      this.interestRate.set(Number(general.savingsInterestAnnualPercent) || 0);
      this.withdrawLock.set(!!general.lockSavingsWithdrawalWithActiveLoan);
      const own = this.authService.currentUser().branchId;
      if (this.branches().some(b => b.branchId === own)) this.branchId.set(own);
      await this.loadTransactions();
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'সঞ্চয়ের তথ্য লোড করা যায়নি' });
    } finally {
      this.loading.set(false);
    }
  }

  async loadTransactions() {
    if (this.from() > this.to()) {
      this.notice.set({ kind: 'danger', text: 'শুরুর তারিখ শেষ তারিখের পরে হতে পারে না' });
      return;
    }
    this.loadingTxns.set(true);
    try {
      this.transactions.set(await this.cash.savingsTransactionsBetween(this.from(), this.to()));
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'লেনদেন লোড করা যায়নি' });
    } finally {
      this.loadingTxns.set(false);
    }
  }

  async refreshCustomers() {
    this.customers.set(await this.kisti.getCustomers());
  }

  setRange(days: number) {
    this.to.set(this.today);
    this.from.set(addDaysKey(this.today, -days));
    void this.loadTransactions();
  }

  onBranchChange(id: number | string) {
    this.branchId.set(Number(id));
    this.centerId.set(0);
  }

  centerName(id: number): string {
    return this.centers().find(c => c.centerId === Number(id))?.name || `সমিতি #${id}`;
  }

  branchName(id: number): string {
    return this.branches().find(b => b.branchId === Number(id))?.name || `শাখা #${id}`;
  }

  dayOf(t: SavingsTransaction): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date(t.transactionDate));
  }

  // ---------- পাসবুক স্টেটমেন্ট ----------

  async openStatement(customer: Customer) {
    this.statementCustomer.set(customer);
    this.statementLoading.set(true);
    this.statementRows.set([]);
    try {
      const txns = await this.kisti.getSavingsTransactionsByCustomerId(customer.customerId);
      // পুরাতন থেকে নতুন — চলতি স্থিতি খতিয়ান থেকে নতুন করে হিসাব
      const asc = [...txns].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate) || a.transactionId - b.transactionId);
      let running = asc.length ? (asc[0].previousBalance || 0) : 0;
      const rows: StatementRow[] = asc.map(t => {
        running = Math.round((running + (t.isCredit ? t.amount : -t.amount)) * 100) / 100;
        return {
          txn: t,
          credit: t.isCredit ? t.amount : 0,
          debit: t.isCredit ? 0 : t.amount,
          runningBalance: running,
          mismatch: Math.abs(running - (t.newBalance ?? running)) > 0.009
        };
      });
      this.statementRows.set(rows.reverse());
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'স্টেটমেন্ট লোড করা যায়নি' });
    } finally {
      this.statementLoading.set(false);
    }
  }

  closeStatement() {
    this.statementCustomer.set(null);
  }

  /** খতিয়ানের শেষ স্থিতি বনাম গ্রাহক প্রোফাইলের স্থিতি */
  readonly statementCheck = computed(() => {
    const c = this.statementCustomer();
    const rows = this.statementRows();
    if (!c || rows.length === 0) return null;
    const ledger = rows[0].runningBalance;
    const profile = c.totalSavingsBalance || 0;
    return { ledger, profile, ok: Math.abs(ledger - profile) < 0.01, rowMismatches: rows.filter(r => r.mismatch).length };
  });

  readonly statementTotals = computed(() => {
    const rows = this.statementRows();
    return {
      credit: rows.reduce((s, r) => s + r.credit, 0),
      debit: rows.reduce((s, r) => s + r.debit, 0)
    };
  });

  printStatement() {
    window.print();
  }

  // ---------- জমা / উত্তোলন ----------

  openEntry(customer: Customer, kind: 'DEPOSIT' | 'WITHDRAW') {
    this.entry.set({ customer, kind });
    this.entryAmount.set(0);
    this.entryMethod.set('CASH');
    this.entryReason.set(kind === 'DEPOSIT' ? 'স্বেচ্ছা সঞ্চয় জমা' : 'সঞ্চয় উত্তোলন');
    this.entryError.set('');
  }

  closeEntry() {
    if (!this.entryBusy()) this.entry.set(null);
  }

  readonly entryWarning = computed(() => {
    const e = this.entry();
    if (!e || e.kind !== 'WITHDRAW') return '';
    if (this.entryAmount() > (e.customer.totalSavingsBalance || 0)) return 'উত্তোলনের পরিমাণ সঞ্চয় স্থিতির চেয়ে বেশি';
    if (this.withdrawLock() && (e.customer.activeLoansCount || 0) > 0) {
      return 'এই সদস্যের চলমান ঋণ আছে — নীতি অনুযায়ী উত্তোলন আটকে যাবে (সাধারণ সেটিংসে পরিবর্তনযোগ্য)';
    }
    return '';
  });

  async submitEntry() {
    const e = this.entry();
    if (!e) return;
    const amount = Number(this.entryAmount()) || 0;
    if (amount <= 0) {
      this.entryError.set('সঠিক পরিমাণ দিন');
      return;
    }
    const u = this.authService.currentUser();
    this.entryBusy.set(true);
    this.entryError.set('');
    try {
      const txn = await this.cash.recordSavings({
        customerId: e.customer.customerId,
        type: e.kind,
        amount,
        isCredit: e.kind === 'DEPOSIT',
        paymentMethod: this.entryMethod(),
        reason: this.entryReason().trim() || (e.kind === 'DEPOSIT' ? 'সঞ্চয় জমা' : 'সঞ্চয় উত্তোলন')
      }, { userId: u.userId, name: u.name, role: u.role });
      this.entry.set(null);
      const fieldNote = txn.receiptNo?.startsWith('RCP-') ? ` — রসিদ ${txn.receiptNo}, টাকা আপনার হাতে; অফিস ক্যাশিয়ারকে জমা দিন` : '';
      this.notice.set({ kind: 'success', text: `${e.customer.fullName}: ${e.kind === 'DEPOSIT' ? 'জমা' : 'উত্তোলন'} ৳${amount.toLocaleString('en-IN')} — নতুন স্থিতি ৳${txn.newBalance.toLocaleString('en-IN')} (লেনদেন #${txn.transactionId})${fieldNote}` });
      await Promise.all([this.refreshCustomers(), this.loadTransactions()]);
      if (this.statementCustomer()?.customerId === e.customer.customerId) {
        const fresh = this.customers().find(c => c.customerId === e.customer.customerId);
        if (fresh) await this.openStatement(fresh);
      }
    } catch (err: any) {
      this.entryError.set(err?.message || 'লেনদেন সম্পন্ন করা যায়নি');
    } finally {
      this.entryBusy.set(false);
    }
  }

  // ---------- CSV ----------

  exportCsv() {
    const rows: (string | number)[][] = this.tab() === 'MEMBERS'
      ? [['সদস্য আইডি', 'নাম', 'ফোন', 'শাখা', 'সমিতি', 'চলমান ঋণ', 'সঞ্চয় স্থিতি'],
        ...this.filteredMembers().map(c => [c.customerId, c.fullName, c.phonePrimary, this.branchName(c.branchId), this.centerName(c.centerId), c.activeLoansCount || 0, c.totalSavingsBalance || 0])]
      : [['লেনদেন নং', 'তারিখ', 'সদস্য আইডি', 'নাম', 'ধরন', 'জমা', 'উত্তোলন', 'পূর্বের স্থিতি', 'নতুন স্থিতি', 'মাধ্যম', 'রসিদ', 'কর্মী', 'কারণ'],
        ...this.filteredTransactions().map(t => [t.transactionId, this.dayOf(t), t.customerId, t.customerName, this.typeLabels[t.type] || t.type,
          t.isCredit ? t.amount : 0, t.isCredit ? 0 : t.amount, t.previousBalance, t.newBalance, t.paymentMethod, t.receiptNo || '', t.performedByName, t.reason])];
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `savings-${this.tab() === 'MEMBERS' ? 'balances' : 'transactions'}-${this.today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
