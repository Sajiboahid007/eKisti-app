/**
 * ঋণ প্রবাহের ধাপভিত্তিক দায়িত্ব:
 * মাঠকর্মী সরেজমিনে যাচাই → শাখা ব্যবস্থাপক অনুমোদন → ক্যাশিয়ার ভল্ট থেকে টাকা দিয়ে বিতরণ।
 * অ্যাডমিন / সুপার অ্যাডমিন সব ধাপে প্রয়োজনে কাজ করতে পারেন।
 *
 * আলাদা ফাইলে রাখা হয়েছে যাতে AuthStateService (অ্যাপ চালুর সময় লোড হয়) পুরো
 * LoanLifecycleService / TxRunner ইঞ্জিন প্রাথমিক বান্ডেলে টেনে না আনে।
 */
export const LOAN_VERIFY_ROLES = ['FIELD_OFFICER', 'SUPER_ADMIN', 'ADMIN'];
export const LOAN_APPROVE_ROLES = ['BRANCH_MANAGER', 'SUPER_ADMIN', 'ADMIN', 'AREA_MANAGER', 'MANAGING_DIRECTOR'];
export const LOAN_DISBURSE_ROLES = ['CASHIER', 'SUPER_ADMIN', 'ADMIN'];
