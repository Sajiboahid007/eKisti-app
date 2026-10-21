import { Injectable, signal, computed } from '@angular/core';

export type LanguageCode = 'bn' | 'en';

export const TRANSLATIONS: Record<string, { bn: string; en: string }> = {
  // App General
  appName: { bn: 'eKisti', en: 'eKisti' },
  appTagline: { bn: 'স্মার্ট লোকাল লোন ও কিস্তি ব্যবস্থাপনা', en: 'Smart Microfinance & Loan Management' },
  branch: { bn: 'শাখা', en: 'Branch' },
  language: { bn: 'ভাষা', en: 'Language' },
  logout: { bn: 'লগআউট', en: 'Logout' },
  login: { bn: 'লগইন', en: 'Login' },
  role: { bn: 'রোল / পদবী', en: 'Role' },
  switchRole: { bn: 'রোল পরিবর্তন', en: 'Switch Role' },
  save: { bn: 'সংরক্ষণ করুন', en: 'Save' },
  cancel: { bn: 'বাতিল', en: 'Cancel' },
  back: { bn: 'ফিরে যান', en: 'Back' },
  search: { bn: 'অনুসন্ধান করুন...', en: 'Search...' },
  action: { bn: 'অ্যাকশন', en: 'Action' },
  status: { bn: 'স্ট্যাটাস', en: 'Status' },
  active: { bn: 'সক্রিয়', en: 'Active' },
  inactive: { bn: 'নিষ্ক্রিয়', en: 'Inactive' },
  date: { bn: 'তারিখ', en: 'Date' },
  total: { bn: 'মোট', en: 'Total' },

  // Navigation Menu
  navMainMenu: { bn: 'প্রধান মেনু', en: 'Main Menu' },
  navAccounting: { bn: 'অ্যাকাউন্টিং ও অডিট', en: 'Accounting & Audit' },
  navAdministration: { bn: 'প্রশাসন ও কর্মী', en: 'Administration' },
  navDashboard: { bn: 'ড্যাশবোর্ড', en: 'Dashboard' },
  navDailySheet: { bn: 'সমিতির কিস্তি আদায়', en: 'Daily Field Sheet' },
  navCustomers: { bn: 'গ্রাহক তালিকা ও KYC', en: 'Customers & KYC' },
  navLoans: { bn: 'ঋণ হিসাব ও বিতরণ', en: 'Loans & Disbursement' },
  navReceipts: { bn: 'মানি রসিদ রেজিস্টার', en: 'Money Receipts' },
  navCashClosing: { bn: 'ক্যাশিয়ার ভল্ট ও ক্লোজিং', en: 'Cashier Closing' },
  navUsers: { bn: 'স্টাফ ও ইউজার ম্যানেজমেন্ট', en: 'Staff & Users' },

  // Login Screen
  loginWelcome: { bn: 'eKisti সিস্টেমে স্বাগতম', en: 'Welcome to eKisti' },
  loginSubtitle: { bn: 'আপনার একাউন্টে প্রবেশ করতে তথ্য দিন অথবা সরাসরি রোলে ক্লিক করুন', en: 'Sign in with your credentials or select a demo role' },
  emailOrPhone: { bn: 'ইমেইল অথবা মোবাইল নম্বর', en: 'Email or Mobile Number' },
  password: { bn: 'পাসওয়ার্ড', en: 'Password' },
  signInBtn: { bn: 'লগইন করুন', en: 'Sign In' },
  quickDemoLogin: { bn: 'রোল অনুযায়ী ১-ক্লিক ডেমো লগইন:', en: '1-Click Role Demo Login:' },
  roleSuperAdmin: { bn: 'সুপার অ্যাডমিন / এমডি', en: 'Super Admin / MD' },
  roleBranchManager: { bn: 'শাখা ব্যবস্থাপক (BM)', en: 'Branch Manager (BM)' },
  roleFieldOfficer: { bn: 'মাঠকর্মী (FO)', en: 'Field Officer (FO)' },
  roleCashier: { bn: 'ক্যাশিয়ার / হিসাবরক্ষক', en: 'Cashier / Accountant' },

  // Dashboard KPIs
  todayCollection: { bn: 'আজকের মোট কিস্তি আদায়', en: 'Today Total Collection' },
  target: { bn: 'টার্গেট', en: 'Target' },
  outstandingLoans: { bn: 'মোট চলমান ঋণ ব্যালেন্স', en: 'Total Outstanding Loans' },
  vaultCash: { bn: 'শাখা ভল্ট ক্যাশ (নগদ টাকা)', en: 'Branch Vault Cash' },
  overdueLoans: { bn: 'বকেয়া কিস্তি (Overdue)', en: 'Overdue Installments' },
  verifiedCashier: { bn: 'ক্যাশিয়ার ভেরিফাইড', en: 'Cashier Verified' },
  noOverdue: { bn: 'কোনো খেলাপি বা বকেয়া নেই', en: 'No Overdue / Default' },
  urgentFollowup: { bn: 'জরুরি ফলোআপ প্রয়োজন', en: 'Urgent Followup Needed' },
  recentLoans: { bn: 'চলমান ঋণ হিসাব', en: 'Active Loans' },
  recentReceipts: { bn: 'সাম্প্রতিক কিস্তি আদায় রসিদ', en: 'Recent Receipts' },
  allView: { bn: 'সব দেখুন', en: 'View All' },

  // User Management
  usersTitle: { bn: 'স্টাফ ও ইউজার ম্যানেজমেন্ট', en: 'Staff & User Management' },
  usersSubtitle: { bn: 'সুপার অ্যাডমিন কর্তৃক সকল কর্মকর্তা ও মাঠকর্মীদের নিয়ন্ত্রণ', en: 'Super Admin control for all branch staff & officers' },
  newUserBtn: { bn: 'নতুন ইউজার তৈরি করুন', en: 'Create New User' },
  userId: { bn: 'ইউজার আইডি', en: 'User ID' },
  userName: { bn: 'কর্মীর পূর্ণ নাম', en: 'Full Name' },
  userEmail: { bn: 'ইমেইল অ্যাড্রেস', en: 'Email Address' },
  userPhone: { bn: 'মোবাইল নম্বর', en: 'Phone Number' },
  userRole: { bn: 'রোল / পদবী', en: 'Role / Designation' },
  userBranch: { bn: 'নিযুক্ত শাখা', en: 'Assigned Branch' },
  userSalary: { bn: 'মাসিক বেতন', en: 'Monthly Salary' },
  userJoinedDate: { bn: 'যোগদানের তারিখ', en: 'Joined Date' },
  passwordNote: { bn: 'পাসওয়ার্ড বা পিন নম্বর', en: 'Password or PIN' },
  createUserTitle: { bn: 'নতুন কর্মকর্তা / ইউজার নিবন্ধন', en: 'Create New Staff User' },
  editUserTitle: { bn: 'ইউজার তথ্য সংশোধন', en: 'Edit Staff User' },
  superAdminOnly: { bn: 'শুধুমাত্র সুপার অ্যাডমিনের অনুমতি রয়েছে', en: 'Super Admin Access Only' }
};

@Injectable({
  providedIn: 'root'
})
export class LanguageService {
  readonly currentLang = signal<LanguageCode>('bn');

  readonly isBangla = computed(() => this.currentLang() === 'bn');
  readonly isEnglish = computed(() => this.currentLang() === 'en');

  constructor() {
    // Load persisted language from localStorage if available
    const saved = localStorage.getItem('ekisti_lang') as LanguageCode;
    if (saved === 'bn' || saved === 'en') {
      this.currentLang.set(saved);
    }
  }

  setLanguage(lang: LanguageCode) {
    this.currentLang.set(lang);
    localStorage.setItem('ekisti_lang', lang);
  }

  toggleLanguage() {
    const next = this.currentLang() === 'bn' ? 'en' : 'bn';
    this.setLanguage(next);
  }

  /**
   * Translates a key according to the active language
   */
  t(key: string, fallback?: string): string {
    const entry = TRANSLATIONS[key];
    if (!entry) return fallback || key;
    return entry[this.currentLang()] || fallback || key;
  }
}
