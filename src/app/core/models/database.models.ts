/**
 * Bangladeshi Local Loan & Microfinance (কিস্তি ব্যবসা) Database Models
 * All primary keys and foreign keys use Integer Numbers (e.g. 1001, 2001).
 * Supports full Edit History, Soft Deletes, and Audit Trails.
 */

// ==========================================
// 1. EDIT & AUDIT HISTORY MODELS
// ==========================================

export type AuditAction = 
  | 'CREATE' 
  | 'UPDATE' 
  | 'DELETE' 
  | 'RESTORE' 
  | 'STATUS_CHANGE' 
  | 'PAYMENT_COLLECTED' 
  | 'CASH_RECONCILED';

export interface EditHistoryEntry {
  historyId: number;              // Unique integer ID for this edit
  action: AuditAction;
  timestamp: string;              // ISO datetime string
  changedByUserId: number;        // Staff/User integer ID who made the change
  changedByName: string;          // Staff name for quick display
  changedByRole: string;          // e.g. 'Branch Manager', 'Field Officer'
  reason: string;                 // Why was this record edited or deleted?
  previousData?: Record<string, any>; // Snapshot of data before edit
  newData?: Record<string, any>;      // Snapshot of data after edit
  ipAddress?: string;
}

export interface SoftDeletable {
  isDeleted: boolean;
  deletedAt: string | null;
  deletedByUserId: number | null;
  deleteReason: string | null;
}

// ==========================================
// 2. ORGANIZATION, BRANCH & SAMITY (সমিতি/রুট)
// ==========================================

export interface Branch extends SoftDeletable {
  branchId: number;               // Integer ID, e.g. 1, 2, 3
  branchCode: string;             // e.g. "BR-01"
  name: string;                   // "মিরপুর শাখা"
  address: string;
  phone: string;
  regionName: string;             // "Dhaka North"
  areaName: string;               // "Mirpur Zone"
  managerUserId: number;          // Branch Manager's integer User ID
  cashierUserId: number;          // Cashier/Accountant's integer User ID
  currentVaultCash: number;       // ভল্টের বর্তমান নগদ টাকা
  status?: 'ACTIVE' | 'INACTIVE'; // সক্রিয় বা নিষ্ক্রিয় অবস্থা
  createdAt: string;
  history: EditHistoryEntry[];
}

export interface CenterOrSamity extends SoftDeletable {
  centerId: number;               // Integer ID, e.g. 101, 102
  centerCode: string;             // e.g. "CEN-01"
  name: string;                   // "শাপলা মহিলা সমিতি" বা "রুট-১"
  branchId: number;               // Foreign Key -> Branch.branchId
  fieldOfficerUserId: number;     // Foreign Key -> User.userId (দায়িত্বপ্রাপ্ত মাঠকর্মী)
  meetingDay: 'Saturday' | 'Sunday' | 'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Daily';
  meetingTime: string;            // "10:30 AM"
  location: string;               // "ওয়ার্ড ৪, মাস্টারপাড়া"
  totalMembers: number;
  activeLoansCount: number;
  status?: 'ACTIVE' | 'INACTIVE'; // সক্রিয় বা নিষ্ক্রিয় অবস্থা
  createdAt: string;
  history: EditHistoryEntry[];
}

// ==========================================
// 3. STAFF & EMPLOYEE (ব্যবহারকারী ও পদবী)
// ==========================================

export type UserCategory = 'SYSTEM_ADMIN' | 'HEAD_OFFICE' | 'BRANCH_STAFF';

export type StaffRole = 
  | 'SUPER_ADMIN' 
  | 'ADMIN'
  | 'MANAGING_DIRECTOR' 
  | 'REGIONAL_MANAGER' 
  | 'AREA_MANAGER' 
  | 'CENTRAL_AUDITOR'
  | 'BRANCH_MANAGER' 
  | 'FIELD_OFFICER' 
  | 'CASHIER' 
  | 'AUDITOR'
  | string;

