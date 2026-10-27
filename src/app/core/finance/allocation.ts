import { InstallmentSchedule, InstallmentStatus } from '../models/database.models';

/** যে কিস্তিতে আর কিছু আদায়যোগ্য নেই */
export function isSettledStatus(status: InstallmentStatus): boolean {
  return status === 'PAID' || status === 'ADVANCE' || status === 'WAIVED' || status === 'RESCHEDULED';
}

export function remainingOf(inst: Pick<InstallmentSchedule, 'expectedPrincipal' | 'expectedProfit' | 'paidPrincipal' | 'paidProfit' | 'status'>) {
  if (isSettledStatus(inst.status)) return { principal: 0, profit: 0, total: 0 };
  const principal = Math.max(0, (inst.expectedPrincipal || 0) - (inst.paidPrincipal || 0));
  const profit = Math.max(0, (inst.expectedProfit || 0) - (inst.paidProfit || 0));
  return { principal, profit, total: principal + profit };
}

export interface InstallmentAllocation {
  installmentId: number;
  installmentNo: number;
  principal: number;
  profit: number;
  savings: number;
  previousStatus: InstallmentStatus;
  newStatus: InstallmentStatus;
}

export interface PaymentAllocation {
  allocations: InstallmentAllocation[];
  principalTotal: number;
  profitTotal: number;
  savingsTotal: number;
  /** ঋণের বকেয়ার চেয়ে বেশি টাকা দেওয়া হলে অবশিষ্ট (সার্ভিস এটি প্রত্যাখ্যান করে) */
  unallocated: number;
}

/**
 * কিস্তির টাকা পুরাতন কিস্তি থেকে বণ্টন (বকেয়া → চলতি → অগ্রিম)।
 * প্রতিটি কিস্তিতে আগে লাভ, পরে আসল। আংশিক হলে PARTIAL, সম্পূর্ণ হলে PAID
 * (ভবিষ্যতের তারিখের কিস্তি আগাম পরিশোধ হলে ADVANCE)।
 * সঞ্চয় প্রথম যে কিস্তিতে টাকা যায় তাতে যোগ হয়।
 */
export function allocatePayment(
  installments: InstallmentSchedule[],
  loanAmount: number,
  savingsAmount: number,
  today: string
): PaymentAllocation {
  let left = Math.round(Math.max(0, loanAmount) * 100) / 100;
  const allocations: InstallmentAllocation[] = [];
  const open = installments
    .filter(i => !i.isDeleted && !isSettledStatus(i.status))
    .sort((a, b) => a.installmentNo - b.installmentNo);

  for (const inst of open) {
    if (left <= 0) break;
    const rem = remainingOf(inst);
    if (rem.total <= 0) continue;

    const profit = Math.min(left, rem.profit);
    left = Math.round((left - profit) * 100) / 100;
    const principal = Math.min(left, rem.principal);
    left = Math.round((left - principal) * 100) / 100;

    const fullyPaid = Math.abs(profit - rem.profit) < 0.005 && Math.abs(principal - rem.principal) < 0.005;
    allocations.push({
      installmentId: inst.installmentId,
      installmentNo: inst.installmentNo,
      principal,
      profit,
      savings: 0,
      previousStatus: inst.status,
      newStatus: fullyPaid ? (inst.dueDate > today ? 'ADVANCE' : 'PAID') : 'PARTIAL'
    });
  }

  const savings = Math.max(0, savingsAmount);
  if (savings > 0) {
    if (allocations.length > 0) {
      allocations[0].savings = savings;
    } else if (open.length > 0) {
      // শুধু সঞ্চয় জমা — কিস্তির অবস্থা অপরিবর্তিত
      allocations.push({
        installmentId: open[0].installmentId,
        installmentNo: open[0].installmentNo,
        principal: 0,
        profit: 0,
        savings,
        previousStatus: open[0].status,
        newStatus: open[0].status
      });
    }
  }

  return {
    allocations,
    principalTotal: allocations.reduce((s, a) => s + a.principal, 0),
    profitTotal: allocations.reduce((s, a) => s + a.profit, 0),
    savingsTotal: allocations.reduce((s, a) => s + a.savings, 0),
    unallocated: Math.round(left * 100) / 100
  };
}

/**
 * পুরাতন থেকে প্রথম n টি অপরিশোধিত কিস্তির বাকি টাকা ও সঞ্চয় — মাঠে সাধারণত একবারে একটি কিস্তি নেওয়া হয়।
 */
