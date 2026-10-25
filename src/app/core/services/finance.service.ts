import { Injectable, inject } from '@angular/core';
import { collection, doc, getDocs, query, where } from '@angular/fire/firestore';
import {
  Customer,
  FollowUp,
  InstallmentFrequency,
  InstallmentSchedule,
  InstallmentStatus,
  InsuranceClaim,
  Loan,
  LoanStatus,
  LoanStatusChange,
  LoanTransaction,
  PaymentCollection,
  SavingsTransaction
} from '../models/database.models';
import { InstallmentAllocation, allocatePayment, isSettledStatus, remainingOf } from '../finance/allocation';
import { loanOverdueState, outstandingPrincipal } from '../finance/classification';
import { earlySettlementQuote } from '../finance/settlement';
import { ACCOUNTS, collectionCashAccount } from '../finance/accounts';
import { buildScheduleFromTotals } from '../finance/schedule';
import { todayDhaka } from '../finance/dates';
import { SettingsService } from './settings.service';
import { Actor, ConcurrentChangeError, TxRunner } from './tx-runner.service';
import { TxSession, round2 } from './tx-session';

export type PaymentMethod = PaymentCollection['paymentMethod'];

const COLLECTABLE_STATUSES: LoanStatus[] = ['DISBURSED', 'OVERDUE'];

interface ApplyPaymentPlan {
  allocations: InstallmentAllocation[];
  principal: number;
  profit: number;
  savings: number;
  rebate: number;
  isAdvance: boolean;
}

/**
 * ঋণের টাকা-সংক্রান্ত সব অপারেশন — প্রতিটি একটি Firestore ট্রানজ্যাকশনে:
 * রসিদ + কিস্তি + ঋণ + সঞ্চয় + ঋণ খতিয়ান + জার্নাল + অডিট একসাথে, আংশিক লেখা অসম্ভব।
 */
@Injectable({ providedIn: 'root' })
export class FinanceService {
  private runner = inject(TxRunner);
  private settings = inject(SettingsService);
  private firestore = this.runner.firestore;

  // =====================================================================
  // ১. কিস্তি আদায় (আংশিক / একাধিক / অগ্রিম)
  // =====================================================================

  async collectPayment(params: {
    loanId: number;
    loanAmount: number;          // আসল + লাভ অংশ
    savingsAmount: number;
    paymentMethod: PaymentMethod;
    trxId?: string;
    receiptNumberManual?: string;
    allowAdvance?: boolean;      // ভবিষ্যতের কিস্তি আগাম নেওয়ার অনুমতি (স্পষ্টভাবে নিশ্চিত)
    reason?: string;
  }, actor: Actor): Promise<PaymentCollection> {
    if (!(params.loanAmount >= 0) || !(params.savingsAmount >= 0) || params.loanAmount + params.savingsAmount <= 0) {
      throw new Error('আদায়ের সঠিক পরিমাণ দিন');
    }
    if (params.paymentMethod !== 'CASH' && !params.trxId?.trim()) {
      throw new Error('বিকাশ/নগদ/ব্যাংক আদায়ে TrxID বা রেফারেন্স নম্বর বাধ্যতামূলক');
    }

    let pre!: { loan: Loan; installments: InstallmentSchedule[] };
    let plan!: ApplyPaymentPlan;
    return this.runner.run(actor, 'COL', s => this.applyPayment(s, pre, plan, {
      mode: 'COLLECTION', paymentMethod: params.paymentMethod, trxId: params.trxId,
      receiptNumberManual: params.receiptNumberManual, reason: params.reason || 'কিস্তি আদায়'
    }), async () => {
      pre = await this.runner.loadLoanBundle(params.loanId);
      this.assertCollectable(pre.loan);
      const today = todayDhaka();
      const alloc = allocatePayment(pre.installments, round2(params.loanAmount), round2(params.savingsAmount), today);
      if (alloc.unallocated > 0) {
        throw new Error(`ঋণের মোট বাকি (৳${this.openTotal(pre.installments).toLocaleString('en-IN')}) এর চেয়ে বেশি টাকা নেওয়া যাবে না। পুরো ঋণ পরিশোধ করতে "আগাম পরিশোধ" ব্যবহার করুন।`);
      }
      const touchesFuture = alloc.allocations.some(a => {
        const inst = pre.installments.find(i => i.installmentId === a.installmentId)!;
        return inst.dueDate > today && (a.principal + a.profit) > 0;
      });
      if (touchesFuture && !params.allowAdvance) {
        throw new Error('আজ পর্যন্ত বকেয়ার চেয়ে বেশি টাকা — পরের কিস্তির আগাম আদায়। "অগ্রিম কিস্তি" নিশ্চিত করে আবার চেষ্টা করুন।');
      }
      plan = {
        allocations: alloc.allocations,
        principal: alloc.principalTotal,
        profit: alloc.profitTotal,
        savings: alloc.savingsTotal,
        rebate: 0,
        isAdvance: touchesFuture
      };
    });
  }

  /**
   * গ্রাহক কিস্তির টাকা দিতে না পারলে তার সঞ্চয় হতে কিস্তি পরিশোধ (মাঠকর্মী/শাখা)।
   * নগদ লেনদেন নেই: সঞ্চয় স্থিতি কমে, কিস্তি পরিশোধ হয়, রসিদ হয় (মাধ্যম SAVINGS) —
   * রসিদটি শুরু থেকেই "জমা সম্পন্ন", তাই মাঠকর্মীর হাতের নগদ বা ক্যাশ ক্লোজিংয়ে আসে না।
   * শুধু আজ পর্যন্ত দেয় কিস্তি (অগ্রিম নয়) এবং সঞ্চয় স্থিতির বেশি নয়। ভুল হলে রসিদ বাতিলে সঞ্চয় ফেরত যায়।
   */
  async collectFromSavings(params: { loanId: number; loanAmount: number; reason: string }, actor: Actor): Promise<PaymentCollection> {
    if (!(params.loanAmount > 0)) throw new Error('সমন্বয়ের সঠিক পরিমাণ দিন');
    if (!params.reason?.trim()) throw new Error('সঞ্চয় হতে কিস্তি পরিশোধের কারণ লেখা বাধ্যতামূলক');

    let pre!: { loan: Loan; installments: InstallmentSchedule[] };
    let plan!: ApplyPaymentPlan;
    return this.runner.run(actor, 'SAVKISTI', s => this.applyPayment(s, pre, plan, {
      mode: 'SAVINGS_ADJUSTMENT', paymentMethod: 'SAVINGS',
      reason: `সঞ্চয় হতে কিস্তি পরিশোধ — ${params.reason.trim()}`
    }), async () => {
      pre = await this.runner.loadLoanBundle(params.loanId);
      this.assertCollectable(pre.loan);
      const today = todayDhaka();
      const alloc = allocatePayment(pre.installments, round2(params.loanAmount), 0, today);
      const touchesFuture = alloc.unallocated > 0 || alloc.allocations.some(a => {
        const inst = pre.installments.find(i => i.installmentId === a.installmentId)!;
        return inst.dueDate > today && (a.principal + a.profit) > 0;
      });
      if (touchesFuture) throw new Error('সঞ্চয় হতে শুধু আজ পর্যন্ত দেয় (বকেয়া + আজকের) কিস্তি পরিশোধ করা যায় — অগ্রিম কিস্তি নয়');
      plan = {
        allocations: alloc.allocations,
        principal: alloc.principalTotal,
        profit: alloc.profitTotal,
        savings: 0,
        rebate: 0,
        isAdvance: false
      };
    });
  }

