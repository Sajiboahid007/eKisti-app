/**
 * একজন গ্রাহকের একসাথে কয়টি চলমান/প্রক্রিয়াধীন ঋণ থাকতে পারে — ঋণ আবেদনকারী কর্মীর পদ অনুযায়ী।
 *  • শাখা ব্যবস্থাপক, অ্যাডমিন, সুপার অ্যাডমিন, হেড অফিস ও এরিয়া ম্যানেজার: সর্বোচ্চ ৩টি
 *  • অন্যান্য পদ (মাঠকর্মী, ক্যাশিয়ার …): সর্বোচ্চ ১টি
 */
export const SENIOR_LOAN_MAX = 3;
export const DEFAULT_LOAN_MAX = 1;

const SENIOR_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'REGIONAL_MANAGER', 'AREA_MANAGER', 'CENTRAL_AUDITOR', 'BRANCH_MANAGER'];
const SENIOR_CATEGORIES = ['SYSTEM_ADMIN', 'HEAD_OFFICE'];

export function maxOpenLoansFor(role: string | null | undefined, category?: string | null): number {
  if (role && SENIOR_ROLES.includes(role)) return SENIOR_LOAN_MAX;
  if (category && SENIOR_CATEGORIES.includes(category)) return SENIOR_LOAN_MAX;
  return DEFAULT_LOAN_MAX;
}
