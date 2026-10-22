import { InstallmentSchedule } from '../models/database.models';
import { isSettledStatus, remainingOf } from './allocation';

export interface EarlySettlementQuote {
  remainingPrincipal: number;
  /** আজ পর্যন্ত নির্ধারিত কিস্তির অনাদায়ী লাভ (মওকুফ নয়) */
  dueProfit: number;
  /** ভবিষ্যৎ কিস্তির লাভ (অনর্জিত) */
  futureProfit: number;
  rebate: number;
  payoffAmount: number;
}

/**
 * আগাম পরিশোধ (Early Settlement): বাকি আসল + বকেয়া লাভ + (ভবিষ্যৎ লাভ − রিবেট)।
 * rebatePercent = ভবিষ্যৎ লাভের কত % মওকুফ (প্রোডাক্ট নীতি অনুযায়ী)।
 */
export function earlySettlementQuote(installments: InstallmentSchedule[], today: string, rebatePercent: number): EarlySettlementQuote {
  let remainingPrincipal = 0, dueProfit = 0, futureProfit = 0;
  for (const inst of installments) {
    if (inst.isDeleted || isSettledStatus(inst.status)) continue;
    const rem = remainingOf(inst);
    remainingPrincipal += rem.principal;
    if (inst.dueDate <= today) dueProfit += rem.profit; else futureProfit += rem.profit;
  }
  const rebate = Math.round(futureProfit * Math.min(100, Math.max(0, rebatePercent)) / 100);
  return {
    remainingPrincipal,
    dueProfit,
    futureProfit,
    rebate,
    payoffAmount: remainingPrincipal + dueProfit + futureProfit - rebate
  };
}