  /** আগাম পরিশোধ (Early Settlement) — বাকি আসল + বকেয়া লাভ + ভবিষ্যৎ লাভ − রিবেট */
  async earlySettle(params: { loanId: number; paymentMethod: PaymentMethod; trxId?: string; rebatePercent?: number; reason?: string }, actor: Actor): Promise<PaymentCollection> {
    let pre!: { loan: Loan; installments: InstallmentSchedule[] };
    let plan!: ApplyPaymentPlan;
    return this.runner.run(actor, 'SET', s => this.applyPayment(s, pre, plan, {
      mode: 'EARLY_SETTLEMENT', paymentMethod: params.paymentMethod, trxId: params.trxId,
      reason: params.reason || 'আগাম পরিশোধে ঋণ নিষ্পত্তি'
    }), async () => {
      pre = await this.runner.loadLoanBundle(params.loanId);
      this.assertCollectable(pre.loan);
      const rebatePercent = params.rebatePercent ?? (await this.productRebatePercent(pre.loan.productId));
      const today = todayDhaka();
      const quote = earlySettlementQuote(pre.installments, today, rebatePercent);

      // ভবিষ্যৎ কিস্তির লাভ থেকে রিবেট আনুপাতিক হারে বাদ (শেষ কিস্তিতে অবশিষ্ট)
      const open = pre.installments.filter(i => !isSettledStatus(i.status)).sort((a, b) => a.installmentNo - b.installmentNo);
      const future = open.filter(i => i.dueDate > today);
      let rebateLeft = quote.rebate;
      const allocations: InstallmentAllocation[] = open.map(inst => {
        const rem = remainingOf(inst);
        let profit = rem.profit;
        if (inst.dueDate > today && quote.futureProfit > 0) {
          const isLastFuture = inst === future[future.length - 1];
          const share = isLastFuture ? rebateLeft : Math.round(quote.rebate * rem.profit / quote.futureProfit);
          const cut = Math.min(profit, share);
          rebateLeft -= cut;
          profit -= cut;
        }
        return {
          installmentId: inst.installmentId, installmentNo: inst.installmentNo,
          principal: rem.principal, profit, savings: 0,
          previousStatus: inst.status, newStatus: 'PAID' as InstallmentStatus
        };
      });
      plan = {
        allocations,
        principal: allocations.reduce((s, a) => s + a.principal, 0),
        profit: allocations.reduce((s, a) => s + a.profit, 0),
        savings: 0,
        rebate: quote.rebate,
        isAdvance: false
      };
    });
  }

