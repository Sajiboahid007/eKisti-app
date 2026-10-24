import { Injectable, inject } from '@angular/core';
import { collection, doc, getDoc, getDocs, query, where, writeBatch } from '@angular/fire/firestore';
import { CenterOrSamity, Customer, InstallmentFrequency, InstallmentSchedule, Loan, LoanProduct, LoanStatus } from '../models/database.models';
import { InterestMethod, LoanSchedule, buildSchedule } from '../finance/schedule';
import { MEETING_DAY_INDEX, addDaysKey, onOrAfterWeekday, todayDhaka } from '../finance/dates';
import { normalizeNid } from '../finance/validation';
import { ACCOUNTS } from '../finance/accounts';
import { CounterService } from './counter.service';
import { SettingsService } from './settings.service';
import { Actor, TxRunner } from './tx-runner.service';
import { round2 } from './tx-session';

/** যেসব অবস্থায় ঋণ "চলমান" ধরা হয় (নতুন ঋণ আটকাতে) */
export const OPEN_LOAN_STATUSES: LoanStatus[] = ['APPLIED', 'FIELD_VERIFIED', 'APPROVED', 'DISBURSED', 'OVERDUE'];
/**
 * ঋণ প্রবাহের ধাপভিত্তিক দায়িত্ব:
 * মাঠকর্মী সরেজমিনে যাচাই → শাখা ব্যবস্থাপক অনুমোদন → ক্যাশিয়ার ভল্ট থেকে টাকা দিয়ে বিতরণ।
 * অ্যাডমিন / সুপার অ্যাডমিন সব ধাপে প্রয়োজনে কাজ করতে পারেন।
 */
export const LOAN_VERIFY_ROLES = ['FIELD_OFFICER', 'SUPER_ADMIN', 'ADMIN'];
export const LOAN_APPROVE_ROLES = ['BRANCH_MANAGER', 'SUPER_ADMIN', 'ADMIN', 'AREA_MANAGER', 'MANAGING_DIRECTOR'];
export const LOAN_DISBURSE_ROLES = ['CASHIER', 'SUPER_ADMIN', 'ADMIN'];

/** ঋণ চক্র গণনায় যেসব ঋণ ধরা হয় */
const CYCLE_COUNTED_STATUSES: LoanStatus[] = ['DISBURSED', 'OVERDUE', 'CLOSED', 'WRITTEN_OFF'];

export interface LoanApplicationInput {
  customerId: number;
  productId: number;
  principalAmount: number;
  interestMethod: InterestMethod;
  ratePercent: number;           // FLAT: মেয়াদের মোট %, DECLINING: বার্ষিক %
  totalInstallments: number;
  installmentFrequency: InstallmentFrequency;
  savingsPerInstallment: number;
  formFeePaid: number;
  insuranceFeePaid: number;
  purposeOfLoan: string;
  proposedFirstDueDate?: string;
}

export interface LoanEligibility {
  loanCycle: number;
  ceiling: number;
  minAmount: number;
  blockers: string[];
  warnings: string[];
}

/**
 * ঋণের অনুমোদন প্রবাহ (Maker-Checker):
 * আবেদন (APPLIED) → মাঠ যাচাই (FIELD_VERIFIED) → অনুমোদন (APPROVED, আবেদনকারী নিজে নয়) → বিতরণ (DISBURSED)
 */
@Injectable({ providedIn: 'root' })
export class LoanLifecycleService {
  private runner = inject(TxRunner);
  private settings = inject(SettingsService);
  private counters = inject(CounterService);
  private firestore = this.runner.firestore;

  /**
   * প্রথম কিস্তির ডিফল্ট তারিখ = আজ + গ্রেস পিরিয়ড (প্রোডাক্ট) বা ফ্রিকোয়েন্সি অনুযায়ী।
   * সাপ্তাহিক ঋণে সমিতির মিটিং-বারে সরানো হয় — সাপ্তাহিক কিস্তি সমিতির মিটিংয়েই আদায় হয়।
   */
  defaultFirstDueDate(product: LoanProduct | undefined, frequency: InstallmentFrequency, from = todayDhaka(), meetingDay?: string): string {
    const grace = product?.graceDays ?? (frequency === 'DAILY' ? 1 : frequency === 'MONTHLY' ? 30 : 7);
    return this.alignToMeetingDay(addDaysKey(from, Math.max(1, grace)), frequency, meetingDay);
  }