export interface Role extends SoftDeletable {
  roleId: number;                 // Integer ID, e.g. 1, 2, 3
  code: string;                   // Unique uppercase code e.g. 'SUPER_ADMIN', 'FIELD_OFFICER'
  nameBn: string;                 // "মাঠকর্মী (Field Officer)"
  nameEn: string;                 // "Field Officer (FO)"
  category: UserCategory;         // 'SYSTEM_ADMIN' | 'HEAD_OFFICE' | 'BRANCH_STAFF'
  description?: string;           // পদবীর কাজের সংক্ষিপ্ত বিবরণ
  permissions: string[];          // অধিকারসমূহের কোড তালিকা
  isSystem: boolean;              // সিস্টেমের মূল পদবী কি না
  status: 'ACTIVE' | 'INACTIVE';  // সক্রিয় বা নিষ্ক্রিয় অবস্থা
  createdAt: string;
  history: EditHistoryEntry[];
}

export interface PermissionDefinition {
  key: string;
  labelBn: string;
  labelEn: string;
  category: 'LOANS' | 'COLLECTIONS' | 'ORGANIZATION' | 'USERS' | 'ACCOUNTING';
  descriptionBn: string;
}

export const SYSTEM_PERMISSIONS: PermissionDefinition[] = [
  { key: 'DASHBOARD_ACCESS', labelBn: 'ড্যাশবোর্ড দর্শন', labelEn: 'Dashboard Access', category: 'USERS', descriptionBn: 'ড্যাশবোর্ড সারসংক্ষেপ ও পরিসংখ্যান দেখার অনুমতি' },
  { key: 'VIEW_CUSTOMERS', labelBn: 'গ্রাহক তথ্য দর্শন', labelEn: 'View Customers', category: 'ORGANIZATION', descriptionBn: 'সকল গ্রাহক ও সমিতির তালিকা দেখা' },
  { key: 'MANAGE_CUSTOMERS', labelBn: 'গ্রাহক নিবন্ধন ও এডিট', labelEn: 'Manage Customers', category: 'ORGANIZATION', descriptionBn: 'নতুন গ্রাহক যোগ ও প্রোফাইল এডিট' },
  { key: 'MANAGE_LOANS', labelBn: 'ঋণের আবেদন তৈরি', labelEn: 'Apply Loans', category: 'LOANS', descriptionBn: 'নতুন ঋণের প্রস্তাবনা দাখিল' },
  { key: 'APPROVE_LOANS', labelBn: 'ঋণ অনুমোদন ও বিতরণ', labelEn: 'Approve & Disburse Loans', category: 'LOANS', descriptionBn: 'ঋণ আবেদন মঞ্জুর এবং ঋণ বিতরণ নিশ্চিতকরণ' },
  { key: 'COLLECT_KISTI', labelBn: 'কিস্তি আদায় ও রসিদ', labelEn: 'Collect Installments', category: 'COLLECTIONS', descriptionBn: 'মাঠ থেকে দৈনিক কিস্তি গ্রহণ ও ডিজিটাল রসিদ ইস্যু' },
  { key: 'VERIFY_CASH', labelBn: 'ক্যাশ ক্লোজিং ও হিসাবরক্ষণ', labelEn: 'Verify Cash Closing', category: 'ACCOUNTING', descriptionBn: 'দিনশেষে মাঠকর্মীর নগদ টাকা জমা গ্রহণ ও ভল্ট ক্লোজিং' },
  { key: 'MANAGE_BRANCHES', labelBn: 'শাখা ও রুট ব্যবস্থাপনা', labelEn: 'Manage Branches & Routes', category: 'ORGANIZATION', descriptionBn: 'নতুন শাখা ও সমিতি/রুট তৈরি ও এডিট' },
  { key: 'MANAGE_STAFF', labelBn: 'কর্মী ব্যবস্থাপনা', labelEn: 'Manage Staff', category: 'USERS', descriptionBn: 'নতুন কর্মী তৈরি, এডিট ও আইডি কার্ড প্রিন্ট' },
  { key: 'MANAGE_ROLES', labelBn: 'পদবী ও রোল নিয়ন্ত্রণ', labelEn: 'Manage Roles & Permissions', category: 'USERS', descriptionBn: 'নতুন রোল বা পদবী তৈরি ও পারমিশন কনফিগারেশন' }
];