  private async applyPayment(
    s: TxSession,
    pre: { loan: Loan; installments: InstallmentSchedule[] },
    plan: ApplyPaymentPlan,
    opts: { mode: 'COLLECTION' | 'EARLY_SETTLEMENT' | 'SAVINGS_ADJUSTMENT'; paymentMethod: PaymentMethod; trxId?: string; receiptNumberManual?: string; reason: string }
  ): Promise<PaymentCollection> {
    const { loan } = pre;

    // ---------- READ ----------
    const loanSnap = await s.tx.get(this.runner.loanRef(loan.loanId));
    const freshLoan = loanSnap.data() as Loan;
    if ((freshLoan.ledgerVersion || 0) !== (loan.ledgerVersion || 0) || freshLoan.totalPaidAmount !== loan.totalPaidAmount) {
      throw new ConcurrentChangeError();
    }
    const instSnaps = await Promise.all(plan.allocations.map(a => s.tx.get(this.runner.installmentRef(a.installmentId))));
    const freshInsts = instSnaps.map(snap => snap.data() as InstallmentSchedule);
    freshInsts.forEach((fi, idx) => {
      const old = pre.installments.find(i => i.installmentId === plan.allocations[idx].installmentId)!;
      if (fi.status !== old.status || (fi.paidPrincipal || 0) !== (old.paidPrincipal || 0) || (fi.paidProfit || 0) !== (old.paidProfit || 0)) {
        throw new ConcurrentChangeError();
      }
    });
    const custSnap = await s.tx.get(this.runner.customerRef(loan.customerId));
    const customer = custSnap.exists() ? (custSnap.data() as Customer) : null;
    const fromSavings = opts.mode === 'SAVINGS_ADJUSTMENT';
    const loanPaid = round2(plan.principal + plan.profit);
    if (fromSavings && (!customer || loanPaid > round2(customer.totalSavingsBalance || 0))) {
      throw new Error(`গ্রাহকের সঞ্চয় স্থিতি (৳${(customer?.totalSavingsBalance || 0).toLocaleString('en-IN')}) সমন্বয়ের টাকার (৳${loanPaid.toLocaleString('en-IN')}) চেয়ে কম`);
    }
    await s.assertDayOpen(loan.branchId);
    const receiptId = await s.reserve('receipts', 1);
    const loanTxnId = await s.reserve('loanTransactions', plan.rebate > 0 ? 2 : 1);
    const journalId = await s.reserve('journalEntries', 1);
    const savingsTxnId = plan.savings > 0 || fromSavings ? await s.reserve('savings', 1) : 0;

    // ---------- COMPUTE ----------
    s.correlationId = `${opts.mode === 'COLLECTION' ? 'COL' : opts.mode === 'EARLY_SETTLEMENT' ? 'SET' : 'SAVK'}-${receiptId}`;
    const today = s.businessDate;
    const total = round2(loanPaid + plan.savings);

    const updatedInsts = new Map<number, InstallmentSchedule>();
    plan.allocations.forEach((a, idx) => {
      const fi = freshInsts[idx];
      const paidSavings = round2((fi.paidSavings || 0) + a.savings);
      updatedInsts.set(a.installmentId, {
        ...fi,
        paidPrincipal: round2((fi.paidPrincipal || 0) + a.principal),
        paidProfit: round2((fi.paidProfit || 0) + a.profit),
        paidSavings,
        paidTotalAmount: round2((fi.paidTotalAmount || 0) + a.principal + a.profit + a.savings),
        status: a.newStatus,
        paidDate: (a.principal + a.profit) > 0 ? s.now : fi.paidDate,
        collectionReceiptId: (a.principal + a.profit) > 0 ? receiptId : fi.collectionReceiptId,
        receiptIds: [...(fi.receiptIds || []), receiptId]
      });
    });
    const merged = pre.installments.map(i => updatedInsts.get(i.installmentId) || i);
    const loanUpdate = this.recomputeLoan(freshLoan, merged, today, {
      principalDelta: plan.principal, profitDelta: plan.profit, savingsDelta: plan.savings
    });
    if (plan.rebate > 0) {
      loanUpdate.rebateAmount = round2((freshLoan.rebateAmount || 0) + plan.rebate);
      loanUpdate.outstandingBalance = 0;
      loanUpdate.outstandingPrincipal = 0;
      loanUpdate.status = 'CLOSED';
      loanUpdate.actualClosedDate = s.now;
    }
    const closedNow = loanUpdate.status === 'CLOSED' && freshLoan.status !== 'CLOSED';

    const receipt: PaymentCollection = {
      receiptId,
      receiptNumberManual: opts.receiptNumberManual || undefined,
      loanId: loan.loanId,
      customerId: loan.customerId,
      customerName: loan.customerName,
      installmentId: plan.allocations[0]?.installmentId,
      installmentNo: plan.allocations[0]?.installmentNo || 0,
      branchId: Number(loan.branchId),
      centerId: Number(loan.centerId),
      collectedByUserId: s.actor.userId,
      collectedByName: s.actor.name,
      principalAmountCollected: round2(plan.principal),
      profitAmountCollected: round2(plan.profit),
      savingsAmountCollected: round2(plan.savings),
      fineAmountCollected: 0,
      totalAmountCollected: total,
      paymentMethod: opts.paymentMethod,
      trxId: opts.trxId?.trim() || undefined,
      collectionDate: s.now,
      // সঞ্চয় হতে সমন্বয়ে হাতে কোনো নগদ নেই — ক্যাশিয়ারকে বুঝিয়ে দেওয়ার কিছু নেই
      isHandedOverToBranch: fromSavings,
      reconciledAt: fromSavings ? s.now : undefined,
      receiptType: 'KISTI',
      allocations: plan.allocations.map(a => ({ installmentId: a.installmentId, installmentNo: a.installmentNo, principal: a.principal, profit: a.profit, savings: a.savings })),
      isAdvance: plan.isAdvance,
      correlationId: s.correlationId,
      isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
      history: []
    };
    receipt.history = [s.historyEntry('PAYMENT_COLLECTED', opts.reason, undefined, { receiptId, total, allocations: receipt.allocations })];

    // ---------- WRITE ----------
    s.set(doc(this.firestore, 'collections', String(receiptId)), receipt);

    for (const a of plan.allocations) {
      const next = updatedInsts.get(a.installmentId)!;
      const fields = {
        paidPrincipal: next.paidPrincipal, paidProfit: next.paidProfit, paidSavings: next.paidSavings,
        paidTotalAmount: next.paidTotalAmount, status: next.status, paidDate: next.paidDate,
        collectionReceiptId: next.collectionReceiptId, receiptIds: next.receiptIds
      };
      const old = freshInsts.find(f => f.installmentId === a.installmentId)!;
      s.update(this.runner.installmentRef(a.installmentId), {
        ...fields,
        history: s.appendHistory(old, s.historyEntry('PAYMENT_COLLECTED', `রসিদ #${receiptId}`, old, fields))
      });
    }

    s.update(this.runner.loanRef(loan.loanId), {
      ...loanUpdate,
      history: s.appendHistory(freshLoan, s.historyEntry('PAYMENT_COLLECTED', `রসিদ #${receiptId}: ৳${loanPaid}`, freshLoan, loanUpdate))
    });
    s.statusChange(loan.loanId, loan.branchId, freshLoan.status, loanUpdate.status!, opts.mode === 'EARLY_SETTLEMENT' ? 'আগাম পরিশোধ' : 'কিস্তি আদায়');

    if (customer && (plan.savings > 0 || closedNow || fromSavings)) {
      const custFields: Record<string, any> = {};
      if (plan.savings > 0) custFields['totalSavingsBalance'] = round2((customer.totalSavingsBalance || 0) + plan.savings);
      if (fromSavings) custFields['totalSavingsBalance'] = round2((customer.totalSavingsBalance || 0) - loanPaid);
      if (closedNow) custFields['activeLoansCount'] = Math.max(0, (customer.activeLoansCount || 0) - 1);
      s.update(this.runner.customerRef(customer.customerId), {
        ...custFields,
        history: s.appendHistory(customer, s.historyEntry('PAYMENT_COLLECTED', `রসিদ #${receiptId}`, customer, custFields))
      });
      if (plan.savings > 0) {
        const prevBal = customer.totalSavingsBalance || 0;
        const savingsTxn: SavingsTransaction = {
          transactionId: savingsTxnId,
          customerId: customer.customerId,
          customerName: customer.fullName,
          branchId: Number(loan.branchId),
          centerId: Number(loan.centerId),
          loanId: loan.loanId,
          installmentNo: receipt.installmentNo,
          type: 'KISTI_COLLECTION',
          amount: plan.savings,
          isCredit: true,
          previousBalance: prevBal,
          newBalance: round2(prevBal + plan.savings),
          paymentMethod: opts.paymentMethod,
          transactionDate: s.now,
          performedByUserId: s.actor.userId,
          performedByName: s.actor.name,
          performedByRole: s.actor.role,
          reason: `কিস্তির সাথে সঞ্চয় জমা (+৳ ${plan.savings})`,
          receiptNo: `RCP-${receiptId}`,
          correlationId: s.correlationId,
          isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
          history: []
        };
        s.set(doc(this.firestore, 'savingsTransactions', String(savingsTxnId)), savingsTxn);
      }
      if (fromSavings) {
        const prevBal = customer.totalSavingsBalance || 0;
        const savingsTxn: SavingsTransaction = {
          transactionId: savingsTxnId,
          customerId: customer.customerId,
          customerName: customer.fullName,
          branchId: Number(loan.branchId),
          centerId: Number(loan.centerId),
          loanId: loan.loanId,
          installmentNo: receipt.installmentNo,
          type: 'ADJUSTMENT',
          amount: loanPaid,
          isCredit: false,
          previousBalance: prevBal,
          newBalance: round2(prevBal - loanPaid),
          paymentMethod: 'SAVINGS',
          transactionDate: s.now,
          performedByUserId: s.actor.userId,
          performedByName: s.actor.name,
          performedByRole: s.actor.role,
          reason: `${opts.reason} (−৳ ${loanPaid}, ${loan.loanAccountNo})`,
          receiptNo: `RCP-${receiptId}`,
          correlationId: s.correlationId,
          isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
          history: []
        };
        s.set(doc(this.firestore, 'savingsTransactions', String(savingsTxnId)), savingsTxn);
      }
    }

    const outstandingBefore = freshLoan.outstandingBalance || 0;
    s.loanTxn({
      id: loanTxnId, loanId: loan.loanId, customerId: loan.customerId, branchId: loan.branchId,
      type: opts.mode === 'EARLY_SETTLEMENT' ? 'EARLY_SETTLEMENT' : fromSavings ? 'ADJUSTMENT_FROM_SAVINGS' : 'REPAYMENT',
      principal: plan.principal, profit: plan.profit,
      outstandingBefore, outstandingAfter: round2(outstandingBefore - loanPaid),
      receiptId
    });
    if (plan.rebate > 0) {
      s.loanTxn({
        id: loanTxnId + 1, loanId: loan.loanId, customerId: loan.customerId, branchId: loan.branchId,
        type: 'REBATE', principal: 0, profit: plan.rebate,
        outstandingBefore: round2(outstandingBefore - loanPaid), outstandingAfter: 0, receiptId,
        note: 'আগাম পরিশোধে ভবিষ্যৎ সার্ভিস চার্জ মওকুফ'
      });
    }

    // সঞ্চয় হতে সমন্বয়: ডেবিট সদস্য সঞ্চয় (collectionCashAccount('SAVINGS')), নগদ নয়
    s.journal(journalId, loan.branchId, `${fromSavings ? 'সঞ্চয় হতে কিস্তি সমন্বয়' : 'কিস্তি আদায়'} — রসিদ #${receiptId} (${loan.loanAccountNo})`, [
      { account: collectionCashAccount(opts.paymentMethod), debit: total, credit: 0 },
      { account: ACCOUNTS.LOANS_RECEIVABLE, debit: 0, credit: plan.principal },
      { account: ACCOUNTS.SERVICE_CHARGE_INCOME, debit: 0, credit: plan.profit },
      { account: ACCOUNTS.MEMBER_SAVINGS, debit: 0, credit: plan.savings }
    ]);

    s.audit('collections', receiptId, 'PAYMENT_COLLECTED', opts.reason, { totalAmountCollected: { before: null, after: total } }, loan.branchId);

    if (customer?.phonePrimary) {
      s.queueSms({
        to: customer.phonePrimary,
        type: 'COLLECTION_RECEIPT',
        relatedId: receiptId,
        branchId: Number(loan.branchId),
        message: fromSavings
          ? `eKisti: রসিদ #${receiptId}, আপনার সঞ্চয় হতে ৳${total} কেটে ${loan.loanAccountNo}-এর কিস্তি পরিশোধ হয়েছে। সঞ্চয় স্থিতি ৳${round2((customer.totalSavingsBalance || 0) - loanPaid)}, ঋণের বাকি ৳${loanUpdate.outstandingBalance}।`
          : `eKisti: রসিদ #${receiptId}, ${loan.loanAccountNo}-এ ৳${total} জমা হয়েছে। ঋণের বাকি ৳${loanUpdate.outstandingBalance}।`
      });
    }

    return receipt;
  }

  // =====================================================================
  // ২. রসিদ বাতিল (রিভার্সাল) — রসিদ মোছা হয় না, উল্টো এন্ট্রি হয়
  // =====================================================================