  /** সাপ্তাহিক কিস্তির তারিখ সমিতির মিটিং-বারে (ঐ দিন বা পরের সেই বার) */
  alignToMeetingDay(date: string, frequency: InstallmentFrequency, meetingDay?: string): string {
    const weekday = meetingDay ? MEETING_DAY_INDEX[meetingDay] : undefined;
    return frequency === 'WEEKLY' && weekday !== undefined ? onOrAfterWeekday(date, weekday) : date;
  }

  async getCenter(centerId: number): Promise<CenterOrSamity | undefined> {
    const snap = await getDoc(doc(this.firestore, 'centers', String(centerId)));
    return snap.exists() ? (snap.data() as CenterOrSamity) : undefined;
  }

  async previewSchedule(input: Pick<LoanApplicationInput, 'principalAmount' | 'interestMethod' | 'ratePercent' | 'totalInstallments' | 'installmentFrequency'>, firstDueDate: string, branchId: number): Promise<LoanSchedule> {
    const calendar = await this.settings.getCalendar(branchId);
    return buildSchedule({
      principal: input.principalAmount, ratePercent: input.ratePercent, method: input.interestMethod,
      count: input.totalInstallments, frequency: input.installmentFrequency, firstDueDate, calendar
    });
  }

  /** ঋণ চক্র, সীমা, চলমান ঋণ ও একাধিক শাখায় ঋণ (NID ওভারল্যাপ) যাচাই */
  async checkEligibility(customer: Customer, product: LoanProduct | undefined): Promise<LoanEligibility> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const ownLoans = await this.loansOf(customer.customerId);

    if (customer.status === 'CLOSED' || customer.status === 'INACTIVE') blockers.push('গ্রাহকের হিসাব সক্রিয় নয়');
    if (customer.creditScore === 'BLACKLISTED') blockers.push(`গ্রাহক কালো তালিকাভুক্ত${customer.blacklistReason ? ` (${customer.blacklistReason})` : ''}`);
    if (customer.creditScore === 'RISKY') warnings.push('গ্রাহকের পূর্ববর্তী ঋণে উল্লেখযোগ্য বকেয়া ছিল (ঝুঁকিপূর্ণ)');

    const open = ownLoans.filter(l => OPEN_LOAN_STATUSES.includes(l.status));
    if (open.length > 0 && !product?.allowConcurrentLoans) {
      blockers.push(`গ্রাহকের ইতোমধ্যে চলমান/প্রক্রিয়াধীন ঋণ আছে (${open.map(l => l.loanAccountNo).join(', ')})`);
    }

    // একই NID দিয়ে অন্য সদস্য হিসেবে ঋণ (একাধিক শাখা / সমিতি)
    const nid = normalizeNid(customer.nidNumber || '');
    if (nid) {
      const others = await this.customersWithNid(nid, customer.customerId);
      for (const other of others) {
        const otherOpen = (await this.loansOf(other.customerId)).filter(l => OPEN_LOAN_STATUSES.includes(l.status));
        if (otherOpen.length > 0) {
          blockers.push(`একই NID দিয়ে অন্য সদস্য হিসাব (#${other.customerId}, শাখা #${other.branchId})-এ চলমান ঋণ আছে — একাধিক ঋণ (ওভারল্যাপিং) ঝুঁকি`);
        } else {
          warnings.push(`একই NID দিয়ে আরেকটি সদস্য হিসাব আছে (#${other.customerId})`);
        }
      }
    }

