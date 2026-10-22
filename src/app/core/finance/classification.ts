import { InstallmentSchedule, Loan, LoanClassification } from '../models/database.models';
import { diffDaysKey } from './dates';
import { isSettledStatus, remainingOf } from './allocation';

/**
 * MRA ধাঁচের ঋণ শ্রেণীকরণ ও ঋণ ক্ষতি সঞ্চিতি (Loan Loss Provision)।
 * ⚖️ যাচাই করুন: সর্বশেষ MRA সার্কুলার অনুযায়ী দিনসীমা ও হার নিশ্চিত করে নিন।
 */
export interface ClassificationRule {
  classification: LoanClassification;
  minDays: number;
  maxDays: number;
  provisionRate: number;
  labelBn: string;
  labelEn: string;
}

export const CLASSIFICATION_RULES: ClassificationRule[] = [
  { classification: 'STANDARD', minDays: 0, maxDays: 0, provisionRate: 0.01, labelBn: 'নিয়মিত', labelEn: 'Standard' },
  { classification: 'WATCHFUL', minDays: 1, maxDays: 30, provisionRate: 0.05, labelBn: 'পর্যবেক্ষণাধীন', labelEn: 'Watchful' },
  { classification: 'SUBSTANDARD', minDays: 31, maxDays: 180, provisionRate: 0.25, labelBn: 'নিম্নমান', labelEn: 'Substandard' },
  { classification: 'DOUBTFUL', minDays: 181, maxDays: 365, provisionRate: 0.75, labelBn: 'সন্দেহজনক', labelEn: 'Doubtful' },
  { classification: 'BAD', minDays: 366, maxDays: Number.MAX_SAFE_INTEGER, provisionRate: 1, labelBn: 'মন্দ / ক্ষতি', labelEn: 'Bad / Loss' }
];

export function classify(daysPastDue: number): ClassificationRule {
  return CLASSIFICATION_RULES.find(r => daysPastDue >= r.minDays && daysPastDue <= r.maxDays) || CLASSIFICATION_RULES[0];
}

export function classificationRule(c: LoanClassification | undefined): ClassificationRule {
  return CLASSIFICATION_RULES.find(r => r.classification === c) || CLASSIFICATION_RULES[0];
}

export interface LoanOverdueState {
  overdueAmount: number;
  missedInstallmentsCount: number;
  daysPastDue: number;
  oldestOverdueDate: string | null;
  classification: LoanClassification;
  /** নির্ধারিত তারিখ পার হওয়া কিস্তিগুলো (OVERDUE মার্ক করতে হবে) */
  overdueInstallmentIds: number[];
}

/** নির্ধারিত তারিখ আজকের আগে, এখনো পুরো পরিশোধ হয়নি = বকেয়া */
export function loanOverdueState(installments: InstallmentSchedule[], today: string): LoanOverdueState {
  const overdue = installments
    .filter(i => !i.isDeleted && !isSettledStatus(i.status) && i.dueDate < today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const oldest = overdue[0]?.dueDate || null;
  const daysPastDue = oldest ? diffDaysKey(oldest, today) : 0;
  return {
    overdueAmount: overdue.reduce((s, i) => s + remainingOf(i).total, 0),
    missedInstallmentsCount: overdue.length,
    daysPastDue,
    oldestOverdueDate: oldest,
    classification: classify(daysPastDue).classification,
    overdueInstallmentIds: overdue.map(i => i.installmentId)
  };
}

/** বাকি আসল — নতুন ঋণে সরাসরি ট্র্যাক করা হয়, পুরাতন ঋণে আনুপাতিক হিসাব */
export function outstandingPrincipal(loan: Loan): number {
  if (loan.status === 'CLOSED' || loan.status === 'WRITTEN_OFF' || loan.status === 'CANCELLED' || loan.status === 'REJECTED') return 0;
  if (typeof loan.outstandingPrincipal === 'number') return Math.max(0, loan.outstandingPrincipal);
  if (!loan.totalRepayableAmount) return Math.max(0, loan.outstandingBalance || 0);
  return Math.max(0, Math.round((loan.outstandingBalance || 0) * (loan.principalAmount / loan.totalRepayableAmount)));
}

export interface PortfolioQuality {
  loansCount: number;
  outstandingPrincipal: number;
  par1Amount: number;
  par30Amount: number;
  par1Percent: number;
  par30Percent: number;
  requiredProvision: number;
  byClass: { rule: ClassificationRule; loans: number; outstanding: number; provision: number }[];
}

/** PAR (Portfolio at Risk) ও সঞ্চিতি — শুধু চলমান ঋণ */
export function portfolioQuality(loans: Loan[]): PortfolioQuality {
  const active = loans.filter(l => !l.isDeleted && (l.status === 'DISBURSED' || l.status === 'OVERDUE'));
  const byClass = CLASSIFICATION_RULES.map(rule => ({ rule, loans: 0, outstanding: 0, provision: 0 }));
  let total = 0, par1 = 0, par30 = 0;
  for (const loan of active) {
    const op = outstandingPrincipal(loan);
    const dpd = loan.daysPastDue || 0;
    total += op;
    if (dpd >= 1) par1 += op;
    if (dpd > 30) par30 += op;
    const bucket = byClass.find(b => b.rule.classification === classify(dpd).classification)!;
    bucket.loans++;
    bucket.outstanding += op;
    bucket.provision += Math.round(op * bucket.rule.provisionRate);
  }
  const pct = (part: number) => (total > 0 ? Math.round((part / total) * 10000) / 100 : 0);
  return {
    loansCount: active.length,
    outstandingPrincipal: total,
    par1Amount: par1,
    par30Amount: par30,
    par1Percent: pct(par1),
    par30Percent: pct(par30),
    requiredProvision: byClass.reduce((s, b) => s + b.provision, 0),
    byClass
  };
}

/**
 * OTR (সময়মতো আদায়ের হার) ও CRR (ক্রমপুঞ্জিত আদায়ের হার)।
 * OTR = নির্ধারিত তারিখের মধ্যে আদায় / নির্ধারিত পাওনা; CRR = মোট আদায় / মোট পাওনা (আজ পর্যন্ত)।
 */
export function recoveryRates(installments: InstallmentSchedule[], today: string, paidDayKey: (iso: string) => string) {
  let dueTotal = 0, onTime = 0, collected = 0;
  for (const i of installments) {
    if (i.isDeleted || i.status === 'RESCHEDULED' || i.status === 'WAIVED' || i.dueDate > today) continue;
    const expected = (i.expectedPrincipal || 0) + (i.expectedProfit || 0);
    const paid = (i.paidPrincipal || 0) + (i.paidProfit || 0);
    dueTotal += expected;
    collected += Math.min(paid, expected);
    if (i.paidDate && paidDayKey(i.paidDate) <= i.dueDate) onTime += Math.min(paid, expected);
  }
  const pct = (part: number) => (dueTotal > 0 ? Math.round((part / dueTotal) * 10000) / 100 : 100);
  return { dueTotal, onTimeCollected: onTime, collected, otrPercent: pct(onTime), crrPercent: pct(collected) };
}