  async reverseReceipt(receiptId: number, reason: string, actor: Actor): Promise<void> {
    if (!reason.trim()) throw new Error('রসিদ বাতিলের কারণ লেখা বাধ্যতামূলক');
    let pre!: { loan: Loan; installments: InstallmentSchedule[]; receipt: PaymentCollection };

    await this.runner.run(actor, `REV-${receiptId}`, async s => {
      const receiptRef = doc(this.firestore, 'collections', String(receiptId));
      const receiptSnap = await s.tx.get(receiptRef);
      const receipt = receiptSnap.data() as PaymentCollection;
      if (receipt.isReversed) throw new Error('রসিদটি ইতোমধ্যে বাতিল করা হয়েছে');
      const loanSnap = await s.tx.get(this.runner.loanRef(receipt.loanId));
      const freshLoan = loanSnap.data() as Loan;
      if ((freshLoan.ledgerVersion || 0) !== (pre.loan.ledgerVersion || 0)) throw new ConcurrentChangeError();

      const allocations = receipt.allocations?.length
        ? receipt.allocations
        : (receipt.installmentId ? [{
          installmentId: receipt.installmentId, installmentNo: receipt.installmentNo,
          principal: receipt.principalAmountCollected, profit: receipt.profitAmountCollected, savings: receipt.savingsAmountCollected
        }] : []);
      const instSnaps = await Promise.all(allocations.map(a => s.tx.get(this.runner.installmentRef(a.installmentId))));
      const custSnap = await s.tx.get(this.runner.customerRef(receipt.customerId));
      const customer = custSnap.exists() ? (custSnap.data() as Customer) : null;
      await s.assertDayOpen(receipt.branchId);
      // ভল্ট থেকে ফেরত শুধু নগদ রসিদে যা ইতোমধ্যে ভল্টে জমা হয়েছে
      const vaultOut = receipt.isHandedOverToBranch && receipt.paymentMethod === 'CASH';
      // সঞ্চয় হতে কিস্তি সমন্বয়ের রসিদ বাতিল → টাকা গ্রাহকের সঞ্চয়ে ফেরত
      const fromSavings = receipt.paymentMethod === 'SAVINGS';
      if (vaultOut) await s.readBranch(receipt.branchId);
      const loanTxnId = await s.reserve('loanTransactions', 1);
      const journalId = await s.reserve('journalEntries', 1);
      const savingsTxnId = receipt.savingsAmountCollected > 0 || fromSavings ? await s.reserve('savings', 1) : 0;
      const vaultTxnId = vaultOut ? await s.reserve('vaultTransactions', 1) : 0;

      if (customer && receipt.savingsAmountCollected > (customer.totalSavingsBalance || 0)) {
        throw new Error('গ্রাহকের সঞ্চয় স্থিতি এই রসিদের সঞ্চয় অংশের চেয়ে কম — আগে সঞ্চয় সমন্বয় করুন');
      }

      const today = s.businessDate;
      const updated = new Map<number, InstallmentSchedule>();
      allocations.forEach((a, idx) => {
        const fi = instSnaps[idx].data() as InstallmentSchedule;
        const paidPrincipal = round2(Math.max(0, (fi.paidPrincipal || 0) - a.principal));
        const paidProfit = round2(Math.max(0, (fi.paidProfit || 0) - a.profit));
        const paidSavings = round2(Math.max(0, (fi.paidSavings || 0) - a.savings));
        const anyPaid = paidPrincipal + paidProfit > 0;
        const status: InstallmentStatus = anyPaid ? 'PARTIAL' : (fi.dueDate < today ? 'OVERDUE' : 'PENDING');
        const receiptIds = (fi.receiptIds || []).filter(id => id !== receiptId);
        updated.set(a.installmentId, {
          ...fi, paidPrincipal, paidProfit, paidSavings,
          paidTotalAmount: round2(paidPrincipal + paidProfit + paidSavings),
          status, receiptIds,
          collectionReceiptId: receiptIds.length ? receiptIds[receiptIds.length - 1] : undefined
        });
      });
      const merged = pre.installments.map(i => updated.get(i.installmentId) || i);
      const principal = round2(receipt.principalAmountCollected);
      const profit = round2(receipt.profitAmountCollected);
      const savings = round2(receipt.savingsAmountCollected);
      const loanUpdate = this.recomputeLoan(freshLoan, merged, today, { principalDelta: -principal, profitDelta: -profit, savingsDelta: -savings });
      const reopened = freshLoan.status === 'CLOSED' && loanUpdate.status !== 'CLOSED';
      if (reopened) loanUpdate.actualClosedDate = null as any;

      // ---------- WRITE ----------
      const receiptFields = { isReversed: true, reversedAt: s.now, reversedByUserId: actor.userId, reversedByName: actor.name, reversalReason: reason.trim() };
      s.update(receiptRef, { ...receiptFields, history: s.appendHistory(receipt, s.historyEntry('PAYMENT_REVERSED', reason, receipt, receiptFields)) });
      for (const a of allocations) {
        const next = updated.get(a.installmentId)!;
        const fields = {
          paidPrincipal: next.paidPrincipal, paidProfit: next.paidProfit, paidSavings: next.paidSavings,
          paidTotalAmount: next.paidTotalAmount, status: next.status, receiptIds: next.receiptIds,
          collectionReceiptId: next.collectionReceiptId ?? null
        };
        const old = instSnaps[allocations.indexOf(a)].data() as InstallmentSchedule;
        s.update(this.runner.installmentRef(a.installmentId), { ...fields, history: s.appendHistory(old, s.historyEntry('PAYMENT_REVERSED', `রসিদ #${receiptId} বাতিল`, old, fields)) });
      }
      s.update(this.runner.loanRef(receipt.loanId), { ...loanUpdate, history: s.appendHistory(freshLoan, s.historyEntry('PAYMENT_REVERSED', `রসিদ #${receiptId} বাতিল: ${reason}`, freshLoan, loanUpdate)) });
      s.statusChange(receipt.loanId, receipt.branchId, freshLoan.status, loanUpdate.status!, `রসিদ #${receiptId} বাতিল`);

      const restored = fromSavings ? round2(principal + profit) : 0;
      if (customer && (savings > 0 || reopened || restored > 0)) {
        const custFields: Record<string, any> = {};
        if (savings > 0 || restored > 0) custFields['totalSavingsBalance'] = round2((customer.totalSavingsBalance || 0) - savings + restored);
        if (reopened) custFields['activeLoansCount'] = (customer.activeLoansCount || 0) + 1;
        s.update(this.runner.customerRef(customer.customerId), { ...custFields, history: s.appendHistory(customer, s.historyEntry('PAYMENT_REVERSED', `রসিদ #${receiptId} বাতিল`, customer, custFields)) });
        if (savings > 0) {
          s.set(doc(this.firestore, 'savingsTransactions', String(savingsTxnId)), {
            transactionId: savingsTxnId, customerId: customer.customerId, customerName: customer.fullName,
            branchId: Number(receipt.branchId), centerId: Number(receipt.centerId), loanId: receipt.loanId,
            type: 'REVERSAL', amount: savings, isCredit: false,
            previousBalance: customer.totalSavingsBalance || 0, newBalance: round2((customer.totalSavingsBalance || 0) - savings),
            paymentMethod: receipt.paymentMethod, transactionDate: s.now,
            performedByUserId: actor.userId, performedByName: actor.name, performedByRole: actor.role,
            reason: `রসিদ #${receiptId} বাতিল: ${reason}`, receiptNo: `RCP-${receiptId}`, correlationId: s.correlationId,
            isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: []
          } as SavingsTransaction);
        }
        if (restored > 0) {
          s.set(doc(this.firestore, 'savingsTransactions', String(savingsTxnId)), {
            transactionId: savingsTxnId, customerId: customer.customerId, customerName: customer.fullName,
            branchId: Number(receipt.branchId), centerId: Number(receipt.centerId), loanId: receipt.loanId,
            type: 'REVERSAL', amount: restored, isCredit: true,
            previousBalance: customer.totalSavingsBalance || 0, newBalance: round2((customer.totalSavingsBalance || 0) + restored),
            paymentMethod: 'SAVINGS', transactionDate: s.now,
            performedByUserId: actor.userId, performedByName: actor.name, performedByRole: actor.role,
            reason: `সঞ্চয় হতে কিস্তি সমন্বয় রসিদ #${receiptId} বাতিল — সঞ্চয়ে ফেরত (+৳ ${restored}): ${reason}`,
            receiptNo: `RCP-${receiptId}`, correlationId: s.correlationId,
            isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: []
          } as SavingsTransaction);
        }
      }

      s.loanTxn({
        id: loanTxnId, loanId: receipt.loanId, customerId: receipt.customerId, branchId: receipt.branchId,
        type: 'REVERSAL', principal, profit,
        outstandingBefore: freshLoan.outstandingBalance || 0, outstandingAfter: loanUpdate.outstandingBalance!, receiptId,
        note: reason
      });

      // ইতোমধ্যে ভল্টে জমা হলে ভল্ট থেকে ফেরত, নইলে মাঠকর্মীর হাতের নগদ থেকে
      const total = round2(receipt.totalAmountCollected);
      const cashAccount = vaultOut ? ACCOUNTS.VAULT_CASH : collectionCashAccount(receipt.paymentMethod);
      if (vaultOut) {
        s.vaultMove({ id: vaultTxnId, branchId: receipt.branchId, type: 'ADJUSTMENT', direction: 'OUT', amount: total, refType: 'RECEIPT_REVERSAL', refId: receiptId, note: `রসিদ #${receiptId} বাতিলে ফেরত` });
      }
      s.journal(journalId, receipt.branchId, `রসিদ #${receiptId} বাতিল (রিভার্সাল)`, [
        { account: ACCOUNTS.LOANS_RECEIVABLE, debit: principal, credit: 0 },
        { account: ACCOUNTS.SERVICE_CHARGE_INCOME, debit: profit, credit: 0 },
        { account: ACCOUNTS.MEMBER_SAVINGS, debit: savings, credit: 0 },
        { account: cashAccount, debit: 0, credit: total }
      ]);
      s.audit('collections', receiptId, 'PAYMENT_REVERSED', reason, { isReversed: { before: false, after: true } }, receipt.branchId);
    }, async () => {
      const snap = await getDocs(query(collection(this.firestore, 'collections'), where('receiptId', '==', receiptId)));
      if (snap.empty) throw new Error(`রসিদ #${receiptId} পাওয়া যায়নি`);
      const receipt = snap.docs[0].data() as PaymentCollection;
      if (receipt.isWriteOffRecovery) throw new Error('অবলোপিত ঋণের আদায় রসিদ এখান থেকে বাতিল করা যাবে না');
      if (receipt.receiptType && receipt.receiptType !== 'KISTI') {
        throw new Error('এটি কিস্তির রসিদ নয় (সঞ্চয় জমা / ফি)। ভুল হলে শাখায় সঞ্চয় সমন্বয় বা ফি ফেরত দিন।');
      }
      if (receipt.correlationId?.startsWith('SET-')) throw new Error('আগাম পরিশোধের রসিদ বাতিল করা যাবে না (রিবেট সমন্বয় জড়িত) — প্রধান কার্যালয়ের সাথে যোগাযোগ করুন');
      // শুধু ঋণের সর্বশেষ সক্রিয় রসিদ বাতিল করা যায় — পরের রসিদের বণ্টন ভুল হওয়া ঠেকাতে
      const loanReceipts = await getDocs(query(collection(this.firestore, 'collections'), where('loanId', '==', receipt.loanId)));
      const latest = loanReceipts.docs.map(d => d.data() as PaymentCollection)
        .filter(r => !r.isReversed && !r.isDeleted)
        .reduce((max, r) => Math.max(max, r.receiptId), 0);
      if (latest !== receiptId) {
        throw new Error(`এই ঋণে পরে আরও রসিদ (#${latest}) আছে। আগে সর্বশেষ রসিদটি বাতিল করুন।`);
      }
      const bundle = await this.runner.loadLoanBundle(receipt.loanId);
      pre = { ...bundle, receipt };
    });
  }

