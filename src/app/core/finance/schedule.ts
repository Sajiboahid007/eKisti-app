import { InstallmentFrequency } from '../models/database.models';
import { addDaysKey, addMonthsKey, dayOfWeekKey } from './dates';

export type InterestMethod = 'FLAT' | 'DECLINING';

/** কিস্তির দিনক্ষণ নির্ধারণের নিয়ম: সাপ্তাহিক ছুটি ও সরকারি ছুটি বাদ */
export interface WorkingCalendar {
  /** 0 = রবিবার … 5 = শুক্রবার */
  weeklyOffDays: number[];
  /** "YYYY-MM-DD" ছুটির তারিখ */
  holidays: Set<string>;
}

export const EMPTY_CALENDAR: WorkingCalendar = { weeklyOffDays: [], holidays: new Set() };

export interface ScheduleInput {
  principal: number;
  /**
   * FLAT: পুরো মেয়াদের জন্য মোট সার্ভিস চার্জ % (যেমন ১০ = আসলের ১০%)।
   * DECLINING: বার্ষিক হ্রাসমান হার % (যেমন ২৪)।
   */
  ratePercent: number;
  method: InterestMethod;
  count: number;
  frequency: InstallmentFrequency;
  firstDueDate: string;
  calendar?: WorkingCalendar;
}

export interface ScheduleRow {
  installmentNo: number;
  dueDate: string;
  principal: number;
  profit: number;
  total: number;
}

export interface LoanSchedule {
  rows: ScheduleRow[];
  totalPrincipal: number;
  totalProfit: number;
  totalRepayable: number;
  /** প্রথম কিস্তির পরিমাণ (শেষ কিস্তি সমন্বয়ের জন্য আলাদা হতে পারে) */
  installmentAmount: number;
  lastInstallmentAmount: number;
  /** হ্রাসমান পদ্ধতিতে সমতুল্য বার্ষিক হার (ডিসক্লোজারের জন্য) */
  effectiveAnnualRate: number;
  expectedClosingDate: string;
}

export function periodsPerYear(frequency: InstallmentFrequency): number {
  if (frequency === 'DAILY') return 365;
  if (frequency === 'MONTHLY') return 12;
  return 52;
}

function isWorkingDay(key: string, cal: WorkingCalendar): boolean {
  return !cal.holidays.has(key) && !cal.weeklyOffDays.includes(dayOfWeekKey(key));
}

/** ছুটির দিন হলে পরের কর্মদিবসে সরানো */
export function nextWorkingDay(key: string, cal: WorkingCalendar): string {
  let cursor = key;
  for (let guard = 0; guard < 60 && !isWorkingDay(cursor, cal); guard++) {
    cursor = addDaysKey(cursor, 1);
  }
  return cursor;
}

/**
 * কিস্তির তারিখসমূহ।
 * দৈনিক: শুধু কর্মদিবস গণনা। সাপ্তাহিক/মাসিক: মূল তারিখ থেকে হিসাব, ছুটি হলে পরের কর্মদিবস
 * (একটি ছুটির কারণে পরের সব কিস্তি সরে যায় না)।
 */
export function buildDueDates(firstDueDate: string, count: number, frequency: InstallmentFrequency, cal: WorkingCalendar = EMPTY_CALENDAR): string[] {
  const dates: string[] = [];
  if (frequency === 'DAILY') {
    let cursor = nextWorkingDay(firstDueDate, cal);
    while (dates.length < count) {
      dates.push(cursor);
      cursor = nextWorkingDay(addDaysKey(cursor, 1), cal);
    }
    return dates;
  }

  for (let i = 0; i < count; i++) {
    const anchor = frequency === 'MONTHLY' ? addMonthsKey(firstDueDate, i) : addDaysKey(firstDueDate, i * 7);
    const due = nextWorkingDay(anchor, cal);
    // একই তারিখে দুটি কিস্তি যেন না পড়ে
    dates.push(dates.length > 0 && due <= dates[dates.length - 1] ? nextWorkingDay(addDaysKey(dates[dates.length - 1], 1), cal) : due);
  }
  return dates;
}

/**
 * পূর্ণ কিস্তি শিডিউল — টাকা পূর্ণসংখ্যায়, শেষ কিস্তিতে রাউন্ডিং সমন্বয়,
 * যাতে আসল ও লাভের যোগফল হুবহু মিলে যায় (কোনো ঋণে ১–৫ টাকা ঝুলে থাকে না)।
 */
