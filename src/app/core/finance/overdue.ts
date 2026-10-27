import { Customer, InstallmentSchedule, Loan, LoanClassification, LoanStatus } from '../models/database.models';
import { loanOverdueState } from './classification';

/**
 * বকেয়া ইঞ্জিনের বিশুদ্ধ হিসাব — কোন কিস্তি OVERDUE হবে, কোন ঋণের অবস্থা/বকেয়া/শ্রেণী বদলাবে,
 * কোন গ্রাহকের ক্রেডিট স্কোর বদলাবে। Firestore লেখা কলকারী করে:
 * ব্রাউজারে OverdueEngineService এবং সার্ভারে Cloud Function (functions/src/index.ts) — দুজনেই এটি ব্যবহার করে।
 */

export interface LoanOverdueUpdate {
  loanId: number;
  customerId: number;
  branchId: number;
  fromStatus: LoanStatus;
  status: LoanStatus;
  overdueAmount: number;
  missedInstallmentsCount: number;
  daysPastDue: number;
  classification: LoanClassification;
  statusChanged: boolean;
  /** অবস্থা বদলালে loanStatusHistory-র কারণ */
  reason: string;
}

export interface OverduePlan {
  loansChecked: number;
  installmentIdsToMark: number[];
  loanUpdates: LoanOverdueUpdate[];
  /** গ্রাহকভিত্তিক চলমান ঋণের সর্বোচ্চ বকেয়া দিন */
  maxDpdByCustomer: Map<number, number>;
}

/** চলমান (DISBURSED/OVERDUE) ঋণ ও তাদের খোলা কিস্তি থেকে আজকের পরিবর্তনের তালিকা */
export function planOverdueRun(loans: Loan[], installmentsByLoan: Map<number, InstallmentSchedule[]>, today: string): OverduePlan {
  const plan: OverduePlan = { loansChecked: loans.length, installmentIdsToMark: [], loanUpdates: [], maxDpdByCustomer: new Map() };

  for (const loan of loans) {
    const insts = installmentsByLoan.get(loan.loanId) || [];
    const state = loanOverdueState(insts, today);
    plan.maxDpdByCustomer.set(loan.customerId, Math.max(plan.maxDpdByCustomer.get(loan.customerId) || 0, state.daysPastDue));

    for (const inst of insts) {
      if (inst.status === 'PENDING' && state.overdueInstallmentIds.includes(inst.installmentId)) {
        plan.installmentIdsToMark.push(inst.installmentId);
      }
    }

    const status: LoanStatus = state.missedInstallmentsCount > 0 ? 'OVERDUE' : 'DISBURSED';
    const changed = loan.status !== status
      || (loan.overdueAmount || 0) !== state.overdueAmount
      || (loan.missedInstallmentsCount || 0) !== state.missedInstallmentsCount
      || (loan.daysPastDue || 0) !== state.daysPastDue
      || loan.classification !== state.classification;
    if (!changed) continue;

    plan.loanUpdates.push({
      loanId: loan.loanId,
      customerId: loan.customerId,
      branchId: Number(loan.branchId),
      fromStatus: loan.status,
      status,
      overdueAmount: state.overdueAmount,
      missedInstallmentsCount: state.missedInstallmentsCount,
      daysPastDue: state.daysPastDue,
      classification: state.classification,
      statusChanged: loan.status !== status,
      reason: status === 'OVERDUE' ? `${state.missedInstallmentsCount}টি কিস্তি বকেয়া (${state.daysPastDue} দিন)` : 'বকেয়া পরিশোধিত'
    });
  }
  return plan;
}

/** ক্রেডিট স্কোর নিয়ম: চলমান ঋণের সর্বোচ্চ বকেয়া দিন অনুযায়ী (কালো তালিকা শুধু ম্যানুয়ালি) */
export function scoreForDaysPastDue(maxDaysPastDue: number): Customer['creditScore'] {
  if (maxDaysPastDue === 0) return 'GOOD';
  if (maxDaysPastDue <= 30) return 'AVERAGE';
  return 'RISKY';
}

/** নতুন স্কোর — বদল না হলে null। কালো তালিকা অপরিবর্তিত; ঝুঁকিপূর্ণ থেকে সরাসরি "ভালো" নয়, "মাঝারি" */
export function nextCreditScore(current: Customer['creditScore'], maxDaysPastDue: number): Customer['creditScore'] | null {
  if (current === 'BLACKLISTED') return null;
  const next = scoreForDaysPastDue(maxDaysPastDue);
  const target = current === 'RISKY' && next === 'GOOD' ? 'AVERAGE' : next;
  return target === current ? null : target;
}

/** systemJobs মার্কারের আইডি — সার্ভারের দৈনিক রান সবসময় 'overdue_ALL' */
export function overdueMarkerId(branchIds: number[] | null): string {
  return `overdue_${branchIds === null ? 'ALL' : [...branchIds].sort((a, b) => a - b).join('-') || 'NONE'}`;
}