  // =====================================================================
  // ৩. অবলোপিত ঋণ আদায়, পুনঃতফসিল, অবলোপন, বীমা দাবি
  // =====================================================================

  async recordWriteOffRecovery(params: { loanId: number; amount: number; paymentMethod: PaymentMethod; trxId?: string }, actor: Actor): Promise<PaymentCollection> {
    if (!(params.amount > 0)) throw new Error('সঠিক পরিমাণ দিন');
    return this.runner.run(actor, 'WOR', async s => {
      const loanSnap = await s.tx.get(this.runner.loanRef(params.loanId));
      const loan = loanSnap.data() as Loan;
      if (loan.status !== 'WRITTEN_OFF') throw new Error('শুধু অবলোপিত ঋণে এই আদায় প্রযোজ্য');
      await s.assertDayOpen(loan.branchId);
      const receiptId = await s.reserve('receipts', 1);
      const loanTxnId = await s.reserve('loanTransactions', 1);
      const journalId = await s.reserve('journalEntries', 1);
      s.correlationId = `WOR-${receiptId}`;
      const amount = round2(params.amount);
      const remaining = round2((loan.writtenOffAmount || 0) - (loan.recoveredAfterWriteOff || 0));
      if (amount > remaining) throw new Error(`অবলোপিত বাকি ৳${remaining} এর বেশি নেওয়া যাবে না`);

      const receipt: PaymentCollection = {
        receiptId, loanId: loan.loanId, customerId: loan.customerId, customerName: loan.customerName,
        installmentNo: 0, branchId: Number(loan.branchId), centerId: Number(loan.centerId),
        collectedByUserId: actor.userId, collectedByName: actor.name,
        principalAmountCollected: amount, profitAmountCollected: 0, savingsAmountCollected: 0, fineAmountCollected: 0,
        totalAmountCollected: amount, paymentMethod: params.paymentMethod, trxId: params.trxId || undefined,
        collectionDate: s.now, isHandedOverToBranch: false, isWriteOffRecovery: true, correlationId: s.correlationId,
        isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null,
        history: [s.historyEntry('PAYMENT_COLLECTED', 'অবলোপিত ঋণ আদায়', undefined, { amount })]
      };
      s.set(doc(this.firestore, 'collections', String(receiptId)), receipt);
      const fields = { recoveredAfterWriteOff: round2((loan.recoveredAfterWriteOff || 0) + amount), ledgerVersion: (loan.ledgerVersion || 0) + 1 };
      s.update(this.runner.loanRef(loan.loanId), { ...fields, history: s.appendHistory(loan, s.historyEntry('PAYMENT_COLLECTED', `অবলোপিত ঋণ আদায় রসিদ #${receiptId}`, loan, fields)) });
      s.loanTxn({ id: loanTxnId, loanId: loan.loanId, customerId: loan.customerId, branchId: loan.branchId, type: 'WRITE_OFF_RECOVERY', principal: amount, profit: 0, outstandingBefore: remaining, outstandingAfter: round2(remaining - amount), receiptId });
      s.journal(journalId, loan.branchId, `অবলোপিত ঋণ আদায় — ${loan.loanAccountNo}`, [
        { account: collectionCashAccount(params.paymentMethod), debit: amount, credit: 0 },
        { account: ACCOUNTS.BAD_DEBT_RECOVERY, debit: 0, credit: amount }
      ]);
      s.audit('collections', receiptId, 'PAYMENT_COLLECTED', 'অবলোপিত ঋণ আদায়', { amount: { before: null, after: amount } }, loan.branchId);
      return receipt;
    });
  }