export interface UserStaff extends SoftDeletable {
  userId: number;                 // Integer ID, e.g. 1, 501, 502
  firebaseAuthUid: string;        // Firebase Auth UID link
  name: string;                   // "কামরুল ইসলাম"
  phone: string;                  // "017XXXXXXXX"
  email: string;
  role: StaffRole;
  category: UserCategory;         // 'SYSTEM_ADMIN' | 'HEAD_OFFICE' | 'BRANCH_STAFF'
  branchId: number;               // 0 for System Admin & Head Office, 1..N for Field Branches
  branchName?: string;            // "প্রধান কার্যালয় (হেড অফিস)" বা "মিরপুর শাখা"
  assignedCenterIds: number[];    // Array of Center IDs assigned to this FO (only branch staff)
  assignedBranchIds?: number[];   // এরিয়া/রিজিওনাল ম্যানেজারের তদারকিভুক্ত শাখাসমূহ (only AREA_MANAGER / REGIONAL_MANAGER)
  nidNumber: string;
  salary: number;
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  joinedDate: string;
  history: EditHistoryEntry[];
}

// ==========================================
// 4. CUSTOMER / MEMBER (গ্রাহক / সদস্য)
// ==========================================

export interface CustomerGuarantor {
  name: string;                   // জামিনদারের নাম
  relation: string;               // সম্পর্ক (ভাই, স্বামী, ইত্যাদি)
  phone: string;
  nidNumber: string;              // জামিনদারের NID
  address: string;
  occupation: string;
  photoUrl?: string;
}

export interface CustomerCollateral {
  hasBankCheque: boolean;         // ব্যাংক চেক জমা আছে কি না
  bankName?: string;              // ব্যাংকের নাম
  bankBranch?: string;
  accountNumber?: string;
  chequeNumber?: string;          // চেক নম্বর
  hasStamp: boolean;              // ৩০০ টাকার স্ট্যাম্প আছে কি না
  stampNumber?: string;
  otherMortgageDetails?: string;  // দলিল/অন্যান্য বন্ধকি সামগ্রী
}

export interface Customer extends SoftDeletable {
  customerId: number;             // Integer ID, e.g. 10001, 10002
  customerCode: string;           // e.g. "CUST-10001"
  branchId: number;               // Foreign Key -> Branch.branchId
  centerId: number;               // Foreign Key -> CenterOrSamity.centerId
  assignedFieldOfficerId: number; // Foreign Key -> UserStaff.userId
  
  // ব্যক্তিগত তথ্য
  fullName: string;               // "রহিমা খাতুন"
  fatherName: string;
  motherName: string;
  spouseName?: string;
  dateOfBirth: string;
  gender: 'MALE' | 'FEMALE' | 'OTHER';
  phonePrimary: string;
  phoneSecondary?: string;
  nidNumber: string;              // ১০ বা ১৭ ডিজিটের এনআইডি
  birthCertificateNo?: string;
  
  // ঠিকানা ও বাসস্থানের তথ্য
  presentAddress: {
    villageOrStreet: string;
    postOffice: string;
    thanaOrUpazila: string;
    district: string;
    houseOwnership: 'OWN' | 'RENTED' | 'FAMILY'; // নিজস্ব বাড়ি নাকি ভাড়া বাড়ি
  };
  permanentAddress: {
    villageOrStreet: string;
    postOffice: string;
    thanaOrUpazila: string;
    district: string;
  };

  // আর্থিক ও পেশাগত তথ্য
  occupation: string;             // "মুদি দোকানদার"
  businessName?: string;          // "রহিমা স্টোর"
  monthlyIncome: number;
  
  // জামিনদার ও সিকিউরিটি
  primaryGuarantor: CustomerGuarantor;
  secondaryGuarantor?: CustomerGuarantor;
  collateral: CustomerCollateral;
  
  // সঞ্চয় ও অ্যাকাউন্ট সামারি
  totalSavingsBalance: number;    // সঞ্চয় ব্যালেন্স
  totalLoansTaken: number;
  activeLoansCount: number;
  creditScore: 'GOOD' | 'AVERAGE' | 'RISKY' | 'BLACKLISTED';
  status?: 'ACTIVE' | 'INACTIVE' | 'CLOSED'; // গ্রাহক স্ট্যাটাস
  
