/**
 * ব্যবসায়িক তারিখ (Asia/Dhaka, UTC+6)।
 * সব ব্যবসায়িক তারিখ "YYYY-MM-DD" স্ট্রিং হিসেবে রাখা হয়, যাতে রাত ১২টা–সকাল ৬টার
 * আদায় UTC অনুযায়ী আগের দিনে চলে না যায়।
 */
export const BUSINESS_TIME_ZONE = 'Asia/Dhaka';

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

/** যেকোনো সময় → ঢাকার তারিখ "YYYY-MM-DD" */
export function toDhakaDayKey(value: string | number | Date = new Date()): string {
  // ইতোমধ্যে "YYYY-MM-DD" হলে পরিবর্তন নয়
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return dayKeyFormatter.format(new Date(value));
}

/** আজকের ব্যবসায়িক তারিখ (ঢাকা) */
export function todayDhaka(): string {
  return toDhakaDayKey(new Date());
}

/** "YYYY-MM" (ঢাকা) */
export function monthKeyDhaka(value: string | number | Date = new Date()): string {
  return toDhakaDayKey(value).slice(0, 7);
}

function parseDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDaysKey(key: string, days: number): string {
  const d = parseDayKey(key);
  d.setUTCDate(d.getUTCDate() + days);
  return formatUtc(d);
}

/** মাস যোগ — মাসের শেষ দিনে আটকানো (৩১ জানুয়ারি + ১ মাস = ২৮/২৯ ফেব্রুয়ারি, ৩ মার্চ নয়) */
export function addMonthsKey(key: string, months: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, targetMonthIndex + 1, 0)).getUTCDate();
  return formatUtc(new Date(Date.UTC(y, targetMonthIndex, Math.min(d, lastDay))));
}

/** 0 = রবিবার … 5 = শুক্রবার, 6 = শনিবার */
export function dayOfWeekKey(key: string): number {
  return parseDayKey(key).getUTCDay();
}

/** b − a (দিন) */
export function diffDaysKey(a: string, b: string): number {
  return Math.round((parseDayKey(b).getTime() - parseDayKey(a).getTime()) / 86_400_000);
}

export function isLastDayOfMonth(key: string): boolean {
  return addDaysKey(key, 1).slice(0, 7) !== key.slice(0, 7);
}

const bnLongDate = new Intl.DateTimeFormat('bn-BD', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const bnShortDate = new Intl.DateTimeFormat('bn-BD', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const bnWeekday = new Intl.DateTimeFormat('bn-BD', { weekday: 'long', timeZone: 'UTC' });

/** "YYYY-MM-DD" → "বৃহস্পতিবার, ৫ নভেম্বর, ২০২৬" */
export function formatBnDate(key: string | null | undefined, short = false): string {
  if (!key) return '';
  const d = parseDayKey(toDhakaDayKey(key));
  return (short ? bnShortDate : bnLongDate).format(d);
}

/** "YYYY-MM-DD" → "বৃহস্পতিবার" */
export function weekdayBn(key: string | null | undefined): string {
  return key ? bnWeekday.format(parseDayKey(toDhakaDayKey(key))) : '';
}

/** সমিতির মিটিং-দিনের নাম → 0 (রবিবার) … 6 (শনিবার); 'Daily' বা অজানা হলে null */
export const MEETING_DAY_INDEX: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6
};

/** from তারিখ বা তার পরের প্রথম নির্দিষ্ট বার (weekday 0–6) */
export function onOrAfterWeekday(from: string, weekday: number): string {
  const diff = (weekday - dayOfWeekKey(from) + 7) % 7;
  return addDaysKey(from, diff);
}
