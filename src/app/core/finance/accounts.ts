import { JournalLine } from '../models/database.models';

/**
 * হিসাবের খাত (Chart of Accounts) — দ্বৈত লেখা (Double Entry)।
 * সার্ভিস চার্জ নগদ ভিত্তিতে আয় (আদায় হলে আয়), তাই "ঋণ পাওনা" শুধু আসল ধরে রাখে।
 */
export interface AccountDef {
  code: string;
  nameBn: string;
  nameEn: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
}

export const ACCOUNTS = {
  VAULT_CASH: '1010',
  CASH_IN_FIELD: '1020',
  BANK: '1030',
  MOBILE_CLEARING: '1040',
  LOANS_RECEIVABLE: '1100',
  SHORTAGE_RECEIVABLE: '1200',
  MEMBER_SAVINGS: '2010',
  HEAD_OFFICE_FUND: '2100',
  LOAN_RISK_FUND: '2300',
  OPENING_EQUITY: '3010',
  SERVICE_CHARGE_INCOME: '4010',
  FEE_INCOME: '4020',
  CASH_EXCESS_INCOME: '4030',
  BAD_DEBT_RECOVERY: '4040',
  OPERATING_EXPENSE: '5010',
  SAVINGS_INTEREST_EXPENSE: '5020',
  WRITE_OFF_EXPENSE: '5030'
} as const;

export const CHART_OF_ACCOUNTS: AccountDef[] = [
  { code: '1010', nameBn: 'শাখা ভল্ট নগদ', nameEn: 'Vault Cash', type: 'ASSET' },
  { code: '1020', nameBn: 'মাঠকর্মীর হাতে নগদ', nameEn: 'Cash in Field', type: 'ASSET' },
  { code: '1030', nameBn: 'ব্যাংক হিসাব', nameEn: 'Bank', type: 'ASSET' },
  { code: '1040', nameBn: 'মোবাইল ব্যাংকিং (বিকাশ/নগদ)', nameEn: 'Mobile Banking Clearing', type: 'ASSET' },
  { code: '1100', nameBn: 'ঋণ গ্রহীতার কাছে পাওনা (আসল)', nameEn: 'Loans Receivable', type: 'ASSET' },
  { code: '1200', nameBn: 'ক্যাশ ঘাটতি (কর্মীর কাছে পাওনা)', nameEn: 'Cash Shortage Receivable', type: 'ASSET' },
  { code: '2010', nameBn: 'সদস্য সঞ্চয়', nameEn: 'Member Savings', type: 'LIABILITY' },
  { code: '2100', nameBn: 'প্রধান কার্যালয় তহবিল', nameEn: 'Head Office Fund', type: 'LIABILITY' },
  { code: '2300', nameBn: 'ঋণ ঝুঁকি তহবিল / বীমা', nameEn: 'Loan Risk Fund', type: 'LIABILITY' },
  { code: '3010', nameBn: 'প্রারম্ভিক স্থিতি / সমন্বয়', nameEn: 'Opening Balance Equity', type: 'EQUITY' },
  { code: '4010', nameBn: 'সার্ভিস চার্জ আয়', nameEn: 'Service Charge Income', type: 'INCOME' },
  { code: '4020', nameBn: 'ফি আয় (ভর্তি/পাসবুক/ফরম)', nameEn: 'Fee Income', type: 'INCOME' },
  { code: '4030', nameBn: 'অতিরিক্ত ক্যাশ', nameEn: 'Cash Excess', type: 'INCOME' },
  { code: '4040', nameBn: 'অবলোপিত ঋণ আদায়', nameEn: 'Bad Debt Recovery', type: 'INCOME' },
  { code: '5010', nameBn: 'পরিচালন ব্যয়', nameEn: 'Operating Expenses', type: 'EXPENSE' },
  { code: '5020', nameBn: 'সঞ্চয়ের মুনাফা ব্যয়', nameEn: 'Savings Interest Expense', type: 'EXPENSE' },
  { code: '5030', nameBn: 'ঋণ অবলোপন ব্যয়', nameEn: 'Loan Write-off Expense', type: 'EXPENSE' }
];

export function accountName(code: string, bangla = true): string {
  const acc = CHART_OF_ACCOUNTS.find(a => a.code === code);
  return acc ? (bangla ? acc.nameBn : acc.nameEn) : code;
}

/** শূন্য লাইন বাদ দিয়ে ডেবিট = ক্রেডিট যাচাই */
export function balancedLines(lines: JournalLine[]): JournalLine[] {
  const clean = lines
    .map(l => ({ account: l.account, debit: Math.round((l.debit || 0) * 100) / 100, credit: Math.round((l.credit || 0) * 100) / 100 }))
    .filter(l => l.debit > 0 || l.credit > 0);
  const dr = clean.reduce((s, l) => s + l.debit, 0);
  const cr = clean.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(dr - cr) > 0.009) {
    throw new Error(`জার্নাল ভারসাম্যহীন: ডেবিট ${dr} ≠ ক্রেডিট ${cr}`);
  }
  return clean;
}

/** নগদ নাকি ডিজিটাল আদায়ের খাত */
export function collectionCashAccount(method: string): string {
  if (method === 'SAVINGS') return ACCOUNTS.MEMBER_SAVINGS; // সঞ্চয় হতে কিস্তি সমন্বয় — নগদ নয়
  return method === 'CASH' ? ACCOUNTS.CASH_IN_FIELD : ACCOUNTS.MOBILE_CLEARING;
}