  photoUrl?: string;
  nidFrontPhotoUrl?: string;
  nidBackPhotoUrl?: string;
  signaturePhotoUrl?: string;
  
  createdAt: string;
  history: EditHistoryEntry[];
}

// ==========================================
// 5. LOAN PRODUCT (ঋণের ধরন ও নিয়ম)
// ==========================================

export type InstallmentFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';

export interface LoanProduct extends SoftDeletable {
  productId: number;              // Integer ID, e.g. 1, 2, 3
  productName: string;            // "জাগরণ ক্ষুদ্রঋণ (সাপ্তাহিক কিস্তি)"
  frequency: InstallmentFrequency; // DAILY, WEEKLY, MONTHLY
  defaultInstallmentsCount: number; // e.g. 40 কিস্তি
  interestOrServiceChargeRate: number; // e.g. 10.0 (10% flat or declining)
  mandatorySavingsPerInstallment: number; // e.g. 50 বা 100 টাকা প্রতি কিস্তিতে বাধ্যতামূলক সঞ্চয়
  formAndProcessingFee: number;   // ফরম ফি / প্রসেসিং ফি
  insuranceFee: number;           // কল্যাণ তহবিল / বীমা ফি
  minAmount: number;              // 10000
  maxAmount: number;              // 100000
  isActive: boolean;
  history: EditHistoryEntry[];
}

// ==========================================
// 6. LOAN CONTRACT & ACCOUNT (ঋণ হিসাব)
// ==========================================

export type LoanStatus = 
  | 'APPLIED'         // আবেদনকৃত
  | 'FIELD_VERIFIED'  // মাঠকর্মী যাচাইকৃত
  | 'APPROVED'        // শাখা ব্যবস্থাপক অনুমোদিত
  | 'DISBURSED'       // টাকা বিতরণকৃত (চলমান)
  | 'OVERDUE'         // বকেয়া / খেলাপি
  | 'CLOSED'          // সম্পূর্ণ পরিশোধিত
  | 'DEFAULTED'       // কু-ঋণ / ক্ষতি
  | 'CANCELLED';      // বাতিল

export interface Loan extends SoftDeletable {
  loanId: number;                 // Integer ID, e.g. 20001, 20002
  loanAccountNo: string;          // "LN-20001"
  customerId: number;             // Foreign Key -> Customer.customerId
  customerName: string;
  branchId: number;               // Foreign Key -> Branch.branchId
  centerId: number;               // Foreign Key -> CenterOrSamity.centerId
  fieldOfficerUserId: number;     // Foreign Key -> UserStaff.userId
  productId: number;              // Foreign Key -> LoanProduct.productId
  
  // টাকার হিসাব (Financial Breakdown)
  principalAmount: number;        // বিতরণকৃত আসল ঋণ (যেমন: ২০,০০০ টাকা)
  interestOrServiceCharge: number;// সুদ/সার্ভিস চার্জ (যেমন: ৪,০০০ টাকা)
  totalRepayableAmount: number;   // মোট পরিশোধযোগ্য (যেমন: ২৪,০০০ টাকা)
  
  installmentFrequency: InstallmentFrequency; // WEEKLY
  totalInstallments: number;      // ৪০
  installmentAmount: number;      // প্রতি কিস্তির টাকা (যেমন: ৬০০ টাকা)
  savingsPerInstallment: number;  // প্রতি কিস্তির সাথে জমা সঞ্চয় (যেমন: ৫০ টাকা)
  
  formFeePaid: number;            // ফরম ফি
  insuranceFeePaid: number;       // বীমা ফি
  
  // রিয়েল-টাইম আদায় ও বকেয়ার স্ট্যাটাস
  totalPaidAmount: number;        // মোট আদায় হয়েছে
  totalPrincipalPaid: number;     // আসল কত আদায়
  totalProfitPaid: number;        // লাভ কত আদায়
  totalSavingsCollected: number;  // এই ঋণের সময় মোট কত সঞ্চয় জমা হয়েছে
  outstandingBalance: number;     // বর্তমান বাকি (২৪০০০ - আদায়)
  
