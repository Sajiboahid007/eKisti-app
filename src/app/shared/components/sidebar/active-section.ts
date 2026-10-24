/** সাইডবারের মেনু পাথ — যে পেজগুলো সরাসরি মেনু থেকে খোলা যায় */
export const MENU_PATHS = [
  '/dashboard', '/collections/daily', '/customers', '/loans', '/loans/approvals', '/savings',
  '/collections/receipts', '/reconciliation', '/accounts', '/reports', '/branches', '/settings', '/users'
] as const;

/**
 * কোন মেনু সক্রিয় দেখাবে।
 *
 * মেনুর পেজে থাকলে সেটিই। মেনুতে নেই এমন ভেতরের পেজে (নতুন ঋণ/বিতরণ, ঋণের বিস্তারিত,
 * গ্রাহক যোগ/সম্পাদনা, স্টাফ ফর্ম) যে মেনু থেকে এসেছেন সেটিই সক্রিয় থাকে — যেমন
 * "ঋণ আবেদন ও অনুমোদন" থেকে বিতরণে গেলে অনুমোদন মেনুই সক্রিয়।
 * আগের মেনু জানা না থাকলে (সরাসরি লিংক / রিফ্রেশ) পাথের সবচেয়ে লম্বা মিল।
 */
export interface InnerPage {
  /** routerLink পাথ */
  path: string;
  queryParams?: Record<string, string>;
  label: string;
  labelEn: string;
  icon: string;
}

/** মেনুতে নেই এমন ভেতরের পেজ — সাইডবারে সক্রিয় মেনুর নিচে উপ-মেনু হিসেবে দেখায় */
export function innerPageOf(url: string): InnerPage | null {
  const [path, query = ''] = url.split('#')[0].split('?');
  const loanId = new URLSearchParams(query).get('loanId');
  let m: RegExpMatchArray | null;
  if (path === '/loans/disburse') {
    return loanId
      ? { path, queryParams: { loanId }, label: `ঋণ বিতরণ #${loanId}`, labelEn: `Disburse Loan #${loanId}`, icon: 'payments' }
      : { path, label: 'নতুন ঋণ আবেদন', labelEn: 'New Loan Application', icon: 'add_circle' };
  }
  if ((m = path.match(/^\/loans\/detail\/(\d+)$/))) {
    return { path, label: `কিস্তি শিডিউল #${m[1]}`, labelEn: `Installment Schedule #${m[1]}`, icon: 'calendar_month' };
  }
  if (path === '/customers/new' || path === '/customers/register') {
    return { path, label: 'নতুন গ্রাহক ভর্তি', labelEn: 'New Customer', icon: 'person_add' };
  }
  if ((m = path.match(/^\/customers\/edit\/(\d+)$/))) {
    return { path, label: `গ্রাহক সম্পাদনা #${m[1]}`, labelEn: `Edit Customer #${m[1]}`, icon: 'edit' };
  }
  if (path === '/users/new') {
    return { path, label: 'নতুন স্টাফ', labelEn: 'New Staff', icon: 'person_add' };
  }
  return null;
}

/**
 * যে ভেতরের পেজ সবসময় একটি নির্দিষ্ট মেনুর অংশ — যেখান থেকেই আসুন।
 * নতুন ঋণ আবেদন ও বিতরণ ঋণ অনুমোদন প্রবাহের ধাপ, তাই "ঋণ আবেদন ও অনুমোদন" মেনুর নিচে।
 */
export const SECTION_OWNERS: Record<string, string> = {
  '/loans/disburse': '/loans/approvals'
};

export function resolveActiveSection(url: string, previous: string | null, menu: readonly string[] = MENU_PATHS): string | null {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  if (menu.includes(path)) return path;
  const owner = SECTION_OWNERS[path];
  if (owner && menu.includes(owner)) return owner;
  if (previous && menu.includes(previous)) return previous;
  let best: string | null = null;
  for (const m of menu) {
    if (path.startsWith(m + '/') && (!best || m.length > best.length)) best = m;
  }
  return best;
}