  /**
   * পুনঃতফসিল: বাকি আসল ও লাভ নতুন কিস্তিতে ভাগ। পুরাতন অপরিশোধিত কিস্তি RESCHEDULED হয় (মোছা হয় না)।
   */
  async rescheduleLoan(params: { loanId: number; count: number; frequency: InstallmentFrequency; firstDueDate: string; reason: string }, actor: Actor): Promise<void> {
    if (!params.reason.trim()) throw new Error('পুনঃতফসিলের কারণ লেখা বাধ্যতামূলক');
    if (params.count < 1 || params.count > 400) throw new Error('নতুন কিস্তির সংখ্যা ১–৪০০ এর মধ্যে হতে হবে');
    if (params.firstDueDate < todayDhaka()) throw new Error('প্রথম কিস্তির তারিখ আজ বা পরে হতে হবে');
    let pre!: { loan: Loan; installments: InstallmentSchedule[] };
    let calendar!: Awaited<ReturnType<SettingsService['getCalendar']>>;

    await this.runner.run(actor, `RSC-${params.loanId}`, async s => {
      const loanSnap = await s.tx.get(this.runner.loanRef(params.loanId));
      const loan = loanSnap.data() as Loan;
      if ((loan.ledgerVersion || 0) !== (pre.loan.ledgerVersion || 0)) throw new ConcurrentChangeError();
      this.assertCollectable(loan);
      const open = pre.installments.filter(i => !isSettledStatus(i.status));
      const openSnaps = await Promise.all(open.map(i => s.tx.get(this.runner.installmentRef(i.installmentId))));
      const freshOpen = openSnaps.map(sn => sn.data() as InstallmentSchedule);
      const firstNewId = await s.reserve('installments', params.count);
      const loanTxnId = await s.reserve('loanTransactions', 1);

      const remPrincipal = freshOpen.reduce((sum, i) => sum + remainingOf(i).principal, 0);
      const remProfit = freshOpen.reduce((sum, i) => sum + remainingOf(i).profit, 0);
      if (remPrincipal + remProfit <= 0) throw new Error('এই ঋণে পুনঃতফসিলযোগ্য বাকি নেই');
      const maxNo = pre.installments.reduce((m, i) => Math.max(m, i.installmentNo), 0);
      const rows = buildScheduleFromTotals({
        principal: remPrincipal, profit: remProfit, count: params.count, frequency: params.frequency,
        firstDueDate: params.firstDueDate, calendar, startNo: maxNo + 1
      });

      for (const old of freshOpen) {
        const fields = { status: 'RESCHEDULED' as InstallmentStatus };
        s.update(this.runner.installmentRef(old.installmentId), { ...fields, history: s.appendHistory(old, s.historyEntry('LOAN_RESCHEDULED', params.reason, old, fields)) });
      }
      rows.forEach((r, idx) => {
        const inst: InstallmentSchedule = {
          installmentId: firstNewId + idx, loanId: loan.loanId, customerId: loan.customerId,
          branchId: loan.branchId, centerId: loan.centerId, fieldOfficerUserId: loan.fieldOfficerUserId,
          installmentNo: r.installmentNo, dueDate: r.dueDate,
          expectedPrincipal: r.principal, expectedProfit: r.profit,
          expectedSavings: loan.savingsPerInstallment || 0, expectedTotalAmount: r.total + (loan.savingsPerInstallment || 0),
          paidPrincipal: 0, paidProfit: 0, paidSavings: 0, paidTotalAmount: 0, status: 'PENDING',
          isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: []
        };
        s.set(this.runner.installmentRef(inst.installmentId), inst);
      });

      const settledCount = pre.installments.filter(i => isSettledStatus(i.status) && i.status !== 'RESCHEDULED').length;
      const loanFields: Partial<Loan> = {
        status: 'DISBURSED',
        installmentFrequency: params.frequency,
        totalInstallments: settledCount + params.count,
        remainingInstallmentsCount: params.count,
        installmentAmount: rows[0].total,
        lastInstallmentAmount: rows[rows.length - 1].total,
        expectedClosingDate: rows[rows.length - 1].dueDate,
        overdueAmount: 0, missedInstallmentsCount: 0, daysPastDue: 0, classification: 'STANDARD', classifiedAt: s.now,
        rescheduleCount: (loan.rescheduleCount || 0) + 1,
        ledgerVersion: (loan.ledgerVersion || 0) + 1
      };
      s.update(this.runner.loanRef(loan.loanId), { ...loanFields, history: s.appendHistory(loan, s.historyEntry('LOAN_RESCHEDULED', params.reason, loan, loanFields)) });
      s.statusChange(loan.loanId, loan.branchId, loan.status, 'DISBURSED', `পুনঃতফসিল: ${params.reason}`);
      s.loanTxn({ id: loanTxnId, loanId: loan.loanId, customerId: loan.customerId, branchId: loan.branchId, type: 'RESCHEDULE', principal: 0, profit: 0, outstandingBefore: loan.outstandingBalance, outstandingAfter: loan.outstandingBalance, note: `${params.count} কিস্তিতে পুনঃতফসিল: ${params.reason}` });
      s.audit('loans', loan.loanId, 'LOAN_RESCHEDULED', params.reason, { totalInstallments: { before: loan.totalInstallments, after: loanFields.totalInstallments } }, loan.branchId);
    }, async () => {
      pre = await this.runner.loadLoanBundle(params.loanId);
      calendar = await this.settings.getCalendar(pre.loan.branchId);
      const openCount = pre.installments.filter(i => !isSettledStatus(i.status)).length;
      if (openCount + params.count > 450) throw new Error('একবারে এত কিস্তি পুনঃতফসিল করা যাবে না');
    });
  }

  /** অবলোপন (Write-off) — প্রধান কার্যালয়ের অনুমোদনে। বাকি আসল ব্যয় হিসেবে লেখা হয়, আদায় চলতে পারে। */
  async writeOffLoan(loanId: number, reason: string, actor: Actor): Promise<void> {
    if (!reason.trim()) throw new Error('অবলোপনের কারণ লেখা বাধ্যতামূলক');
    await this.runner.run(actor, `WOF-${loanId}`, async s => {
      const loanSnap = await s.tx.get(this.runner.loanRef(loanId));
      const loan = loanSnap.data() as Loan;
      this.assertCollectable(loan);
      const custSnap = await s.tx.get(this.runner.customerRef(loan.customerId));
      const customer = custSnap.data() as Customer;
      const loanTxnId = await s.reserve('loanTransactions', 1);
      const journalId = await s.reserve('journalEntries', 1);
      const principal = outstandingPrincipal(loan);

      const fields: Partial<Loan> = {
        status: 'WRITTEN_OFF', writtenOffAmount: round2(loan.outstandingBalance), writtenOffAt: s.now,
        writtenOffByUserId: actor.userId, recoveredAfterWriteOff: 0, ledgerVersion: (loan.ledgerVersion || 0) + 1
      };
      s.update(this.runner.loanRef(loanId), { ...fields, history: s.appendHistory(loan, s.historyEntry('LOAN_WRITTEN_OFF', reason, loan, fields)) });
      s.statusChange(loanId, loan.branchId, loan.status, 'WRITTEN_OFF', reason);
      const custFields = { activeLoansCount: Math.max(0, (customer.activeLoansCount || 0) - 1), creditScore: 'BLACKLISTED' as const, blacklistReason: `ঋণ ${loan.loanAccountNo} অবলোপিত`, creditScoreUpdatedAt: s.now };
      s.update(this.runner.customerRef(loan.customerId), { ...custFields, history: s.appendHistory(customer, s.historyEntry('LOAN_WRITTEN_OFF', reason, customer, custFields)) });
      s.set(doc(collection(this.firestore, 'creditScoreHistory')), { customerId: loan.customerId, from: customer.creditScore, to: 'BLACKLISTED', reason: `ঋণ অবলোপন: ${reason}`, timestamp: s.now, actor: s.actor });
      s.loanTxn({ id: loanTxnId, loanId, customerId: loan.customerId, branchId: loan.branchId, type: 'WRITE_OFF', principal, profit: round2(loan.outstandingBalance - principal), outstandingBefore: loan.outstandingBalance, outstandingAfter: 0, note: reason });
      s.journal(journalId, loan.branchId, `ঋণ অবলোপন — ${loan.loanAccountNo}`, [
        { account: ACCOUNTS.WRITE_OFF_EXPENSE, debit: principal, credit: 0 },
        { account: ACCOUNTS.LOANS_RECEIVABLE, debit: 0, credit: principal }
      ]);
      s.audit('loans', loanId, 'LOAN_WRITTEN_OFF', reason, { status: { before: loan.status, after: 'WRITTEN_OFF' } }, loan.branchId);
    });
  }