    const loanCycle = ownLoans.filter(l => CYCLE_COUNTED_STATUSES.includes(l.status)).length + 1;
    const ceilings = product?.cycleCeilings || [];
    const ceiling = ceilings.length
      ? Math.min(ceilings[Math.min(loanCycle, ceilings.length) - 1], product?.maxAmount || Number.MAX_SAFE_INTEGER)
      : (product?.maxAmount || Number.MAX_SAFE_INTEGER);
    return { loanCycle, ceiling, minAmount: product?.minAmount || 0, blockers, warnings };
  }

  async createApplication(input: LoanApplicationInput, actor: Actor): Promise<Loan> {
    const custSnap = await getDoc(this.runner.customerRef(input.customerId));
    if (!custSnap.exists()) throw new Error('গ্রাহক পাওয়া যায়নি');
    const customer = custSnap.data() as Customer;
    const productSnap = await getDoc(doc(this.firestore, 'loanProducts', String(input.productId)));
    const product = productSnap.exists() ? (productSnap.data() as LoanProduct) : undefined;

    const elig = await this.checkEligibility(customer, product);
    if (elig.blockers.length) throw new Error(elig.blockers.join('\n'));
    if (input.principalAmount < elig.minAmount) throw new Error(`সর্বনিম্ন ঋণ ৳${elig.minAmount.toLocaleString('en-IN')}`);
    if (input.principalAmount > elig.ceiling) {
      throw new Error(`${elig.loanCycle}ম ঋণ চক্রে সর্বোচ্চ সীমা ৳${elig.ceiling.toLocaleString('en-IN')}`);
    }
    if (!(input.totalInstallments >= 1 && input.totalInstallments <= 450)) throw new Error('কিস্তির সংখ্যা ১–৪৫০ এর মধ্যে হতে হবে');
    if (!input.purposeOfLoan?.trim()) throw new Error('ঋণের উদ্দেশ্য লিখুন');

    const today = todayDhaka();
    const center = await this.getCenter(customer.centerId);
    const firstDue = input.proposedFirstDueDate || this.defaultFirstDueDate(product, input.installmentFrequency, today, center?.meetingDay);
    const schedule = await this.previewSchedule(input, firstDue, customer.branchId);

    const loanId = await this.counters.getNextIntegerId('loans');
    const now = new Date().toISOString();
    const loan: Loan = {
      loanId,
      loanAccountNo: `LN-${loanId}`,
      customerId: customer.customerId,
      customerName: customer.fullName,
      branchId: Number(customer.branchId),
      centerId: Number(customer.centerId),
      fieldOfficerUserId: Number(customer.assignedFieldOfficerId),
      productId: Number(input.productId),
      principalAmount: round2(input.principalAmount),
      interestOrServiceCharge: schedule.totalProfit,
      totalRepayableAmount: schedule.totalRepayable,
      installmentFrequency: input.installmentFrequency,
      totalInstallments: input.totalInstallments,
      installmentAmount: schedule.installmentAmount,
      lastInstallmentAmount: schedule.lastInstallmentAmount,
      savingsPerInstallment: input.savingsPerInstallment || 0,
      formFeePaid: input.formFeePaid || 0,
      insuranceFeePaid: input.insuranceFeePaid || 0,
      totalPaidAmount: 0, totalPrincipalPaid: 0, totalProfitPaid: 0, totalSavingsCollected: 0,
      outstandingBalance: schedule.totalRepayable,
      outstandingPrincipal: round2(input.principalAmount),
      paidInstallmentsCount: 0,
      remainingInstallmentsCount: input.totalInstallments,
      overdueAmount: 0, missedInstallmentsCount: 0,
      applicationDate: today,
      disbursementDate: '',
      firstInstallmentDueDate: firstDue,
      expectedClosingDate: schedule.expectedClosingDate,
      purposeOfLoan: input.purposeOfLoan.trim(),
      status: 'APPLIED',
      loanCycle: elig.loanCycle,
      interestMethod: input.interestMethod,
      ratePercent: input.ratePercent,
      effectiveAnnualRate: schedule.effectiveAnnualRate,
      appliedByUserId: actor.userId,
      appliedByName: actor.name,
      ledgerVersion: 0,
      isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
      history: [this.runner.audit.buildHistoryEntry({
        action: 'LOAN_APPLIED', changedByUserId: actor.userId, changedByName: actor.name, changedByRole: actor.role,
        reason: `ঋণ আবেদন: ৳${input.principalAmount} (${elig.loanCycle}ম চক্র)`, newData: { principalAmount: input.principalAmount, totalInstallments: input.totalInstallments }
      })]
    };

    const batch = writeBatch(this.firestore);
    batch.set(this.runner.loanRef(loanId), JSON.parse(JSON.stringify(loan)));
    batch.set(doc(collection(this.firestore, 'loanStatusHistory')), { loanId, fromStatus: null, toStatus: 'APPLIED', reason: 'ঋণ আবেদন', branchId: loan.branchId, timestamp: now, actor: this.runner.audit.actorStamp(actor) });
    this.runner.audit.writeAuditLog(batch, {
      entityType: 'loans', entityId: loanId, action: 'LOAN_APPLIED', reason: 'নতুন ঋণ আবেদন',
      changes: { status: { before: null, after: 'APPLIED' }, principalAmount: { before: null, after: loan.principalAmount } },
      branchId: loan.branchId, actor: this.runner.audit.actorStamp(actor)
    });
    await batch.commit();
    return loan;
  }

  async verify(loanId: number, notes: string, actor: Actor): Promise<void> {
    if (!notes.trim()) throw new Error('মাঠ যাচাইয়ের মন্তব্য লিখুন');
    if (!LOAN_VERIFY_ROLES.includes(actor.role)) throw new Error('মাঠ যাচাই শুধু মাঠকর্মী করতে পারেন');
    await this.transition(loanId, ['APPLIED'], 'FIELD_VERIFIED', 'LOAN_VERIFIED', notes, actor, loan => {
      if (actor.role === 'FIELD_OFFICER' && Number(loan.fieldOfficerUserId) !== Number(actor.userId)) {
        throw new Error('শুধু নিজের সমিতির / নিজের দায়িত্বের ঋণ আবেদন যাচাই করা যায়');
      }
      return {
      verifiedByUserId: actor.userId, verifiedByName: actor.name, verifiedAt: new Date().toISOString(), verificationNotes: notes.trim()
      };
    });
  }

  async approve(loanId: number, notes: string, actor: Actor): Promise<void> {
    if (!LOAN_APPROVE_ROLES.includes(actor.role)) throw new Error('ঋণ অনুমোদন শুধু শাখা ব্যবস্থাপক দিতে পারেন');
    await this.transition(loanId, ['FIELD_VERIFIED'], 'APPROVED', 'LOAN_APPROVED', notes || 'অনুমোদিত', actor, loan => {
      if (loan.appliedByUserId === actor.userId) {
        throw new Error('যিনি আবেদন করেছেন তিনি নিজে অনুমোদন দিতে পারবেন না (Maker-Checker নীতি)');
      }
      return { approvedByUserId: actor.userId, approvedByName: actor.name, approvedDate: todayDhaka() };
    });
  }

  async reject(loanId: number, reason: string, actor: Actor): Promise<void> {
    if (!reason.trim()) throw new Error('প্রত্যাখ্যানের কারণ লিখুন');
    await this.transition(loanId, ['APPLIED', 'FIELD_VERIFIED', 'APPROVED'], 'REJECTED', 'LOAN_REJECTED', reason, actor, () => ({
      rejectedByUserId: actor.userId, rejectedByName: actor.name, rejectedAt: new Date().toISOString(), rejectedReason: reason.trim()
    }));
  }

  private async transition(
    loanId: number, from: LoanStatus[], to: LoanStatus, action: 'LOAN_VERIFIED' | 'LOAN_APPROVED' | 'LOAN_REJECTED',
    reason: string, actor: Actor, extra: (loan: Loan) => Partial<Loan>
  ): Promise<void> {
    await this.runner.run(actor, `${action}-${loanId}`, async s => {
      const snap = await s.tx.get(this.runner.loanRef(loanId));
      if (!snap.exists()) throw new Error('ঋণ পাওয়া যায়নি');
      const loan = snap.data() as Loan;
      if (!from.includes(loan.status)) throw new Error(`এই ধাপে ঋণটি "${loan.status}" অবস্থায় আছে — কাজটি করা যাবে না`);
      const fields: Partial<Loan> = { ...extra(loan), status: to };
      s.update(this.runner.loanRef(loanId), { ...fields, history: s.appendHistory(loan, s.historyEntry(action, reason, loan, fields)) });
      s.statusChange(loanId, loan.branchId, loan.status, to, reason);
      s.audit('loans', loanId, action, reason, { status: { before: loan.status, after: to } }, loan.branchId);
    });
  }

  /**
   * অনুমোদিত ঋণ বিতরণ — একটি ট্রানজ্যাকশনে: কিস্তি শিডিউল (ছুটি বাদে), ভল্ট থেকে টাকা বের,
   * ফি জমা, গ্রাহকের ঋণ কাউন্টার, ঋণ খতিয়ান ও জার্নাল।
   */
  async disburse(loanId: number, options: { firstDueDate?: string; customLoanAccountNo?: string }, actor: Actor): Promise<{ loan: Loan; installments: InstallmentSchedule[] }> {
    let pre!: Loan;
    let schedule!: LoanSchedule;
    let accountNo = '';
    if (!LOAN_DISBURSE_ROLES.includes(actor.role)) throw new Error('ঋণ বিতরণ (ভল্ট থেকে টাকা প্রদান) শুধু ক্যাশিয়ার করতে পারেন');

    return this.runner.run(actor, `DSB-${loanId}`, async s => {
      const loanSnap = await s.tx.get(this.runner.loanRef(loanId));
      const loan = loanSnap.data() as Loan;
      if (loan.status !== 'APPROVED') throw new Error('শুধু অনুমোদিত (APPROVED) ঋণ বিতরণ করা যায়');
      const custSnap = await s.tx.get(this.runner.customerRef(loan.customerId));
      const customer = custSnap.data() as Customer;
      await s.assertDayOpen(loan.branchId);
      await s.readBranch(loan.branchId);
      const n = schedule.rows.length;
      const firstInstId = await s.reserve('installments', n);
      const loanTxnId = await s.reserve('loanTransactions', 1);
      const journalId = await s.reserve('journalEntries', 1);
      const fees = [
        { type: 'LOAN_FORM' as const, amount: round2(loan.formFeePaid || 0), account: ACCOUNTS.FEE_INCOME },
        { type: 'INSURANCE' as const, amount: round2(loan.insuranceFeePaid || 0), account: ACCOUNTS.LOAN_RISK_FUND }
      ].filter(f => f.amount > 0);
      const feeIds = fees.length ? await s.reserve('feeTransactions', fees.length) : 0;
      const vaultIds = await s.reserve('vaultTransactions', 1 + fees.length);

      const principal = round2(loan.principalAmount);
      const feeTotal = fees.reduce((sum, f) => sum + f.amount, 0);
      // ফি আগে ভল্টে, তারপর ঋণের টাকা বের (ভল্ট যাচাই এর পরে)
      fees.forEach((f, idx) => {
        s.vaultMove({ id: vaultIds + 1 + idx, branchId: loan.branchId, type: 'FEE_IN', direction: 'IN', amount: f.amount, refType: 'LOAN', refId: loanId, note: f.type === 'LOAN_FORM' ? 'ঋণ ফরম ফি' : 'বীমা / ঋণ ঝুঁকি তহবিল' });
        s.fee({ id: feeIds + idx, branchId: loan.branchId, customerId: loan.customerId, loanId, feeType: f.type, amount: f.amount });
      });
      s.vaultMove({ id: vaultIds, branchId: loan.branchId, type: 'DISBURSEMENT_OUT', direction: 'OUT', amount: principal, refType: 'LOAN', refId: loanId, note: `${accountNo} বিতরণ` });

      const installments: InstallmentSchedule[] = schedule.rows.map((r, idx) => ({
        installmentId: firstInstId + idx, loanId, customerId: loan.customerId,
        branchId: Number(loan.branchId), centerId: Number(loan.centerId), fieldOfficerUserId: Number(loan.fieldOfficerUserId),
        installmentNo: r.installmentNo, dueDate: r.dueDate,
        expectedPrincipal: r.principal, expectedProfit: r.profit,
        expectedSavings: loan.savingsPerInstallment || 0,
        expectedTotalAmount: r.total + (loan.savingsPerInstallment || 0),
        paidPrincipal: 0, paidProfit: 0, paidSavings: 0, paidTotalAmount: 0, status: 'PENDING',
        isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: []
      }));
      installments.forEach(inst => s.set(this.runner.installmentRef(inst.installmentId), inst));

      const fields: Partial<Loan> = {
        loanAccountNo: accountNo,
        status: 'DISBURSED',
        disbursementDate: s.businessDate,
        firstInstallmentDueDate: schedule.rows[0].dueDate,
        expectedClosingDate: schedule.expectedClosingDate,
        interestOrServiceCharge: schedule.totalProfit,
        totalRepayableAmount: schedule.totalRepayable,
        installmentAmount: schedule.installmentAmount,
        lastInstallmentAmount: schedule.lastInstallmentAmount,
        effectiveAnnualRate: schedule.effectiveAnnualRate,
        outstandingBalance: schedule.totalRepayable,
        outstandingPrincipal: principal,
        remainingInstallmentsCount: n,
        disbursedByUserId: actor.userId,
        disbursedByName: actor.name,
        classification: 'STANDARD',
        daysPastDue: 0,
        ledgerVersion: (loan.ledgerVersion || 0) + 1
      };
      s.update(this.runner.loanRef(loanId), { ...fields, history: s.appendHistory(loan, s.historyEntry('LOAN_DISBURSED', `ঋণ বিতরণ ৳${principal}`, loan, fields)) });
      s.statusChange(loanId, loan.branchId, 'APPROVED', 'DISBURSED', 'ঋণ বিতরণ');

      const custFields = { totalLoansTaken: (customer.totalLoansTaken || 0) + 1, activeLoansCount: (customer.activeLoansCount || 0) + 1 };
      s.update(this.runner.customerRef(loan.customerId), { ...custFields, history: s.appendHistory(customer, s.historyEntry('UPDATE', `ঋণ ${accountNo} বিতরণ`, customer, custFields)) });

      s.loanTxn({ id: loanTxnId, loanId, customerId: loan.customerId, branchId: loan.branchId, type: 'DISBURSEMENT', principal, profit: schedule.totalProfit, outstandingBefore: 0, outstandingAfter: schedule.totalRepayable });
      s.journal(journalId, loan.branchId, `ঋণ বিতরণ — ${accountNo}`, [
        { account: ACCOUNTS.LOANS_RECEIVABLE, debit: principal, credit: 0 },
        { account: ACCOUNTS.VAULT_CASH, debit: feeTotal, credit: principal },
        ...fees.map(f => ({ account: f.account, debit: 0, credit: f.amount }))
      ]);
      s.audit('loans', loanId, 'LOAN_DISBURSED', 'ঋণ বিতরণ', { status: { before: 'APPROVED', after: 'DISBURSED' }, disbursementDate: { before: null, after: s.businessDate } }, loan.branchId);
      if (customer.phonePrimary) {
        s.queueSms({ to: customer.phonePrimary, type: 'DISBURSEMENT', relatedId: loanId, branchId: Number(loan.branchId), message: `eKisti: ${accountNo}-এ ৳${principal} ঋণ বিতরণ হয়েছে। প্রথম কিস্তি ${schedule.rows[0].dueDate}, কিস্তি ৳${schedule.installmentAmount}।` });
      }
      return { loan: { ...loan, ...fields } as Loan, installments };
    }, async () => {
      pre = await this.runner.getLoan(loanId);
      if (pre.status !== 'APPROVED') throw new Error('শুধু অনুমোদিত (APPROVED) ঋণ বিতরণ করা যায়');
      const today = todayDhaka();
      const center = await this.getCenter(pre.centerId);
      const firstDue = options.firstDueDate || (pre.firstInstallmentDueDate > today
        ? pre.firstInstallmentDueDate
        : this.alignToMeetingDay(addDaysKey(today, 7), pre.installmentFrequency, center?.meetingDay));
      if (firstDue <= today) throw new Error('প্রথম কিস্তির তারিখ আজকের পরে হতে হবে');
      schedule = await this.previewSchedule({
        principalAmount: pre.principalAmount, interestMethod: pre.interestMethod || 'FLAT',
        ratePercent: pre.ratePercent ?? (pre.interestOrServiceCharge / pre.principalAmount) * 100,
        totalInstallments: pre.totalInstallments, installmentFrequency: pre.installmentFrequency
      }, firstDue, pre.branchId);
      accountNo = await this.resolveAccountNo(loanId, options.customLoanAccountNo);
    });
  }

  /** কাস্টম ঋণ হিসাব নং — অনন্য হতে হবে */
  async resolveAccountNo(loanId: number, custom?: string): Promise<string> {
    const trimmed = (custom || '').trim().toUpperCase();
    if (!trimmed) return `LN-${loanId}`;
    const accountNo = trimmed.startsWith('LN-') ? trimmed : `LN-${trimmed}`;
    const snap = await getDocs(query(collection(this.firestore, 'loans'), where('loanAccountNo', '==', accountNo)));
    if (snap.docs.some(d => (d.data() as Loan).loanId !== loanId)) {
      throw new Error(`ঋণ হিসাব নং ${accountNo} ইতোমধ্যে ব্যবহৃত`);
    }
    return accountNo;
  }

  async getPipeline(branchIds: number[] | null): Promise<Loan[]> {
    const snap = await getDocs(query(collection(this.firestore, 'loans'), where('status', 'in', ['APPLIED', 'FIELD_VERIFIED', 'APPROVED'])));
    return snap.docs.map(d => d.data() as Loan)
      .filter(l => !l.isDeleted && (branchIds === null || branchIds.includes(Number(l.branchId))))
      .sort((a, b) => b.loanId - a.loanId);
  }

  private async loansOf(customerId: number): Promise<Loan[]> {
    const snap = await getDocs(query(collection(this.firestore, 'loans'), where('customerId', '==', Number(customerId))));
    return snap.docs.map(d => d.data() as Loan).filter(l => !l.isDeleted);
  }

  private async customersWithNid(nid: string, excludeId: number): Promise<Customer[]> {
    const snap = await getDocs(query(collection(this.firestore, 'customers'), where('nidNumber', '==', nid)));
    return snap.docs.map(d => d.data() as Customer).filter(c => !c.isDeleted && c.customerId !== excludeId);
  }
}