export function buildSchedule(input: ScheduleInput): LoanSchedule {
  const count = Math.max(1, Math.floor(input.count));
  const principal = Math.round(input.principal);
  const dueDates = buildDueDates(input.firstDueDate, count, input.frequency, input.calendar);
  const rows: ScheduleRow[] = [];

  if (input.method === 'DECLINING') {
    const i = input.ratePercent / 100 / periodsPerYear(input.frequency);
    const emi = i > 0 ? Math.round((principal * i) / (1 - Math.pow(1 + i, -count))) : Math.round(principal / count);
    let balance = principal;
    for (let n = 1; n <= count; n++) {
      const profit = Math.round(balance * i);
      const principalPart = n === count ? balance : Math.min(balance, Math.max(0, emi - profit));
      balance -= principalPart;
      rows.push({ installmentNo: n, dueDate: dueDates[n - 1], principal: principalPart, profit, total: principalPart + profit });
    }
  } else {
    rows.push(...flatRows(principal, Math.round((principal * input.ratePercent) / 100), dueDates));
  }

  const totalProfit = rows.reduce((s, r) => s + r.profit, 0);
  const schedule: LoanSchedule = {
    rows,
    totalPrincipal: principal,
    totalProfit,
    totalRepayable: principal + totalProfit,
    installmentAmount: rows[0]?.total || 0,
    lastInstallmentAmount: rows[rows.length - 1]?.total || 0,
    effectiveAnnualRate: 0,
    expectedClosingDate: dueDates[dueDates.length - 1] || input.firstDueDate
  };
  schedule.effectiveAnnualRate = effectiveAnnualRate(principal, rows.map(r => r.total), input.frequency);
  return schedule;
}

/** সমান কিস্তি; রাউন্ডিংয়ের অবশিষ্ট শেষ কিস্তিতে, যাতে যোগফল হুবহু মেলে */
function flatRows(principal: number, totalProfit: number, dueDates: string[]): ScheduleRow[] {
  const count = dueDates.length;
  const installment = Math.round((principal + totalProfit) / count);
  const principalPart = Math.round(principal / count);
  let principalLeft = principal;
  let profitLeft = totalProfit;
  const rows: ScheduleRow[] = [];
  for (let n = 1; n <= count; n++) {
    if (n === count) {
      rows.push({ installmentNo: n, dueDate: dueDates[n - 1], principal: principalLeft, profit: profitLeft, total: principalLeft + profitLeft });
      break;
    }
    const p = Math.min(principalLeft, principalPart);
    const prof = Math.min(profitLeft, Math.max(0, installment - p));
    principalLeft -= p;
    profitLeft -= prof;
    rows.push({ installmentNo: n, dueDate: dueDates[n - 1], principal: p, profit: prof, total: p + prof });
  }
  return rows;
}

/**
 * নির্দিষ্ট মোট আসল ও লাভ নতুন কিস্তিতে ভাগ (পুনঃতফসিলে বাকি টাকা নতুন শিডিউলে)।
 * startNo: নতুন কিস্তির প্রথম ক্রমিক নং।
 */
export function buildScheduleFromTotals(params: {
  principal: number;
  profit: number;
  count: number;
  frequency: InstallmentFrequency;
  firstDueDate: string;
  calendar?: WorkingCalendar;
  startNo?: number;
}): ScheduleRow[] {
  const count = Math.max(1, Math.floor(params.count));
  const dueDates = buildDueDates(params.firstDueDate, count, params.frequency, params.calendar);
  const offset = (params.startNo || 1) - 1;
  return flatRows(Math.round(params.principal), Math.round(params.profit), dueDates)
    .map(r => ({ ...r, installmentNo: r.installmentNo + offset }));
}

/**
 * সমতুল্য বার্ষিক হ্রাসমান হার (%) — নগদ প্রবাহের IRR × বছরে কিস্তি সংখ্যা।
 * ফ্ল্যাট হারের প্রকৃত খরচ গ্রাহককে জানাতে (MRA ডিসক্লোজার) ব্যবহৃত।
 */
export function effectiveAnnualRate(principal: number, payments: number[], frequency: InstallmentFrequency): number {
  const totalPaid = payments.reduce((s, p) => s + p, 0);
  if (principal <= 0 || payments.length === 0 || totalPaid <= principal) return 0;

  const npv = (rate: number) => payments.reduce((s, p, k) => s + p / Math.pow(1 + rate, k + 1), 0) - principal;
  let lo = 0;
  let hi = 1;
  while (npv(hi) > 0 && hi < 1e6) hi *= 2;
  for (let iter = 0; iter < 200; iter++) {
    const mid = (lo + hi) / 2;
    if (npv(mid) > 0) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * periodsPerYear(frequency) * 100 * 100) / 100;
}