  /** মৃত্যু/অক্ষমতা দাবি — ঋণ ঝুঁকি তহবিল থেকে বাকি মওকুফ, ঋণ বন্ধ */
  async insuranceClaim(params: { loanId: number; claimType: 'DEATH' | 'DISABILITY'; eventDate: string; notes?: string }, actor: Actor): Promise<InsuranceClaim> {
    let pre!: { loan: Loan; installments: InstallmentSchedule[] };
    return this.runner.run(actor, `CLM-${params.loanId}`, async s => {
      const loanSnap = await s.tx.get(this.runner.loanRef(params.loanId));
      const loan = loanSnap.data() as Loan;
      if ((loan.ledgerVersion || 0) !== (pre.loan.ledgerVersion || 0)) throw new ConcurrentChangeError();
      this.assertCollectable(loan);
      const open = pre.installments.filter(i => !isSettledStatus(i.status));
      const openSnaps = await Promise.all(open.map(i => s.tx.get(this.runner.installmentRef(i.installmentId))));
      const custSnap = await s.tx.get(this.runner.customerRef(loan.customerId));
      const customer = custSnap.data() as Customer;
      const claimId = await s.reserve('insuranceClaims', 1);
      const loanTxnId = await s.reserve('loanTransactions', 1);
      const journalId = await s.reserve('journalEntries', 1);
      s.correlationId = `CLM-${claimId}`;
      const principal = outstandingPrincipal(loan);
      const waived = round2(loan.outstandingBalance);
      const nominee = (customer.nominees || [])[0];

      for (const sn of openSnaps) {
        const inst = sn.data() as InstallmentSchedule;
        const fields = { status: 'WAIVED' as InstallmentStatus };
        s.update(this.runner.installmentRef(inst.installmentId), { ...fields, history: s.appendHistory(inst, s.historyEntry('STATUS_CHANGE', 'বীমা দাবিতে মওকুফ', inst, fields)) });
      }
      const loanFields: Partial<Loan> = {
        status: 'CLOSED', outstandingBalance: 0, outstandingPrincipal: 0, overdueAmount: 0, daysPastDue: 0,
        remainingInstallmentsCount: 0, waivedAmount: waived, actualClosedDate: s.now, ledgerVersion: (loan.ledgerVersion || 0) + 1
      };
      s.update(this.runner.loanRef(loan.loanId), { ...loanFields, history: s.appendHistory(loan, s.historyEntry('LOAN_SETTLED', `বীমা দাবি #${claimId}`, loan, loanFields)) });
      s.statusChange(loan.loanId, loan.branchId, loan.status, 'CLOSED', `বীমা দাবি #${claimId} (${params.claimType})`);
      const custFields = { activeLoansCount: Math.max(0, (customer.activeLoansCount || 0) - 1) };
      s.update(this.runner.customerRef(customer.customerId), { ...custFields, history: s.appendHistory(customer, s.historyEntry('UPDATE', `বীমা দাবি #${claimId}`, customer, custFields)) });

      const claim: InsuranceClaim = {
        claimId, loanId: loan.loanId, customerId: loan.customerId, branchId: Number(loan.branchId),
        claimType: params.claimType, eventDate: params.eventDate, waivedOutstanding: waived,
        nomineeName: nominee?.name, notes: params.notes, businessDate: s.businessDate, createdAt: s.now, createdBy: s.actor
      };
      s.set(doc(this.firestore, 'insuranceClaims', String(claimId)), claim);
      s.loanTxn({ id: loanTxnId, loanId: loan.loanId, customerId: loan.customerId, branchId: loan.branchId, type: 'INSURANCE_WAIVER', principal, profit: round2(waived - principal), outstandingBefore: waived, outstandingAfter: 0, note: `বীমা দাবি #${claimId}` });
      s.journal(journalId, loan.branchId, `বীমা দাবি #${claimId} — ${loan.loanAccountNo}`, [
        { account: ACCOUNTS.LOAN_RISK_FUND, debit: principal, credit: 0 },
        { account: ACCOUNTS.LOANS_RECEIVABLE, debit: 0, credit: principal }
      ]);
      s.audit('loans', loan.loanId, 'LOAN_SETTLED', `বীমা দাবি (${params.claimType})`, { waivedAmount: { before: null, after: waived } }, loan.branchId);
      return claim;
    }, async () => { pre = await this.runner.loadLoanBundle(params.loanId); });
  }

  // =====================================================================
  // ৪. সঞ্চয় থেকে বকেয়া ঋণ সমন্বয় (সদস্যপদ সমাপ্তি)
  // =====================================================================

  async settleLoansFromSavings(customerId: number, actor: Actor, reason: string): Promise<{ adjustedAmount: number; closedLoanIds: number[]; newSavingsBalance: number }> {
    let bundles: { loan: Loan; installments: InstallmentSchedule[] }[] = [];
    return this.runner.run(actor, `ADJ-${customerId}`, async s => {
      const custSnap = await s.tx.get(this.runner.customerRef(customerId));
      if (!custSnap.exists()) throw new Error(`গ্রাহক #${customerId} পাওয়া যায়নি`);
      const customer = custSnap.data() as Customer;
      const loanSnaps = await Promise.all(bundles.map(b => s.tx.get(this.runner.loanRef(b.loan.loanId))));
      loanSnaps.forEach((sn, idx) => {
        if (((sn.data() as Loan).ledgerVersion || 0) !== (bundles[idx].loan.ledgerVersion || 0)) throw new ConcurrentChangeError();
      });
      const today = s.businessDate;
      let available = customer.totalSavingsBalance || 0;
      const plans = bundles.map(b => {
        const pay = Math.min(available, this.openTotal(b.installments));
        available -= pay;
        return { b, alloc: allocatePayment(b.installments, round2(pay), 0, today) };
      }).filter(p => p.alloc.principalTotal + p.alloc.profitTotal > 0);
      const instSnaps = await Promise.all(plans.flatMap(p => p.alloc.allocations.map(a => s.tx.get(this.runner.installmentRef(a.installmentId)))));
      const branchId = Number(customer.branchId);
      await s.assertDayOpen(branchId);
      const savingsTxnId = plans.length ? await s.reserve('savings', 1) : 0;
      const loanTxnId = plans.length ? await s.reserve('loanTransactions', plans.length) : 0;
      const journalId = plans.length ? await s.reserve('journalEntries', 1) : 0;

      let adjusted = 0, principalSum = 0, profitSum = 0, snapIdx = 0;
      const closedLoanIds: number[] = [];
      plans.forEach((p, idx) => {
        const updated = new Map<number, InstallmentSchedule>();
        for (const a of p.alloc.allocations) {
          const fi = instSnaps[snapIdx++].data() as InstallmentSchedule;
          const fields = {
            paidPrincipal: round2((fi.paidPrincipal || 0) + a.principal),
            paidProfit: round2((fi.paidProfit || 0) + a.profit),
            paidTotalAmount: round2((fi.paidTotalAmount || 0) + a.principal + a.profit),
            status: a.newStatus, paidDate: s.now
          };
          updated.set(fi.installmentId, { ...fi, ...fields });
          s.update(this.runner.installmentRef(fi.installmentId), { ...fields, history: s.appendHistory(fi, s.historyEntry('UPDATE', 'সঞ্চয় হতে ঋণ সমন্বয়', fi, fields)) });
        }
        const loan = loanSnaps[bundles.indexOf(p.b)].data() as Loan;
        const merged = p.b.installments.map(i => updated.get(i.installmentId) || i);
        const loanUpdate = this.recomputeLoan(loan, merged, today, { principalDelta: p.alloc.principalTotal, profitDelta: p.alloc.profitTotal, savingsDelta: 0 });
        const paid = round2(p.alloc.principalTotal + p.alloc.profitTotal);
        adjusted += paid; principalSum += p.alloc.principalTotal; profitSum += p.alloc.profitTotal;
        if (loanUpdate.status === 'CLOSED') closedLoanIds.push(loan.loanId);
        s.update(this.runner.loanRef(loan.loanId), { ...loanUpdate, history: s.appendHistory(loan, s.historyEntry('UPDATE', `${reason} — সঞ্চয় হতে ৳${paid} সমন্বয়`, loan, loanUpdate)) });
        s.statusChange(loan.loanId, loan.branchId, loan.status, loanUpdate.status!, 'সঞ্চয় হতে সমন্বয়');
        s.loanTxn({ id: loanTxnId + idx, loanId: loan.loanId, customerId, branchId: loan.branchId, type: 'ADJUSTMENT_FROM_SAVINGS', principal: p.alloc.principalTotal, profit: p.alloc.profitTotal, outstandingBefore: loan.outstandingBalance, outstandingAfter: loanUpdate.outstandingBalance!, note: reason });
      });

      const before = customer.totalSavingsBalance || 0;
      const newSavingsBalance = round2(before - adjusted);
      if (plans.length) {
        const custFields = { totalSavingsBalance: newSavingsBalance, activeLoansCount: Math.max(0, (customer.activeLoansCount || 0) - closedLoanIds.length) };
        s.update(this.runner.customerRef(customerId), { ...custFields, history: s.appendHistory(customer, s.historyEntry('UPDATE', reason, customer, custFields)) });
        s.set(doc(this.firestore, 'savingsTransactions', String(savingsTxnId)), {
          transactionId: savingsTxnId, customerId, customerName: customer.fullName, branchId, centerId: Number(customer.centerId),
          type: 'ADJUSTMENT', amount: adjusted, isCredit: false, previousBalance: before, newBalance: newSavingsBalance,
          paymentMethod: 'CASH', transactionDate: s.now,
          performedByUserId: actor.userId, performedByName: actor.name, performedByRole: actor.role,
          reason: `বকেয়া ঋণ সমন্বয় (−৳ ${adjusted}) — ${reason}`, correlationId: s.correlationId,
          isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: []
        } as SavingsTransaction);
        s.journal(journalId, branchId, `সঞ্চয় হতে ঋণ সমন্বয় — গ্রাহক #${customerId}`, [
          { account: ACCOUNTS.MEMBER_SAVINGS, debit: adjusted, credit: 0 },
          { account: ACCOUNTS.LOANS_RECEIVABLE, debit: 0, credit: principalSum },
          { account: ACCOUNTS.SERVICE_CHARGE_INCOME, debit: 0, credit: profitSum }
        ]);
        s.audit('customers', customerId, 'UPDATE', reason, { totalSavingsBalance: { before, after: newSavingsBalance } }, branchId);
      }
      return { adjustedAmount: adjusted, closedLoanIds, newSavingsBalance };
    }, async () => {
      const snap = await getDocs(query(collection(this.firestore, 'loans'), where('customerId', '==', customerId)));
      const loans = snap.docs.map(d => d.data() as Loan)
        .filter(l => !l.isDeleted && COLLECTABLE_STATUSES.includes(l.status) && (l.outstandingBalance || 0) > 0)
        .sort((a, b) => a.loanId - b.loanId);
      bundles = await Promise.all(loans.map(async loan => ({ loan, installments: await this.runner.getInstallments(loan.loanId) })));
    });
  }