export function amountForInstallments(installments: InstallmentSchedule[], n: number): { amount: number; savings: number; count: number } {
  const open = installments
    .filter(i => !i.isDeleted && !isSettledStatus(i.status))
    .sort((a, b) => a.installmentNo - b.installmentNo)
    .slice(0, Math.max(0, n));
  return {
    amount: open.reduce((s, i) => s + remainingOf(i).total, 0),
    savings: open.reduce((s, i) => s + Math.max(0, (i.expectedSavings || 0) - (i.paidSavings || 0)), 0),
    count: open.length
  };
}

/** প্রস্তাবিত আদায়ে কোন কিস্তি পূর্ণ / আংশিক হবে — ফর্মে লাইভ প্রিভিউ */
export function describeAllocation(installments: InstallmentSchedule[], loanAmount: number, today: string): { installmentNo: number; amount: number; full: boolean; advance: boolean }[] {
  const plan = allocatePayment(installments, loanAmount, 0, today);
  return plan.allocations
    .filter(a => a.principal + a.profit > 0)
    .map(a => ({
      installmentNo: a.installmentNo,
      amount: a.principal + a.profit,
      full: a.newStatus === 'PAID' || a.newStatus === 'ADVANCE',
      advance: a.newStatus === 'ADVANCE'
    }));
}

/** আজকের পরের প্রথম অপরিশোধিত কিস্তি — "পরবর্তী কিস্তি কবে" দেখাতে */
export function upcomingInstallment(installments: InstallmentSchedule[], today: string): InstallmentSchedule | null {
  return installments
    .filter(i => !i.isDeleted && !isSettledStatus(i.status) && i.dueDate > today)
    .sort((a, b) => a.installmentNo - b.installmentNo)[0] || null;
}

/** প্রস্তাবিত আদায়ের পর যে কিস্তি প্রথম বাকি থাকবে (আংশিক হলে সেটিই) */
export function nextOpenAfterPayment(installments: InstallmentSchedule[], loanAmount: number, today: string): { installment: InstallmentSchedule; remaining: number } | null {
  const plan = allocatePayment(installments, loanAmount, 0, today);
  const paid = new Map(plan.allocations.map(a => [a.installmentId, a]));
  const open = installments
    .filter(i => !i.isDeleted && !isSettledStatus(i.status))
    .sort((a, b) => a.installmentNo - b.installmentNo);
  for (const inst of open) {
    const a = paid.get(inst.installmentId);
    const remaining = remainingOf(inst).total - (a ? a.principal + a.profit : 0);
    if (remaining > 0.009) return { installment: inst, remaining };
  }
  return null;
}

/** মাঠ শিটের জন্য ঋণের আদায় অবস্থা — "শেষ আদায়ের পর ৭ দিন" নয়, কিস্তির নির্ধারিত তারিখ অনুযায়ী */
export interface CollectionView {
  /** আজ পর্যন্ত বকেয়া + চলতি কিস্তির অবশিষ্ট (আসল + লাভ) */
  dueAmount: number;
  dueSavings: number;
  dueInstallments: InstallmentSchedule[];
  overdueCount: number;
  nextInstallment: InstallmentSchedule | null;
  /** আজ কোনো কিস্তি নির্ধারিত বা বকেয়া আছে কি না */
  hasDue: boolean;
  /** আজ ইতোমধ্যে আদায় হয়েছে কি না */
  collectedToday: boolean;
  totalOutstanding: number;
}

export function collectionView(installments: InstallmentSchedule[], today: string, paidDayKey: (iso: string) => string): CollectionView {
  const sorted = installments.filter(i => !i.isDeleted).sort((a, b) => a.installmentNo - b.installmentNo);
  const open = sorted.filter(i => !isSettledStatus(i.status));
  const due = open.filter(i => i.dueDate <= today);
  return {
    dueAmount: due.reduce((s, i) => s + remainingOf(i).total, 0),
    dueSavings: due.reduce((s, i) => s + Math.max(0, (i.expectedSavings || 0) - (i.paidSavings || 0)), 0),
    dueInstallments: due,
    overdueCount: due.filter(i => i.dueDate < today).length,
    nextInstallment: open[0] || null,
    hasDue: due.length > 0,
    collectedToday: sorted.some(i => !!i.paidDate && paidDayKey(i.paidDate) === today),
    totalOutstanding: open.reduce((s, i) => s + remainingOf(i).total, 0)
  };
}
