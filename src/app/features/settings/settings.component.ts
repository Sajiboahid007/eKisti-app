import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Branch, GeneralSettings, Holiday, InstallmentFrequency, LoanProduct, OrganizationProfile } from '../../core/models/database.models';
import { AuthStateService } from '../../core/services/auth-state.service';
import { KistiDatabaseService } from '../../core/services/kisti-database.service';
import { DEFAULT_GENERAL_SETTINGS, DEFAULT_ORGANIZATION, SettingsService } from '../../core/services/settings.service';
import { buildSchedule } from '../../core/finance/schedule';
import { todayDhaka } from '../../core/finance/dates';
import { SkeletonComponent } from '../../shared/components/skeleton/skeleton.component';

type Tab = 'ORGANIZATION' | 'PRODUCTS' | 'HOLIDAYS' | 'GENERAL';
type Notice = { kind: 'success' | 'danger' | 'info' | 'warning'; text: string };

/** MRA-র বহুল উদ্ধৃত সর্বোচ্চ সার্ভিস চার্জ (বার্ষিক, হ্রাসমান) — সর্বশেষ সার্কুলার যাচাই করুন */
export const MRA_RATE_CAP = 24;

const FREQUENCY_LABELS: Record<InstallmentFrequency, string> = {
  DAILY: 'দৈনিক',
  WEEKLY: 'সাপ্তাহিক',
  MONTHLY: 'মাসিক'
};

const WEEK_DAYS = [
  { value: 0, label: 'রবিবার' },
  { value: 1, label: 'সোমবার' },
  { value: 2, label: 'মঙ্গলবার' },
  { value: 3, label: 'বুধবার' },
  { value: 4, label: 'বৃহস্পতিবার' },
  { value: 5, label: 'শুক্রবার' },
  { value: 6, label: 'শনিবার' }
];

/** নির্দিষ্ট তারিখের সরকারি ছুটি (ঈদ/পূজা চাঁদ/পঞ্জিকা অনুযায়ী প্রতি বছর বদলায় — হাতে যোগ করুন) */
const FIXED_PUBLIC_HOLIDAYS = [
  { monthDay: '02-21', name: 'শহীদ দিবস ও আন্তর্জাতিক মাতৃভাষা দিবস' },
  { monthDay: '03-26', name: 'স্বাধীনতা ও জাতীয় দিবস' },
  { monthDay: '04-14', name: 'পহেলা বৈশাখ (বাংলা নববর্ষ)' },
  { monthDay: '05-01', name: 'মে দিবস' },
  { monthDay: '12-16', name: 'বিজয় দিবস' }
];

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