  paidInstallmentsCount: number;  // কতটি কিস্তি পরিশোধিত
  remainingInstallmentsCount: number; // কতটি কিস্তি বাকি
  overdueAmount: number;          // বকেয়া জমে থাকা টাকা
  missedInstallmentsCount: number;// কিস্তি বাদ পড়েছে কয়টি
  
  // তারিখ ও অনুমোদন প্রবাহ
  applicationDate: string;
  approvedDate?: string;
  approvedByUserId?: number;      // Branch Manager User ID
  disbursementDate: string;
  firstInstallmentDueDate: string;
  expectedClosingDate: string;
  actualClosedDate?: string;
  
  purposeOfLoan: string;          // "ব্যবসা সম্প্রসারণ"
  status: LoanStatus;
  
  history: EditHistoryEntry[];
}

// ==========================================
// 7. INSTALLMENT SCHEDULE (প্রতিটি কিস্তির সময়সূচি)
// ==========================================

export type InstallmentStatus = 'PENDING' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'ADVANCE';

export interface InstallmentSchedule extends SoftDeletable {
  installmentId: number;          // Integer ID, e.g. 30001, 30002
  loanId: number;                 // Foreign Key -> Loan.loanId
  customerId: number;             // Foreign Key -> Customer.customerId
  branchId: number;
  centerId: number;
  fieldOfficerUserId: number;
  
  installmentNo: number;          // কিস্তি নম্বর (১ থেকে ৪০)
  dueDate: string;                // নির্ধারিত তারিখ (যেমন: "2026-03-28")
  
  expectedPrincipal: number;      // এই কিস্তিতে আসলের অংশ (যেমন: ৫০০ টাকা)
  expectedProfit: number;         // এই কিস্তিতে লাভের অংশ (যেমন: ১০০ টাকা)
  expectedSavings: number;        // এই কিস্তিতে সঞ্চয় (যেমন: ৫০ টাকা)
  expectedTotalAmount: number;    // মোট কিস্তি (যেমন: ৬৫০ টাকা)
  
  paidPrincipal: number;
  paidProfit: number;
  paidSavings: number;
  paidTotalAmount: number;
  
  status: InstallmentStatus;
  paidDate?: string;
  collectionReceiptId?: number;   // Foreign Key -> PaymentCollection.receiptId
  
  history: EditHistoryEntry[];
}

// ==========================================
// 8. PAYMENT & COLLECTION (মানি রসিদ ও মাঠের কিস্তি আদায়)
// ==========================================

export interface PaymentCollection extends SoftDeletable {
  receiptId: number;              // Integer Receipt ID, e.g. 40001, 40002
  receiptNumberManual?: string;   // মাঠের ম্যানুয়াল রসিদ বইয়ের নম্বর (যদি থাকে)
  loanId: number;                 // Foreign Key -> Loan.loanId
  customerId: number;             // Foreign Key -> Customer.customerId
  customerName: string;
  installmentId?: number;         // Foreign Key -> InstallmentSchedule.installmentId
  installmentNo: number;
  
  branchId: number;
  centerId: number;
  collectedByUserId: number;      // Field Officer User ID
  collectedByName: string;
  
  // টাকার বিস্তারিত বিভাজন
  principalAmountCollected: number;
  profitAmountCollected: number;
  savingsAmountCollected: number;
  fineAmountCollected: number;    // বকেয়া জরিমানা (যদি থাকে)
  totalAmountCollected: number;   // মোট আদায়
  
  paymentMethod: 'CASH' | 'BKASH' | 'NAGAD' | 'BANK';
  trxId?: string;                 // মোবাইল ব্যাংকিং TrxID (বিকাশ/নগদ হলে)
  collectionDate: string;         // তারিখ ও সময়
  
  // ক্যাশ ক্লোজিং ট্র্যাকিং (মাঠকর্মী থেকে শাখায় ক্যাশিয়ারের জমা)
  isHandedOverToBranch: boolean;  // মাঠকর্মী শাখায় টাকা বুঝিয়ে দিয়েছে কি না
  reconciliationId?: number;      // Foreign Key -> DailyReconciliation.reconciliationId
  reconciledAt?: string;
  reconciledByUserId?: number;    // Cashier User ID
  
