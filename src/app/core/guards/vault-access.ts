/**
 * ভল্ট, ব্যাংক, খরচ ও দিবস/মাস সমাপনী (/accounts) — কারা প্রবেশ ও লেনদেন করতে পারেন:
 * সুপার অ্যাডমিন, অ্যাডমিন, প্রধান কার্যালয় (হেড অফিস), শাখা ব্যবস্থাপক ও ক্যাশিয়ার।
 * মাঠকর্মী ও অন্য শাখা কর্মী পারেন না। কোন শাখার ভল্ট — তা canAccessBranch() দিয়ে আলাদাভাবে সীমিত।
 */
const VAULT_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'REGIONAL_MANAGER', 'AREA_MANAGER', 'CENTRAL_AUDITOR', 'BRANCH_MANAGER', 'CASHIER'];
const VAULT_CATEGORIES = ['SYSTEM_ADMIN', 'HEAD_OFFICE'];

export function canAccessVaultFor(role: string | null | undefined, category?: string | null): boolean {
  if (role && VAULT_ROLES.includes(role)) return true;
  return !!category && VAULT_CATEGORIES.includes(category);
}

/** নিরীক্ষক পদ শুধু দেখতে পারেন — firestore.rules → isReadOnlyRole() এর সাথে মিল রেখে */
const READ_ONLY_ROLES = ['CENTRAL_AUDITOR', 'AUDITOR'];

/** ভল্টে লেনদেন / দিবস-মাস সমাপনী করার অনুমতি (দেখার অনুমতি + নিরীক্ষক নন) */
export function canOperateVaultFor(role: string | null | undefined, category?: string | null): boolean {
  return canAccessVaultFor(role, category) && !(role && READ_ONLY_ROLES.includes(role));
}

export const VAULT_ACCESS_DENIED = 'ভল্ট ও দিবস সমাপনী শুধু সুপার অ্যাডমিন, অ্যাডমিন, প্রধান কার্যালয়, শাখা ব্যবস্থাপক ও ক্যাশিয়ার করতে পারেন';