function emptyProduct(): LoanProduct {
  return {
    productId: 0,
    productName: '',
    frequency: 'WEEKLY',
    defaultInstallmentsCount: 46,
    interestOrServiceChargeRate: 24,
    interestMethod: 'DECLINING',
    mandatorySavingsPerInstallment: 0,
    formAndProcessingFee: 0,
    insuranceFee: 0,
    minAmount: 10000,
    maxAmount: 100000,
    graceDays: 7,
    cycleCeilings: [],
    allowConcurrentLoans: false,
    earlySettlementRebatePercent: 0,
    isActive: true,
    isDeleted: false,
    deletedAt: null,
    deletedByUserId: null,
    deleteReason: null,
    history: []
  };
}

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, SkeletonComponent],
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss'
})
export class SettingsComponent implements OnInit {
  private settings = inject(SettingsService);
  private kisti = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);

  readonly rateCap = MRA_RATE_CAP;
  readonly freqLabels = FREQUENCY_LABELS;
  readonly frequencies: InstallmentFrequency[] = ['DAILY', 'WEEKLY', 'MONTHLY'];
  readonly weekDays = WEEK_DAYS;

  readonly tab = signal<Tab>('PRODUCTS');
  readonly loading = signal<boolean>(true);
  readonly busy = signal<boolean>(false);
  readonly notice = signal<Notice | null>(null);

  readonly branches = signal<Branch[]>([]);
  readonly products = signal<LoanProduct[]>([]);
  readonly holidays = signal<Holiday[]>([]);

  // ---------- ঋণ প্রোডাক্ট ফর্ম ----------
  readonly draft = signal<LoanProduct | null>(null);
  readonly ceilings = signal<number[]>([]);
  readonly formErrors = signal<string[]>([]);

  readonly draftErrors = computed(() => {
    const d = this.draft();
    return d ? this.validateProduct(d, this.ceilings()) : [];
  });
  readonly draftPreview = computed(() => {
    const d = this.draft();
    return d ? this.preview(d) : null;
  });

  // ---------- ছুটি ----------
  readonly holidayDate = signal<string>(todayDhaka());
  readonly holidayName = signal<string>('');
  readonly holidayAllBranches = signal<boolean>(true);
  readonly holidayBranchIds = signal<number[]>([]);
  readonly confirmRemoveDate = signal<string | null>(null);
  readonly quickYear = signal<number>(Number(todayDhaka().slice(0, 4)));
  readonly quickRows = signal<{ date: string; name: string }[]>([]);
  readonly confirmQuickIndex = signal<number | null>(null);
  readonly holidayDates = computed(() => new Set(this.holidays().map(h => h.date)));

  // ---------- সাধারণ নীতি ----------
  readonly general = signal<GeneralSettings>({ ...DEFAULT_GENERAL_SETTINGS });

  // ---------- প্রতিষ্ঠানের পরিচিতি ----------
  readonly orgDraft = signal<OrganizationProfile>({ ...DEFAULT_ORGANIZATION });

  async ngOnInit() {
    this.buildQuickRows();
    await this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      const [branches, products, holidays, general, organization] = await Promise.all([
        this.kisti.getBranches(),
        this.kisti.getLoanProducts(),
        this.settings.getHolidays(true),
        this.settings.getGeneralSettings(true),
        this.settings.getOrganization(true)
      ]);
      this.orgDraft.set({ ...organization });
      this.branches.set(branches.filter(b => !b.isDeleted));
      this.products.set(products);
      this.holidays.set([...holidays].sort((a, b) => a.date.localeCompare(b.date)));
      this.general.set({ ...DEFAULT_GENERAL_SETTINGS, ...general, weeklyOffDays: [...(general.weeklyOffDays || [])] });
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'সেটিংস লোড করা যায়নি' });
    } finally {
      this.loading.set(false);
    }
  }

  patchOrg<K extends keyof OrganizationProfile>(key: K, value: OrganizationProfile[K]) {
    this.orgDraft.update(o => ({ ...o, [key]: value }));
  }

  resetOrgToDefault() {
    this.orgDraft.set({ ...DEFAULT_ORGANIZATION, updatedAt: this.orgDraft().updatedAt });
  }

  async saveOrganization() {
    this.busy.set(true);
    this.notice.set(null);
    try {
      await this.settings.saveOrganization(this.orgDraft(), this.actor());
      this.orgDraft.set({ ...this.settings.organization() });
      this.notice.set({ kind: 'success', text: 'প্রতিষ্ঠানের পরিচিতি সংরক্ষিত হয়েছে — নেভবার, লগইন পাতা ও সব প্রিন্ট স্লিপে নতুন নাম দেখাবে' });
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'সংরক্ষণ করা যায়নি' });
    } finally {
      this.busy.set(false);
    }
  }

  setTab(t: Tab) {
    this.tab.set(t);
    this.notice.set(null);
  }

  private actor() {
    const u = this.authService.currentUser();
    return { userId: u.userId, name: u.name, role: u.role };
  }

  toBn(n: number): string {
    return String(n).replace(/\d/g, d => BN_DIGITS[+d]);
  }

  cycleLabel(i: number): string {
    const n = i + 1;
    const suffix = n === 2 || n === 3 ? 'য়' : n === 4 ? 'র্থ' : n === 6 ? 'ষ্ঠ' : 'ম';
    return `${this.toBn(n)}${suffix} চক্র`;
  }

  // ==================== ঋণ প্রোডাক্ট ====================

  /** নমুনা ঋণে প্রকৃত বার্ষিক হার (হ্রাসমান সমতুল্য) */
  preview(p: LoanProduct): { principal: number; rate: number; installment: number; totalProfit: number } | null {
    const count = Math.floor(Number(p.defaultInstallmentsCount));
    if (!count || count < 1) return null;
    const principal = Number(p.minAmount) > 0 ? Number(p.minAmount) : 20000;
    try {
      const s = buildSchedule({
        principal,
        ratePercent: Number(p.interestOrServiceChargeRate) || 0,
        method: p.interestMethod || 'FLAT',
        count: Math.min(count, 2000),
        frequency: p.frequency,
        firstDueDate: todayDhaka()
      });
      return { principal, rate: s.effectiveAnnualRate, installment: s.installmentAmount, totalProfit: s.totalProfit };
    } catch {
      return null;
    }
  }

  validateProduct(p: LoanProduct, ceilings: number[]): string[] {
    const errs: string[] = [];
    if (!p.productName?.trim()) errs.push('প্রোডাক্টের নাম লিখুন');
    if (!Number.isInteger(Number(p.defaultInstallmentsCount)) || Number(p.defaultInstallmentsCount) < 1) errs.push('কিস্তির সংখ্যা কমপক্ষে ১ হতে হবে');
    if (!(Number(p.interestOrServiceChargeRate) >= 0)) errs.push('সার্ভিস চার্জের হার সঠিক নয়');
    for (const [key, label] of [
      ['mandatorySavingsPerInstallment', 'বাধ্যতামূলক সঞ্চয়'],
      ['formAndProcessingFee', 'ফরম/প্রসেসিং ফি'],
      ['insuranceFee', 'বীমা / কল্যাণ ফি'],
      ['graceDays', 'গ্রেস পিরিয়ড']
    ] as const) {
      if (Number(p[key] ?? 0) < 0) errs.push(`${label} ঋণাত্মক হতে পারে না`);
    }
    if (!(Number(p.minAmount) > 0)) errs.push('সর্বনিম্ন ঋণসীমা ০-এর বেশি হতে হবে');
    if (Number(p.minAmount) > Number(p.maxAmount)) errs.push('সর্বনিম্ন সীমা সর্বোচ্চ সীমার বেশি হতে পারে না');
    const rebate = Number(p.earlySettlementRebatePercent ?? 0);
    if (rebate < 0 || rebate > 100) errs.push('আগাম পরিশোধ রেয়াত ০–১০০% এর মধ্যে হতে হবে');
    ceilings.forEach((c, i) => {
      if (!(Number(c) > 0)) errs.push(`${this.cycleLabel(i)}: সীমা ০-এর বেশি হতে হবে`);
      if (i > 0 && Number(c) < Number(ceilings[i - 1])) errs.push(`${this.cycleLabel(i)}: সীমা আগের চক্রের চেয়ে কম হতে পারে না`);
      if (Number(c) > Number(p.maxAmount)) errs.push(`${this.cycleLabel(i)}: সীমা সর্বোচ্চ ঋণসীমার বেশি হতে পারে না`);
    });
    return errs;
  }

  newProduct() {
    this.draft.set(emptyProduct());
    this.ceilings.set([]);
    this.formErrors.set([]);
    this.notice.set(null);
  }

  editProduct(p: LoanProduct) {
    this.draft.set({
      ...emptyProduct(),
      ...p,
      interestMethod: p.interestMethod || 'FLAT',
      graceDays: p.graceDays ?? 0,
      allowConcurrentLoans: p.allowConcurrentLoans ?? false,
      earlySettlementRebatePercent: p.earlySettlementRebatePercent ?? 0
    });
    this.ceilings.set([...(p.cycleCeilings || [])]);
    this.formErrors.set([]);
    this.notice.set(null);
  }

  cancelProduct() {
    if (!this.busy()) this.draft.set(null);
  }

  patch<K extends keyof LoanProduct>(key: K, value: LoanProduct[K]) {
    this.draft.update(d => (d ? { ...d, [key]: value } : d));
  }

  num(v: unknown): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  addCeiling() {
    const list = this.ceilings();
    const last = list[list.length - 1];
    const d = this.draft();
    this.ceilings.set([...list, last ? Math.min(last + 10000, d?.maxAmount || last + 10000) : d?.minAmount || 10000]);
  }

  setCeiling(i: number, value: number) {
    this.ceilings.update(list => list.map((c, idx) => (idx === i ? value : c)));
  }

  removeCeiling(i: number) {
    this.ceilings.update(list => list.filter((_, idx) => idx !== i));
  }

  async saveProduct() {
    const d = this.draft();
    if (!d) return;
    const errs = this.validateProduct(d, this.ceilings());
    this.formErrors.set(errs);
    if (errs.length) return;

    this.busy.set(true);
    try {
      const product: LoanProduct = {
        ...d,
        productName: d.productName.trim(),
        defaultInstallmentsCount: Math.floor(this.num(d.defaultInstallmentsCount)),
        interestOrServiceChargeRate: this.num(d.interestOrServiceChargeRate),
        mandatorySavingsPerInstallment: this.num(d.mandatorySavingsPerInstallment),
        formAndProcessingFee: this.num(d.formAndProcessingFee),
        insuranceFee: this.num(d.insuranceFee),
        minAmount: this.num(d.minAmount),
        maxAmount: this.num(d.maxAmount),
        graceDays: Math.floor(this.num(d.graceDays)),
        earlySettlementRebatePercent: this.num(d.earlySettlementRebatePercent),
        cycleCeilings: this.ceilings().map(c => this.num(c))
      };
      const saved = await this.settings.saveLoanProduct(product, this.actor());
      this.products.set(await this.kisti.getLoanProducts());
      this.draft.set(null);
      const p = this.preview(saved);
      const warn = p && p.rate > MRA_RATE_CAP ? ` — ⚠️ প্রকৃত বার্ষিক হার ${p.rate}% (${MRA_RATE_CAP}% সীমার বেশি)` : '';
      this.notice.set({ kind: warn ? 'warning' : 'success', text: `"${saved.productName}" (#${saved.productId}) সংরক্ষিত হয়েছে${warn}` });
    } catch (err: any) {
      this.formErrors.set([err?.message || 'প্রোডাক্ট সংরক্ষণ করা যায়নি']);
    } finally {
      this.busy.set(false);
    }
  }

  // ==================== ছুটির ক্যালেন্ডার ====================

  branchName(id: number): string {
    return this.branches().find(b => b.branchId === id)?.name || `শাখা #${id}`;
  }

  holidayBranchLabel(h: Holiday): string {
    return !h.branchIds || h.branchIds.length === 0 ? 'সকল শাখা' : h.branchIds.map(id => this.branchName(id)).join(', ');
  }

  toggleHolidayBranch(id: number, checked: boolean) {
    this.holidayBranchIds.update(list => (checked ? [...new Set([...list, id])] : list.filter(x => x !== id)));
  }

  private holidayScope(): number[] | null {
    if (this.holidayAllBranches()) return null;
    return this.holidayBranchIds();
  }

  /** quick = সরকারি ছুটি দ্রুত যোগ (সকল শাখায় প্রযোজ্য) */
  async addHoliday(date = this.holidayDate(), name = this.holidayName(), quick = false) {
    const scope = quick ? null : this.holidayScope();
    if (scope && scope.length === 0) {
      this.notice.set({ kind: 'danger', text: 'অন্তত একটি শাখা নির্বাচন করুন অথবা "সকল শাখা" বেছে নিন' });
      return;
    }
    if (this.holidayDates().has(date)) {
      this.notice.set({ kind: 'warning', text: `${date} তারিখে ইতিমধ্যে একটি ছুটি আছে — আগে সেটি বাতিল করুন` });
      return;
    }
    this.busy.set(true);
    try {
      await this.settings.addHoliday(date, name, scope, this.actor());
      this.holidays.set([...(await this.settings.getHolidays(true))].sort((a, b) => a.date.localeCompare(b.date)));
      if (!quick) this.holidayName.set('');
      this.confirmQuickIndex.set(null);
      this.notice.set({ kind: 'success', text: `ছুটি যোগ হয়েছে: ${date} — ${name.trim()}। এই তারিখের কিস্তি পরের কর্মদিবসে যাবে (নতুন শিডিউলে)।` });
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'ছুটি যোগ করা যায়নি' });
    } finally {
      this.busy.set(false);
    }
  }

  async removeHoliday(date: string) {
    this.busy.set(true);
    try {
      await this.settings.removeHoliday(date, this.actor());
      this.holidays.set([...(await this.settings.getHolidays(true))].sort((a, b) => a.date.localeCompare(b.date)));
      this.confirmRemoveDate.set(null);
      this.notice.set({ kind: 'success', text: `${date} তারিখের ছুটি বাতিল হয়েছে` });
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'ছুটি বাতিল করা যায়নি' });
    } finally {
      this.busy.set(false);
    }
  }

  buildQuickRows() {
    const y = this.quickYear();
    this.quickRows.set(FIXED_PUBLIC_HOLIDAYS.map(h => ({ date: `${y}-${h.monthDay}`, name: h.name })));
  }

  setQuickYear(y: number) {
    if (!Number.isInteger(y) || y < 2000 || y > 2100) return;
    this.quickYear.set(y);
    this.buildQuickRows();
  }

  setQuickDate(i: number, date: string) {
    this.quickRows.update(rows => rows.map((r, idx) => (idx === i ? { ...r, date } : r)));
  }

  // ==================== সাধারণ নীতি ====================

  patchGeneral<K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) {
    this.general.update(g => ({ ...g, [key]: value }));
  }

  toggleOffDay(day: number, checked: boolean) {
    this.general.update(g => {
      const set = new Set(g.weeklyOffDays || []);
      if (checked) set.add(day); else set.delete(day);
      return { ...g, weeklyOffDays: [...set].sort((a, b) => a - b) };
    });
  }

  async saveGeneral() {
    const g = this.general();
    const errs: string[] = [];
    if ((g.weeklyOffDays || []).length >= 7) errs.push('সপ্তাহের সব দিন ছুটি হতে পারে না');
    for (const [key, label] of [
      ['defaultAdmissionFee', 'ভর্তি ফি'],
      ['defaultPassbookFee', 'পাসবই ফি'],
      ['savingsInterestAnnualPercent', 'সঞ্চয়ের মুনাফার হার'],
      ['foCashInHandLimit', 'মাঠকর্মীর হাতে নগদ সীমা']
    ] as const) {
      if (!(Number(g[key]) >= 0)) errs.push(`${label} সঠিক নয়`);
    }
    if (Number(g.savingsInterestAnnualPercent) > 100) errs.push('সঞ্চয়ের মুনাফার হার ১০০%-এর বেশি হতে পারে না');
    if (errs.length) {
      this.notice.set({ kind: 'danger', text: errs.join('\n') });
      return;
    }

    this.busy.set(true);
    try {
      const { updatedAt, ...rest } = g;
      await this.settings.saveGeneralSettings({
        ...rest,
        weeklyOffDays: [...(g.weeklyOffDays || [])],
        defaultAdmissionFee: this.num(g.defaultAdmissionFee),
        defaultPassbookFee: this.num(g.defaultPassbookFee),
        savingsInterestAnnualPercent: this.num(g.savingsInterestAnnualPercent),
        foCashInHandLimit: this.num(g.foCashInHandLimit)
      }, this.actor());
      const fresh = await this.settings.getGeneralSettings();
      this.general.set({ ...fresh, weeklyOffDays: [...(fresh.weeklyOffDays || [])] });
      this.notice.set({ kind: 'success', text: 'সাধারণ নীতি সংরক্ষিত হয়েছে' });
    } catch (err: any) {
      this.notice.set({ kind: 'danger', text: err?.message || 'সেটিংস সংরক্ষণ করা যায়নি' });
    } finally {
      this.busy.set(false);
    }
  }
}