  history: EditHistoryEntry[];
}

// ==========================================
// 9. DAILY RECONCILIATION (মাঠকর্মীর ক্যাশ ক্লোজিং ও ক্যাশিয়ার মিলানো)
// ==========================================

export interface DailyReconciliation extends SoftDeletable {
  reconciliationId: number;       // Integer ID, e.g. 50001, 50002
  date: string;                   // "2026-03-28"
  branchId: number;
  fieldOfficerUserId: number;     // কার হিসাব
  fieldOfficerName: string;
  
  // দিনের হিসাব
  targetCollectionAmount: number; // আজ আদায় হওয়ার কথা ছিল
  actualCashCollected: number;    // মাঠে বাস্তবে ক্যাশ কত উঠেছে
  shortageOrDeficitAmount: number;// কত টাকা ঘাটতি বা বকেয়া রইল
  totalReceiptsCount: number;     // কতজন সদস্যের কাছ থেকে টাকা উঠেছে
  
  // ক্যাশিয়ার গ্রহণ
  cashHandedOverAmount: number;   // মাঠকর্মী ক্যাশিয়ারকে কত নগদ বুঝিয়ে দিল
  cashierUserId: number;          // কোন ক্যাশিয়ার রিসিভ করল
  cashierStatus: 'PENDING' | 'ACCEPTED' | 'MISMATCH_DISCREPANCY';
  cashierNotes?: string;          // কোনো অমিল থাকলে নোট
  
  submittedAt: string;
  verifiedAt?: string;
  history: EditHistoryEntry[];
}

// ==========================================
// 10. SAVINGS TRANSACTIONS (সঞ্চয় জমা ও উত্তোলন লেনদেনের ইতিহাস)
// ==========================================

export type SavingsTransactionType = 
  | 'DEPOSIT'              // সঞ্চয় জমা (সরাসরি জমা)
  | 'WITHDRAW'             // সঞ্চয় কর্তন / উত্তোলন
  | 'KISTI_COLLECTION'     // কিস্তির সাথে সাপ্তাহিক সঞ্চয় জমা
  | 'ADJUSTMENT'           // সঞ্চয় স্থিতি সমন্বয় / সংশোধন
  | 'ACCOUNT_CLOSURE';     // হিসাব সমাপ্তি ও সঞ্চয় ফেরত

export interface SavingsTransaction extends SoftDeletable {
  transactionId: number;          // Integer ID, e.g. 60001
  customerId: number;             // Foreign Key -> Customer.customerId
  customerName: string;
  branchId: number;
  centerId: number;
  loanId?: number;                // Optional Foreign Key -> Loan.loanId (if from kisti)
  installmentNo?: number;         // Optional installment number
  type: SavingsTransactionType;
  amount: number;                 // Positive number (e.g. 200)
  isCredit: boolean;              // true if deposit (+), false if withdraw (-)
  previousBalance: number;        // পূর্বে কত ছিল
  newBalance: number;             // লেনদেনের পর বর্তমান স্থিতি
  paymentMethod: 'CASH' | 'BKASH' | 'NAGAD' | 'BANK';
  transactionDate: string;        // ISO timestamp
  performedByUserId: number;
  performedByName: string;
  performedByRole: string;
  reason: string;                 // যেমন: "সঞ্চয় উত্তোলন (-৳ ২০০)" বা "কিস্তি #১ সঞ্চয় জমা"
  receiptNo?: string;             // Optional receipt / voucher number
  history?: EditHistoryEntry[];
}

// ==========================================
// 11. SYSTEM COUNTERS (অটো-ইনক্রিমেন্ট ইন্টিজার আইডির জন্য)
// ==========================================

export interface SequenceCounter {
  entityName: string;             // 'customers' | 'loans' | 'installments' | 'receipts' | 'branches' | 'history' | 'savings'
  currentSequenceId: number;      // বর্তমান সর্বোচ্চ পূর্ণসংখ্যা
  updatedAt: string;
}