  // =====================================================================
  // ৫. ফলো-আপ ও খতিয়ান পাঠ
  // =====================================================================

  async addFollowUp(params: Omit<FollowUp, 'followUpId' | 'businessDate' | 'createdAt' | 'createdBy'>, actor: Actor): Promise<FollowUp> {
    if (!params.outcome.trim()) throw new Error('যোগাযোগের ফলাফল লিখুন');
    return this.runner.run(actor, `FUP-${params.loanId}`, async s => {
      const id = await s.reserve('followUps', 1);
      const row: FollowUp = { ...params, followUpId: id, businessDate: s.businessDate, createdAt: s.now, createdBy: s.actor };
      s.set(doc(this.firestore, 'followUps', String(id)), row);
      return row;
    });
  }

  async getFollowUps(loanId: number): Promise<FollowUp[]> {
    return this.queryList<FollowUp>('followUps', 'loanId', loanId, (a, b) => b.followUpId - a.followUpId);
  }

  async getLoanTransactions(loanId: number): Promise<LoanTransaction[]> {
    return this.queryList<LoanTransaction>('loanTransactions', 'loanId', loanId, (a, b) => a.loanTransactionId - b.loanTransactionId);
  }

  async getLoanStatusHistory(loanId: number): Promise<LoanStatusChange[]> {
    return this.queryList<LoanStatusChange>('loanStatusHistory', 'loanId', loanId, (a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async getInsuranceClaims(loanId: number): Promise<InsuranceClaim[]> {
    return this.queryList<InsuranceClaim>('insuranceClaims', 'loanId', loanId, (a, b) => a.claimId - b.claimId);
  }

  // =====================================================================
  // সহায়ক
  // =====================================================================

  /** কিস্তির তালিকা থেকে ঋণের সব সারাংশ ফিল্ড পুনঃহিসাব */
  recomputeLoan(loan: Loan, merged: InstallmentSchedule[], today: string, delta: { principalDelta: number; profitDelta: number; savingsDelta: number }): Partial<Loan> {
    const paidDelta = round2(delta.principalDelta + delta.profitDelta);
    const outstanding = round2(Math.max(0, (loan.outstandingBalance || 0) - paidDelta));
    const principalLeft = round2(Math.max(0, outstandingPrincipal(loan) - delta.principalDelta));
    const overdue = loanOverdueState(merged, today);
    const settled = merged.filter(i => isSettledStatus(i.status) && i.status !== 'RESCHEDULED').length;
    const open = merged.filter(i => !isSettledStatus(i.status)).length;
    const status: LoanStatus = outstanding <= 0 ? 'CLOSED' : overdue.missedInstallmentsCount > 0 ? 'OVERDUE' : 'DISBURSED';
    const update: Partial<Loan> = {
      totalPaidAmount: round2((loan.totalPaidAmount || 0) + paidDelta),
      totalPrincipalPaid: round2((loan.totalPrincipalPaid || 0) + delta.principalDelta),
      totalProfitPaid: round2((loan.totalProfitPaid || 0) + delta.profitDelta),
      totalSavingsCollected: round2((loan.totalSavingsCollected || 0) + delta.savingsDelta),
      outstandingBalance: outstanding,
      outstandingPrincipal: principalLeft,
      paidInstallmentsCount: settled,
      remainingInstallmentsCount: open,
      overdueAmount: overdue.overdueAmount,
      missedInstallmentsCount: overdue.missedInstallmentsCount,
      daysPastDue: overdue.daysPastDue,
      classification: overdue.classification,
      classifiedAt: new Date().toISOString(),
      status,
      ledgerVersion: (loan.ledgerVersion || 0) + 1
    };
    if (status === 'CLOSED' && loan.status !== 'CLOSED') update.actualClosedDate = new Date().toISOString();
    return update;
  }

  private assertCollectable(loan: Loan): void {
    if (loan.isDeleted) throw new Error('ঋণটি মুছে ফেলা হয়েছে');
    if (!COLLECTABLE_STATUSES.includes(loan.status)) {
      const msg: Partial<Record<LoanStatus, string>> = {
        CLOSED: 'ঋণটি সম্পূর্ণ পরিশোধিত', WRITTEN_OFF: 'ঋণটি অবলোপিত — "অবলোপিত ঋণ আদায়" ব্যবহার করুন',
        APPLIED: 'ঋণটি এখনো বিতরণ হয়নি', FIELD_VERIFIED: 'ঋণটি এখনো বিতরণ হয়নি', APPROVED: 'ঋণটি এখনো বিতরণ হয়নি'
      };
      throw new Error(msg[loan.status] || `এই অবস্থায় (${loan.status}) আদায় সম্ভব নয়`);
    }
  }

  private openTotal(installments: InstallmentSchedule[]): number {
    return installments.reduce((s, i) => s + remainingOf(i).total, 0);
  }

  private async productRebatePercent(productId: number): Promise<number> {
    const snap = await getDocs(query(collection(this.firestore, 'loanProducts'), where('productId', '==', Number(productId))));
    const p = snap.docs[0]?.data();
    return Number(p?.['earlySettlementRebatePercent'] ?? 100);
  }

  private async queryList<T>(col: string, field: string, value: number, sort: (a: T, b: T) => number): Promise<T[]> {
    try {
      const snap = await getDocs(query(collection(this.firestore, col), where(field, '==', Number(value))));
      return snap.docs.map(d => d.data() as T).sort(sort);
    } catch (err) {
      console.error(`Error loading ${col}:`, err);
      return [];
    }
  }
}
