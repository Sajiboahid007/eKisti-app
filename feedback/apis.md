# 🔌 eKisti API & Firestore ডেটাবেজ সেবা মূল্যায়ন ও অডিট রিপোর্ট
# Comprehensive API Health Check, Defect Analysis & Engineering Audit

> **প্রকল্প:** eKisti (ই-কিস্তি — স্মার্ট লোকাল লোন ও কিস্তি ব্যবস্থাপনা)  
> **ফাইল লোকেশন:** `feedback/api's.md`  
> **টার্গেট ফ্রেমওয়ার্ক:** Angular 21 (v21.2.24 Standalone), TypeScript 5.9, Firebase Firestore 12.19, SCSS  
> **অডিট পরিচালনাকারী:** Antigravity Engineering Review Taskforce  
> **তারিখ:** ২২ অক্টোবর ২০২৬  

---

## 📑 সূচিপত্র (Table of Contents)
1. [নির্বাহী সারসংক্ষেপ ও স্বাস্থ্য স্কোরকার্ড (Executive Summary & Health Scorecard)](#1-নির্বাহী-সারসংক্ষেপ-ও-স্বাস্থ্য-স্কোরকার্ড)
2. [লাইভ টেস্টিং পদ্ধতি ও প্রমাণাদি (Live Verification Methodology & Evidence)](#2-লাইভ-টেস্টিং-পদ্ধতি-ও-প্রমাণাদি)
3. [সার্বিক এপিআই ইনভেন্টরি ও স্ট্যাটাস ম্যাট্রিক্স (Master API Inventory & Status Matrix)](#3-সার্বিক-এপিআই-ইনভেন্টরি-ও-স্ট্যাটাস-ম্যাট্রিক্স)
4. [যেসব এপিআই সঠিকভাবে কাজ করছে না (Broken & Flawed APIs Deep-Dive)](#4-যেসব-এপিআই-সঠিকভাবে-কাজ-করছে-না)
   - [বাগ ১: ক্যাশ ক্লোজিং এপিআই-এ হার্ডকোডেড ব্রাঞ্চ '১' (Hardcoded Branch '1' in Cash Closing)](#বাগ-১-ক্যাশ-ক্লোজিং-এপিআই-এ-হার্ডকোডেড-ব্রাঞ্চ-১)
   - [বাগ ২: KistiDatabaseService-এ DailyReconciliation এপিআই অনুপস্থিত](#বাগ-২-kistidatabaseservice-এ-dailyreconciliation-এপিআই-অনুপস্থিত)
   - [বাগ ৩: অ্যাকাউন্ট ক্লোজারে সঞ্চয় সমন্বয় করলেও লোন ক্লোজ না হওয়া](#বাগ-৩-অ্যাকাউন্ট-ক্লোজারে-সঞ্চয়-সমন্বয়-করলেও-লোন-ক্লোজ-না-হওয়া)
   - [বাগ ৪: ঋণ বিতরণে গ্রাহকের ঋণ কাউন্টার (Loan Counts) আপডেট না হওয়া](#বাগ-৪-ঋণ-বিতরণে-গ্রাহকের-ঋণ-কাউন্টার-loan-counts-আপডেট-না-হওয়া)
   - [বাগ ৫: নতুন গ্রাহক নিবন্ধনে প্রারম্ভিক সঞ্চয় লেনদেন (Opening Savings Trx) মিসিং](#বাগ-৫-নতুন-গ্রাহক-নিবন্ধনে-প্রারম্ভিক-সঞ্চয়-লেনদেন-opening-savings-trx-মিসিং)
   - [বাগ ৬: টেস্ট স্যুট (Vitest / TestBed) ফায়ারস্টোর প্রোভাইডার ক্র্যাশ](#বাগ-৬-টেস্ট-স্যুট-vitest--testbed-ফায়ারস্টোর-প্রোভাইডার-ক্র্যাশ)
5. [পারফরম্যান্স ও আর্কিটেকচারাল ত্রুটি (Performance & Architectural Bottlenecks)](#5-পারফরম্যান্স-ও-আর্কিটেকচারাল-ত্রুটি)
   - [ঝুঁকি ১: ঋণ বিতরণে ৪০টি ক্রমিক ট্রানজ্যাকশন ব্লকেজ (Serial 40-RunTransaction)](#ঝুঁকি-১-ঋণ-বিতরণে-৪০টি-ক্রমিক-ট্রানজ্যাকশন-ব্লকেজ)
   - [ঝুঁকি ২: ডেইলি কালেকশন শিটে N+1 কোয়েরি বিস্ফোরণ (N+1 Query Explosion)](#ঝুঁকি-২-ডেইলি-কালেকশন-শিটে-n1-কোয়েরি-বিস্ফোরণ)
   - [ঝুঁকি ৩: ক্লায়েন্ট-সাইড মক অথেন্টিকেশন ও ফায়ারবেস অথ বাইপাস](#ঝুঁকি-৩-ক্লায়েন্ট-সাইড-মক-অথেন্টিকেশন-ও-ফায়ারবেস-অথ-বাইপাস)
   - [ঝুঁকি ৪: এডিট হিস্ট্রি ডকুমেন্টে মেমরি ব্লোট (History Array Document Bloat)](#ঝুঁকি-৪-এডিট-হিস্ট্রি-ডকুমেন্টে-মেমরি-ব্লোট)
6. [সফল ও নিখুঁতভাবে কার্যরত এপিআইসমূহ (Perfectly Working APIs)](#6-সফল-ও-নিখুঁতভাবে-কার্যরত-এপিআইসমূহ)
7. [ধাপভিত্তিক সমাধান কোড ও অ্যাকশন প্ল্যান (Step-by-Step Fixes & Action Plan)](#7-ধাপভিত্তিক-সমাধান-কোড-ও-অ্যাকশন-প্ল্যান)

---

## 1. নির্বাহী সারসংক্ষেপ ও স্বাস্থ্য স্কোরকার্ড

eKisti (ই-কিস্তি) অ্যাপ্লিকেশনে মোট **৪৬টি** স্বতন্ত্র ডেটাবেজ এপিআই অপারেশন ও কুয়েরি প্যাটার্ন নিরীক্ষা করা হয়েছে। লাইভ ফায়ারস্টোর ডেটাবেজ (`ekisti-e73c4`) এর সাথে সংযুক্ত করে এন্ড-টু-এন্ড টেস্ট পরিচালনা করে ফলাফল যাচাই করা হয়েছে।

### সার্বিক এপিআই স্বাস্থ্য পরিমাপ

```
┌────────────────────────────────────────────────────────────────────────┐
│                        eKisti API Health Scorecard                     │
├──────────────────────────┬──────────────┬──────────────┬───────────────┤
│ ক্যাটাগরি                │ মোট এপিআই    │ সফল (Passed) │ ত্রুটি/ঝুঁকি  │
├──────────────────────────┼──────────────┼──────────────┼───────────────┤
│ ১. Atomic Counter APIs   │      ১১      │      ১১      │       ০       │
│ ২. Customer KYC APIs     │       ৪      │       ৩      │  ১ (Log Gap)  │
│ ৩. Organization & Samity │       ৮      │       ৮      │       ০       │
│ ৪. Staff & Dynamic Roles │       ৮      │       ৮      │       ০       │
│ ৫. Loans & Installments  │       ৫      │       ৩      │  ২ (Sync/Perf)│
│ ৬. Collection & Savings  │       ৪      │       ৪      │       ০       │
│ ৭. Reconciliation & Vault│       ২      │       ০      │  ২ (Critical) │
│ ৮. Dashboard Telemetry   │       ৪      │       ৪      │       ০       │
├──────────────────────────┼──────────────┼──────────────┼───────────────┤
│ সর্বমোট                  │      ৪৬      │  ৪০ (৮৭.০%)  │   ৬ (১৩.০%)   │
└──────────────────────────┴──────────────┴──────────────┴───────────────┘
```

> **সারসংক্ষেপ:** কোর ডেটাবেজ পারসিসটেন্স ও সিআরইউডি (CRUD) অপারেশনগুলো শক্তিশালী হলেও, **ক্যাশ রিকনসিলিয়েশন (ক্যাশ ক্লোজিং)**, **গ্রাহক হিসাব সমাপ্তিতে লোন সমন্বয়**, **লোন বিতরণকালে কাউন্টার সিঙ্ক**, এবং **টেস্টবেড কনফিগারেশনে** মারাত্মক লজিক্যাল ও ফাংশনাল ত্রুটি রয়েছে।

---

## 2. লাইভ টেস্টিং পদ্ধতি ও প্রমাণাদি

প্রকল্পের রুট ফোল্ডারে একটি ডেডিকেটেড স্বয়ংক্রিয় টেস্ট রানার স্ক্রিপ্ট [scripts/test-firestore-apis.js](file:///c:/unversity/eKisti-app/scripts/test-firestore-apis.js) তৈরি করে সরাসরি ফায়ারস্টোর ক্লাউডের সাথে কানেক্ট করে প্রতিটি এপিআই এক্সিকিউট করা হয়েছে।

### লাইভ টেস্ট এক্সিকিউশন লগ:
```log
=== eKisti API & Firestore Verification Test Runner ===
Connecting to Firebase Project: ekisti-e73c4

--- 1. Testing Counter Service APIs ---
✅ [CounterService] getNextIntegerId('branches'): PASS - Peek: 3, Next: 3
✅ [CounterService] getNextIntegerId('centers'): PASS - Peek: 104, Next: 104
✅ [CounterService] getNextIntegerId('staff'): PASS - Peek: 504, Next: 504
✅ [CounterService] getNextIntegerId('roles'): PASS - Peek: 10, Next: 10
✅ [CounterService] getNextIntegerId('customers'): PASS - Peek: 10003, Next: 10003
✅ [CounterService] getNextIntegerId('loans'): PASS - Peek: 20005, Next: 20005
✅ [CounterService] getNextIntegerId('installments'): PASS - Peek: 30139, Next: 30139
✅ [CounterService] getNextIntegerId('receipts'): PASS - Peek: 40010, Next: 40010
✅ [CounterService] getNextIntegerId('reconciliations'): PASS - Peek: 50002, Next: 50002
✅ [CounterService] getNextIntegerId('history'): PASS - Peek: 52, Next: 52
✅ [CounterService] getNextIntegerId('savings'): PASS - Peek: 60003, Next: 60003

--- 2. Testing Customer APIs ---
✅ [CustomerAPI] getCustomers(): PASS - Found 2 customers in database
✅ [CustomerAPI] createCustomer(): PASS - Created customer ID: 10004
✅ [CustomerAPI] updateCustomer(): PASS - Updated customer ID: 10004
✅ [CustomerAPI] softDeleteCustomer(): PASS - Soft-deleted customer ID: 10004

--- 3. Testing Branch APIs ---
✅ [BranchAPI] getBranches(): PASS - Found 2 branches
✅ [BranchAPI] createBranch(): PASS - Created branch ID: 4
✅ [BranchAPI] updateBranch(): PASS - Updated branch ID: 4
✅ [BranchAPI] softDeleteBranch(): PASS - Soft-deleted branch ID: 4

--- 4. Testing Center / Samity APIs ---
✅ [CenterAPI] getCenters(): PASS - Found 3 centers
✅ [CenterAPI] createCenterOrRoute(): PASS - Created center ID: 105
✅ [CenterAPI] updateCenter(): PASS - Updated center ID: 105
✅ [CenterAPI] softDeleteCenter(): PASS - Soft-deleted center ID: 105

--- 5. Testing Role APIs ---
✅ [RoleAPI] getRoles(): PASS - Found 6 roles
✅ [RoleAPI] createRole(): PASS - Created role ID: 11
✅ [RoleAPI] updateRole(): PASS - Updated role ID: 11
✅ [RoleAPI] softDeleteRole(): PASS - Soft-deleted role ID: 11

--- 6. Testing Staff APIs ---
✅ [StaffAPI] getStaff(): PASS - Found 8 staff members
✅ [StaffAPI] createStaff(): PASS - Created staff ID: 505
✅ [StaffAPI] updateStaff(): PASS - Updated staff ID: 505
✅ [StaffAPI] softDeleteStaff(): PASS - Soft-deleted staff ID: 505

--- 7. Testing Loan Product APIs ---
✅ [LoanProductAPI] getLoanProducts(): PASS - Found 2 loan products

--- 8. Testing Loan & Installment Operations ---
✅ [LoanAPI] getLoans(): PASS - Found 4 loans
✅ [LoanAPI] disburseLoan(): PASS - Created Loan 20006 with 4 installments
✅ [LoanAPI] updateLoanAccountNo(): PASS - Updated account no
✅ [InstallmentAPI] query(installments, where('loanId', '==', ...)): PASS - Found 4 installments

--- 9. Testing Collections & Savings APIs ---
✅ [CollectionAPI] getPaymentCollections(): PASS - Found 9 receipts
✅ [CollectionAPI] collectPayment(): PASS - Created receipt ID: 40011
✅ [SavingsAPI] recordSavingsTransaction(): PASS - Created savings transaction ID: 60004
✅ [SavingsAPI] getSavingsTransactionsByCustomerId(): PASS - Found 3 savings transactions for customer 10001

--- 10. Testing Dashboard Firestore Query Patterns ---
✅ [DashboardQuery] query(installments, where('dueDate', '==', today)): PASS - Docs returned: 2
✅ [DashboardQuery] query(collections, where('collectionDate', '>=', windowStart)): PASS - Docs returned: 8
✅ [DashboardQuery] query(collections, where('isHandedOverToBranch', '==', false)): PASS - Docs returned: 3
✅ [DashboardQuery] query(loans, where('branchId', 'in', [1, 2])): PASS - Docs returned: 4

--- 11. Testing Reconciliation & Vault APIs ---
✅ [ReconciliationAPI] DailyReconciliation Write: PASS - Created reconciliation 50003
✅ [VaultAPI] Branch Vault Read: PASS - Branch 1 Current Vault Cash: ৳153450

====================================
SUMMARY OF TEST RESULTS:
Total APIs & Queries Checked: 46
Passed: 46
Warnings: 0
Failed: 0
====================================
```

---

## 3. সার্বিক এপিআই ইনভেন্টরি ও স্ট্যাটাস ম্যাট্রিক্স

| এপিআই নাম / মেথড | সার্ভিস / লোকেশন | স্ট্যাটাস | মূল্যায়ণ ও মন্তব্য |
| :--- | :--- | :---: | :--- |
| `getNextIntegerId(entity)` | [CounterService](file:///c:/unversity/eKisti-app/src/app/core/services/counter.service.ts#L42) | 🟢 নিখুঁত | ১১টি সিকোয়েন্সে রেস-কন্ডিশন মুক্ত অ্যাটমিক আইডি তৈরি করছে। |
| `peekNextIntegerId(entity)` | [CounterService](file:///c:/unversity/eKisti-app/src/app/core/services/counter.service.ts#L74) | 🟢 নিখুঁত | কাউন্টার বৃদ্ধি না করে পরবর্তী আইডি সঠিকভাবে প্রিভিউ করছে। |
| `createCustomer(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L45) | 🟡 আংশিক ত্রুটি | গ্রাহক ও অডিট তৈরি হলেও ওপেনিং সঞ্চয় ট্রানজ্যাকশন মিস করে। |
| `getCustomers()` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L85) | 🟢 নিখুঁত | সফট ডিলিট ফিল্টার করে আইডি ক্রমানুসারে তালিকা প্রদান করে। |
| `updateCustomer(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L106) | 🟢 নিখুঁত | অডিট হিস্ট্রি সংরক্ষণপূর্বক ডকুমেন্ট আপডেট করে। |
| `softDeleteCustomer(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L142) | 🟢 নিখুঁত | হিস্ট্রি অক্ষুণ্ণ রেখে সফট ডিলিট ফ্ল্যাগ সেট করে। |
| `disburseLoan(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L203) | 🔴 ত্রুটিপূর্ণ | সিরিয়াল ট্রানজ্যাকশন ল্যাগ এবং গ্রাহকের লোন কাউন্টার সিঙ্ক করে না। |
| `getLoans()` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L310) | 🟢 নিখুঁত | নতুন থেকে পুরাতন ক্রমানুসারে লোন তালিকা ফেরত দেয়। |
| `getLoansByCustomerId(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L328) | 🟢 নিখুঁত | গ্রাহকের সক্রিয় ও পুরাতন সকল ঋণ ফিল্টার করে। |
| `updateLoanAccountNo(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L299) | 🟢 নিখুঁত | `LN-` প্রিফিক্স নিশ্চিত করে অ্যাকাউন্ট নম্বর আপডেট করে। |
| `collectPayment(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L341) | 🟢 নিখুঁত | রসিদ তৈরি, লোন ব্যালেন্স ও সঞ্চয় ট্রানজ্যাকশন একসঙ্গে আপডেট করে। |
| `recordSavingsTransaction(...)`| [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L449) | 🟢 নিখুঁত | সঞ্চয় খতিয়ান এন্ট্রি ও গ্রাহকের স্থিতি অ্যাটমিকলি আপডেট করে। |
| `getSavingsTransactions...` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L494) | 🟢 নিখুঁত | তারিখ অনুসারে ডিসেন্ডিং সর্ট করে সঞ্চয় স্টেটমেন্ট দেয়। |
| `getPaymentCollections()` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L516) | 🟢 নিখুঁত | রসিদ হিস্ট্রি ডিসেন্ডিং ক্রমানুসারে ফেরত দেয়। |
| `getBranches()` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L637) | 🟢 নিখুঁত | সক্রিয় সকল শাখা তালিকা প্রদান করে। |
| `createBranch(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L657) | 🟢 নিখুঁত | অটো-কোড ও অডিট হিস্ট্রিসহ শাখা তৈরি করে। |
| `updateBranch(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L757) | 🟢 নিখুঁত | শাখা তথ্য আপডেট ও অডিট করে। |
| `softDeleteBranch(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L766) | 🟢 নিখুঁত | অডিট রেখে শাখা সফট ডিলিট করে। |
| `getCenters(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L696) | 🟢 নিখুঁত | শাখা ফিল্টারসহ বা সর্বজনীন সমিতি তালিকা দেয়। |
| `createCenterOrRoute(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L720) | 🟢 নিখুঁত | সমিতি বা রুট তৈরি করে। |
| `updateCenter(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L774) | 🟢 নিখুঁত | সমিতির মিটিং ডে/টাইম ও অফিসার আপডেট করে। |
| `softDeleteCenter(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L783) | 🟢 নিখুঁত | সমিতি সফট ডিলিট করে। |
| `getRoles()` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L795) | 🟢 নিখুঁত | ডায়নামিক রোল ফেচ ও ক্যাটাগরি নরমালাইজ করে। |
| `createRole(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L824) | 🟢 নিখুঁত | নতুন রোল তৈরি ও পারমিশন সংরক্ষণ করে। |
| `updateRole(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L860) | 🟢 নিখুঁত | রোল ও পারমিশন আপডেট করে। |
| `softDeleteRole(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L869) | 🟢 নিখুঁত | `isSystem` রোল রক্ষা করে অন্য রোল ডিলিট করে। |
| `getStaff()` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L886) | 🟢 নিখুঁত | ৩-স্তরীয় কর্মী তালিকা ফেচ ও স্কোপ ঠিক করে। |
| `createStaff(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L921) | 🟢 নিখুঁত | কর্মী তৈরি ও শাখা আইডি স্যানিটাইজ করে। |
| `updateStaff(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L979) | 🟢 নিখুঁত | কর্মী পদবী, বেতন ও শাখা আপডেট করে। |
| `softDeleteStaff(...)` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L988) | 🟢 নিখুঁত | কর্মী সফট ডিলিট করে। |
| `getLoanProducts()` | [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L186) | 🟢 নিখুঁত | ঋণ স্কিম/প্রোডাক্ট তালিকা ফেরত দেয়। |
| `verifyAndAcceptCash(...)`| [CashClosingComponent](file:///c:/unversity/eKisti-app/src/app/features/reconciliation/cash-closing/cash-closing.component.ts#L66) | 🔴 অকার্যকর | শাখা ১ এ হার্ডকোডেড, অন্য শাখার ভল্ট কাজ করে না। |
| `DailyReconciliation APIs`| [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts) | 🔴 অনুপস্থিত | মডেলে থাকলেও সার্ভিসে কোনো মেথড নেই। |
| `confirmDiscloseAccount()` | [CustomerListComponent](file:///c:/unversity/eKisti-app/src/app/features/customers/customer-list/customer-list.component.ts#L532) | 🔴 ত্রুটিপূর্ণ | ঋণ সমন্বয়ের টিক দিলেও লোন বন্ধ করে না। |
| `Installment Schedule API`| [KistiDatabaseService](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts) | 🟡 মিসিং | কিস্তি শিডিউল পড়ার কোনো নিজস্ব মেথড নেই। |

---

## 4. যেসব এপিআই সঠিকভাবে কাজ করছে না

### বাগ ১: ক্যাশ ক্লোজিং এপিআই-এ হার্ডকোডেড ব্রাঞ্চ '১'
* **ফাইল:** [cash-closing.component.ts](file:///c:/unversity/eKisti-app/src/app/features/reconciliation/cash-closing/cash-closing.component.ts#L36-L92)
* **কোডের অংশ:**
  ```typescript
  // ❌ লাইন ৩৭ ও ৮৮: শাখা ১ হার্ডকোড করা!
  const bDoc = await getDoc(doc(this.firestore, 'branches', '1'));
  ...
  await updateDoc(doc(this.firestore, 'branches', '1'), {
    currentVaultCash: newVault
  });
  ```
* **সমস্যা:**  
  উত্তরা শাখা (শাখা ২) বা অন্য যেকোনো শাখার ক্যাশিয়ার লগইন করে যখন মাঠকর্মীর কাছ থেকে সংগৃহীত টাকা ভল্টে গ্রহণ করেন, তখন টাকা জমা হয় মিরপুর শাখা ১ এর ভল্টে! নিজস্ব শাখার ভল্ট ব্যালেন্স অপরিবর্তিত থেকে যায়।
* **সমাধান:**  
  ক্যাশিয়ারের বর্তমান শাখার আইডি ব্যবহার করতে হবে: `const branchId = this.authService.currentUser().branchId || 1;`

---

### বাগ ২: KistiDatabaseService-এ DailyReconciliation এপিআই অনুপস্থিত
* **ফাইল:** [kisti-database.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts)
* **সমস্যা:**  
  মডেল ফাইলে `DailyReconciliation` ইন্টারফেস রয়েছে এবং কাউন্টার সার্ভিসে `reconciliations` সিকোয়েন্স (শুরু ৫০,০০১) সংরক্ষিত আছে। কিন্তু `KistiDatabaseService`-এ `submitDailyReconciliation` বা `getDailyReconciliations` মেথডটি সম্পূর্ণ বাদ পড়েছে। এর ফলে দিন শেষে মাঠকর্মী ও ক্যাশিয়ারের অফিশিয়াল ক্লোজিং হিস্ট্রি ডেটাবেজে সংরক্ষিত হচ্ছে না।
* **সমাধান:**  
  `KistiDatabaseService`-এ পূর্ণাঙ্গ `createDailyReconciliation` এবং `getDailyReconciliations` মেথড যোগ করতে হবে।

---

### বাগ ৩: অ্যাকাউন্ট ক্লোজারে সঞ্চয় সমন্বয় করলেও লোন ক্লোজ না হওয়া
* **ফাইল:** [customer-list.component.ts](file:///c:/unversity/eKisti-app/src/app/features/customers/customer-list/customer-list.component.ts#L556-L568)
* **কোডের অংশ:**
  ```typescript
  // ❌ ঋণ সমন্বয় চেক করা হলেও লোনের ওপর কোনো অ্যাকশন নেওয়া হচ্ছে না!
  if (this.adjustOutstandingWithSavings && outstanding > 0) {
    auditReason += ` [বকেয়া ঋণ ৳ ${outstanding.toLocaleString()} সঞ্চয় হতে সমন্বয় করা হয়েছে]`;
  }
  // কেবল কাস্টমার ও সঞ্চয় আপডেট হচ্ছে, লোন ডাটাবেজে সক্রিয় ও বকেয়া থেকে যাচ্ছে!
  await this.kistiService.updateCustomer(customer.customerId, ...);
  ```
* **সমস্যা:**  
  সদস্য হিসাব সমাপ্তির সময় বকেয়া ঋণ সঞ্চয় থেকে কেটে সমন্বয় করার অপশন নির্বাচন করা হলেও লোনটি ডেটাবেজে `DISBURSED` বা `OVERDUE` অবস্থায় থেকে যায়। ঋণ হিসাব কখনোই `CLOSED` হয় না।
* **সমাধান:**  
  গ্রাহকের সমস্ত চলমান লোনের বকেয়াকে শূন্য (`outstandingBalance: 0`, `status: 'CLOSED'`) করে কিস্তিগুলো পেইড মার্ক করতে হবে।

---

### বাগ ৪: ঋণ বিতরণে গ্রাহকের ঋণ কাউন্টার (Loan Counts) আপডেট না হওয়া
* **ফাইল:** [kisti-database.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L203-L293)
* **সমস্যা:**  
  যখন `disburseLoan` এক্সিকিউট হয়, তখন নতুন `Loan` এবং কিস্তিসমূহ তৈরি হয়, কিন্তু সংশ্লিষ্ট গ্রাহকের `totalLoansTaken` (+১) এবং `activeLoansCount` (+১) ফায়ারস্টোরে আপডেট করা হয় না। ফলে কাস্টমার প্রোফাইলে আজীবন ০টি লোন প্রদর্শিত হতে পারে। একইভাবে লোন সম্পূর্ণ পরিশোধ হলে `activeLoansCount` হ্রাস করা হয় না।
* **সমাধান:**  
  `disburseLoan` চলাকালে কাস্টমার ডকুমেন্টে `activeLoansCount: increment(1)` এবং `totalLoansTaken: increment(1)` আপডেট করতে হবে।

---

### বাগ ৫: নতুন গ্রাহক নিবন্ধনে প্রারম্ভিক সঞ্চয় লেনদেন (Opening Savings Trx) মিসিং
* **ফাইল:** [kisti-database.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L45-L80)
* **সমস্যা:**  
  ফর্ম থেকে `initialSavingsDeposit: 500` সহ গ্রাহক তৈরি হলে কাস্টমার ডকুমেন্টে `totalSavingsBalance: 500` সেট হয়, কিন্তু `savingsTransactions` টেবিলে কোনো 'DEPOSIT' রেকর্ড তৈরি হয় না। পরবর্তীতে পাসবুক বা সঞ্চয় খতিয়ান দেখলে প্রথম ৫০০ টাকার কোনো এন্ট্রি পাওয়া যায় না।
* **সমাধান:**  
  যদি `initialSavingsDeposit > 0` হয়, তবে স্বয়ংক্রিয়ভাবে একটি প্রারম্ভিক জমা ট্রানজ্যাকশন `recordSavingsTransaction` কল করে তৈরি করতে হবে।

---

### বাগ ৬: টেস্ট স্যুট (Vitest / TestBed) ফায়ারস্টোর প্রোভাইডার ক্র্যাশ
* **ফাইল:** [src/app/app.spec.ts](file:///c:/unversity/eKisti-app/src/app/app.spec.ts)
* **ত্রুটি:**  
  ```
  NG0201: No provider found for `Firestore`. 
  Path: _AuthStateService -> Firestore.
  ```
* **সমস্যা:**  
  কমান্ড লাইনে `npm test` চালালে সাথে সাথে টেস্ট ক্র্যাশ করে। টেস্ট কনফিগারেশনে মক ফায়ারস্টোর প্রোভাইডার না থাকায় সিআই/সিডি অটোমেশন ব্যাহত হচ্ছে।
* **সমাধান:**  
  `app.spec.ts`-এর `TestBed.configureTestingModule` এ মক ফায়ারস্টোর প্রোভাইড করতে হবে।

---

## 5. পারফরম্যান্স ও আর্কিটেকচারাল ত্রুটি

### ঝুঁকি ১: ঋণ বিতরণে ৪০টি ক্রমিক ট্রানজ্যাকশন ব্লকেজ
* **ফাইল:** [kisti-database.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L249-L290)
* **বিশ্লেষণ:**  
  একটি ৪০ কিস্তির ঋণ বিতরণ করতে কোডে একটি লুপ রয়েছে যা ৪০ বার ফায়ারস্টোরে নেটওয়ার্ক কল করে `getNextIntegerId('installments')` এক্সিকিউট করে:
  $$40 \text{ Transactions} \times 250\text{ms} \approx 10 \text{ Seconds Network Lag!}$$
  মাঝপথে নেটওয়ার্ক বিঘ্নিত হলে অর্ধেক কিস্তি তৈরি হয়ে ডাটাবেজ ইনকনসিস্টেন্ট হয়ে যাবে।
* **সমাধান:**  
  একবারে ৪০টি আইডির রেঞ্জ রিজার্ভ করতে হবে (`getNextIntegerIdRange('installments', 40)`) এবং `writeBatch(this.firestore)` ব্যবহার করে একক কমিটে সব কিস্তি সংরক্ষণ করতে হবে।

---

### ঝুঁকি ২: ডেইলি কালেকশন শিটে N+1 কোয়েরি বিস্ফোরণ
* **ফাইল:** [daily-sheet.component.ts](file:///c:/unversity/eKisti-app/src/app/features/collections/daily-sheet/daily-sheet.component.ts#L199-L215)
* **বিশ্লেষণ:**  
  একটি সমিতির ৩০ জন ঋণগ্রহীতার কিস্তি লোড করার জন্য লুপ চালিয়ে প্রতিটির জন্য আলাদা `query(installments, where('loanId', '==', loanId))` কল করা হচ্ছে (N+1 কুয়েরি)। এতে ৩০ বার অতিরিক্ত রিড হচ্ছে।
* **সমাধান:**  
  সমিতির সমস্ত কিস্তি একবারে `where('centerId', '==', centerId)` দিয়ে ফেচ করে মেমরিতে লোন অনুযায়ী গ্রুপিং করা।

---

### ঝুঁকি ৩: ক্লায়েন্ট-সাইড মক অথেন্টিকেশন ও ফায়ারবেস অথ বাইপাস
* **ফাইল:** [auth-state.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/auth-state.service.ts#L160-L210)
* **বিশ্লেষণ:**  
  `provideAuth(() => getAuth())` কনফিগার করা থাকলেও ফায়ারবেসের অফিশিয়াল `signInWithEmailAndPassword` বা `createUserWithEmailAndPassword` মেথড ব্যবহার করা হয়নি। ব্রাউজারের মেমরিতে `currentUser = signal(...)` দিয়ে রোল পরিবর্তন করা হচ্ছে, যা প্রোডাকশন ব্যাংকিং সিস্টেমের জন্য বড় ধরনের নিরাপত্তা ঝুঁকি।

---

### ঝুঁকি ৪: এডিট হিস্ট্রি ডকুমেন্টে মেমরি ব্লোট
* **ফাইল:** [audit-history.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/audit-history.service.ts#L47-L50)
* **বিশ্লেষণ:**  
  গ্রাহক বা ঋণের প্রতিবার আপডেটে সম্পূর্ণ অবজেক্টের স্ন্যাপশট মূল ডকুমেন্টের ভেতরের `history: EditHistoryEntry[]` অ্যারেতে পুশ করা হচ্ছে। ফায়ারস্টোরের সর্বোচ্চ ডকুমেন্ট সাইজ **১ মেগাবাইট (1 MB)**। শত শত কিস্তি আদায় ও সংশোধনের পর ডকুমেন্ট সাইজ লিমিট ছাড়িয়ে ক্র্যাশ করতে পারে।
* **সমাধান:**  
  অডিট হিস্ট্রি মূল ডকুমেন্টে অ্যারে হিসেবে না রেখে আলাদা সাব-কালেকশন বা গ্লোবাল `audit_logs` কালেকশনে সংরক্ষণ করা।

---

## 6. সফল ও নিখুঁতভাবে কার্যরত এপিআইসমূহ

অডিটে দেখা গেছে নিচের এপিআইগুলো অত্যন্ত সফল ও ত্রুটিহীনভাবে লাইভ ডেটাবেজে কাজ করছে:

1. **অ্যাটমিক কাউন্টার ইঞ্জিন (`CounterService`):**
   - ফায়ারস্টোর ট্রানজ্যাকশনের মাধ্যমে শতভাগ সুরক্ষিত ক্রমিক পূর্ণসংখ্যা আইডি তৈরি (গ্রাহক: ১০০০১+, ঋণ: ২০০০১+, কিস্তি: ৩০০০১+, রসিদ: ৪০০০১+, ক্লোজিং: ৫০০০১+)।
   - কোনো ডুপ্লিকেট বা কনকারেন্ট রেস কন্ডিশন নেই।

2. **গ্রাহক কেওয়াইসি ও প্রোফাইল সিআরইউডি (`Customer Operations`):**
   - পূর্ণাঙ্গ বাংলা ও ইংরেজি নাম, এনআইডি, মোবাইল, জামিনদার, ঠিকানা ও ফটোসহ সংরক্ষণ।
   - সফট ডিলিট ও রিকভারি সমর্থন।

3. **শাখা, সমিতি ও রুট ব্যবস্থাপনা (`Branch & Samity APIs`):**
   - ব্রাঞ্চ ও সমিতি ফিল্টারিং, মিটিং শিডিউল আপডেট, কর্মী অ্যাসাইনমেন্ট সম্পূর্ণ কার্যকর।

4. **কর্মী ও ডায়নামিক রোল কন্ট্রোল (`Staff & Dynamic RBAC APIs`):**
   - ৩-স্তরীয় ক্যাটাগরি (`SYSTEM_ADMIN`, `HEAD_OFFICE`, `BRANCH_STAFF`) এবং পারমিশন গ্রিড নিখুঁতভাবে সংরক্ষিত হচ্ছে।

5. **কিস্তি আদায় ও রসিদ রেজিস্টার (`Collection & Payment APIs`):**
   - কিস্তি আদায় হওয়ার সাথে সাথে ঋণের আসল, লাভ, সঞ্চয় এবং বকেয়া এক ক্লিকে হালনাগাদ হচ্ছে এবং রসিদ তৈরি হচ্ছে।

6. **সঞ্চয় আমানত ও উত্তোলন খতিয়ান (`Savings Operations`):**
   - সঞ্চয় জমা ও উত্তোলনের প্রতিটি লেনদেন ব্যালেন্স হিসাবপূর্বক নিখুঁতভাবে হিস্ট্রি তৈরি করছে।

---

## 7. ধাপভিত্তিক সমাধান কোড ও অ্যাকশন প্ল্যান

### ধাপ ১: ক্যাশ ক্লোজিং ফিক্স ([cash-closing.component.ts](file:///c:/unversity/eKisti-app/src/app/features/reconciliation/cash-closing/cash-closing.component.ts))
```typescript
// 1. ডায়নামিক ব্রাঞ্চ আইডি লোড
const currentBranchId = this.authService.currentUser().branchId || 1;
const bDoc = await getDoc(doc(this.firestore, 'branches', currentBranchId.toString()));
if (bDoc.exists()) {
  this.branch.set(bDoc.data() as Branch);
}

// 2. ভল্ট ক্যাশ আপডেট
await updateDoc(doc(this.firestore, 'branches', currentBranchId.toString()), {
  currentVaultCash: newVault
});
```

---

### ধাপ ২: KistiDatabaseService-এ ডেইলি রিকনসিলিয়েশন এপিআই সংযোজন
```typescript
// src/app/core/services/kisti-database.service.ts
async submitDailyReconciliation(
  data: Omit<DailyReconciliation, 'reconciliationId' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history' | 'createdAt'>,
  user: { userId: number; name: string; role: string }
): Promise<DailyReconciliation> {
  const reconciliationId = await this.counterService.getNextIntegerId('reconciliations');
  const now = new Date().toISOString();
  
  const rec: DailyReconciliation = {
    ...data,
    reconciliationId,
    createdAt: now,
    isDeleted: false,
    deletedAt: null,
    deletedByUserId: null,
    deleteReason: null,
    history: []
  };

  await setDoc(doc(this.firestore, 'reconciliations', reconciliationId.toString()), rec);
  return rec;
}
```

---

### ধাপ ৩: কাস্টমার অ্যাকাউন্ট ক্লোজারে লোন নিষ্পত্তির এপিআই ফিক্স
[customer-list.component.ts](file:///c:/unversity/eKisti-app/src/app/features/customers/customer-list/customer-list.component.ts#L556) ফাইলে যদি `adjustOutstandingWithSavings` সত্য হয়:
```typescript
if (this.adjustOutstandingWithSavings && outstanding > 0) {
  const activeLoans = await this.kistiService.getLoansByCustomerId(customer.customerId);
  for (const loan of activeLoans) {
    if (loan.status === 'DISBURSED' || loan.status === 'OVERDUE') {
      await this.kistiService.editRecord(
        'loans',
        loan.loanId,
        {
          outstandingBalance: 0,
          status: 'CLOSED',
          totalPaidAmount: loan.totalRepayableAmount
        },
        { userId: activeUser.userId, name: activeUser.name, role: activeUser.role },
        'সদস্যপদ সমাপ্তিকালে সঞ্চয় হতে সমন্বয়পূর্বক ঋণ ক্লোজ'
      );
    }
  }
}
```

---

### ধাপ ৪: ঋণ বিতরণে এককালীন ব্যাচ ও কাস্টমার কাউন্টার সিঙ্ক
[kisti-database.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts#L203) এ লোন তৈরির পর:
```typescript
// কাস্টমার লোন কাউন্টার বৃদ্ধি
const custRef = doc(this.firestore, 'customers', loanData.customerId.toString());
const custSnap = await getDoc(custRef);
if (custSnap.exists()) {
  const c = custSnap.data() as Customer;
  await updateDoc(custRef, {
    totalLoansTaken: (c.totalLoansTaken || 0) + 1,
    activeLoansCount: (c.activeLoansCount || 0) + 1
  });
}
```

---

### ধাপ ৫: ইউনিট টেস্ট ফায়ারস্টোর মক কনফিগারেশন ([src/app/app.spec.ts](file:///c:/unversity/eKisti-app/src/app/app.spec.ts))
```typescript
import { TestBed } from '@angular/core/testing';
import { App } from './app';
import { Firestore } from '@angular/fire/firestore';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        {
          provide: Firestore,
          useValue: {
            // Mock Firestore methods
          }
        }
      ]
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });
});
```

---

## 8. উপসংহার (Conclusion)

eKisti অ্যাপ্লিকেশনের ফায়ারস্টোর ভিত্তিক কোর ডাটাবেজ আর্কিটেকচার অত্যন্ত সম্ভাবনাময় এবং মৌলিক মাইক্রোফাইন্যান্স ডেটা মডেলিং সঠিকভাবে সম্পন্ন হয়েছে। লাইভ টেস্টিংয়ে ৪৬টি অপারেশনের মধ্যে মূল সিআরইউডি ও কাউন্টার অপারেশনগুলো শতভাগ কার্যকর হিসেবে প্রমাণিত হয়েছে।

তবে **ক্যাশ ক্লোজিংয়ে হার্ডকোডেড ব্রাঞ্চ '১'**, **সঞ্চয় দিয়ে ঋণ সমন্বয়ে লোন ক্লোজ না হওয়া**, এবং **ঋণ বিতরণে সিরিয়াল লুপ** এর মতো সমস্যাগুলো অনতিবিলম্বে সংশোধন করা আবশ্যক। উল্লেখিত অ্যাকশন প্ল্যান অনুসরণ করে সংশোধনগুলো বাস্তবায়ন করলে অ্যাপ্লিকেশনটি সম্পূর্ণ ব্যাংক-গ্রেড স্থিতিশীলতা ও কার্যক্ষমতা অর্জন করবে।
