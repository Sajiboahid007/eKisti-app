# 🚀 AGENTS.md — eKisti Master Codebase & Architecture Guide

> **Target Audience:** AI Coding Agents (Antigravity, Cursor, Claude Code, Copilot, Windsurf) & Software Engineers  
> **Project Name:** `eKisti` (ই-কিস্তি — স্মার্ট লোকাল লোন ও কিস্তি ব্যবস্থাপনা)  
> **Repository Root:** `c:/unversity/eKisti-app`  
> **Last Updated:** October 2026  
> **Language & Framework:** Angular 21 (v21.2.24 Standalone), TypeScript 5.9, SCSS, Firebase Firestore 12.19  

---

## 📑 Table of Contents
1. [Executive Summary & Business Domain](#1-executive-summary--business-domain)
2. [Glossary & Microfinance Domain Terminology](#2-glossary--microfinance-domain-terminology)
3. [Architecture & Technology Stack](#3-architecture--technology-stack)
4. [Master File & Directory Map](#4-master-file--directory-map)
5. [Core Data Models & Database Schema](#5-core-data-models--database-schema)
6. [Core Services Architecture](#6-core-services-architecture)
7. [Routing & Security Guards](#7-routing--security-guards)
8. [Feature Modules & Component Breakdown](#8-feature-modules--component-breakdown)
9. [Print Engine Architecture (A4 Forms & Receipts)](#9-print-engine-architecture-a4-forms--receipts)
10. [Build, Environment & Seed Scripts](#10-build-environment--seed-scripts)
11. [Agent Rules & Implementation Guidelines](#11-agent-rules--implementation-guidelines)

---

## 1. Executive Summary & Business Domain

**eKisti (ই-কিস্তি)** is an enterprise-grade Microfinance, Local Loan, Cooperative Society, and Installment Management System designed specifically for the Bangladeshi microfinance ecosystem (ক্ষুদ্রঋণ ও সমবায় সমিতি).

### Core Business Pillars
1. **Branch & Samity Hierarchy:** Multi-branch network with field-level Somity/Centers (মহিলা/পুরুষ সমিতি) assigned to Field Officers (মাঠকর্মী).
2. **Customer KYC & Admission:** Member registration with NID verification, family tree, residence ownership, dual guarantors (জামিনদার), security cheques/stamps, and printable official A4 admission forms.
3. **Loan Origination & Disbursement:** Flat & declining rate microloans, daily/weekly/monthly frequencies, automated installment schedule generation, mandatory savings deductions, and disbursement vouchers.
4. **Daily Field Collections (দৈনিক কিস্তি আদায়):** Offline-ready field collection sheet for field officers with bulk collection, instant passbook receipts, and SMS/voucher tracking.
5. **Reconciliation & Vault Cash (ক্যাশ ক্লোজিং):** Day-end cash handover from field officers to branch cashiers, vault cash tracking, discrepancy notes, and accounting closing.
6. **Immutable Audit Trail:** Complete revision history (`EditHistoryEntry`) on all entities (Who changed what, when, previous vs new snapshot, and reason).
7. **Sequential Integer Primary Keys:** All entity IDs use sequential integers (e.g. `10001` for Customers, `20001` for Loans) generated atomically via Firestore transactions.

---

## 2. Glossary & Microfinance Domain Terminology

| Bengali Term | English Representation | Code Symbol / Property | Definition & Context |
| :--- | :--- | :--- | :--- |
| **কিস্তি** (Kisti) | Installment / Repayment | `installmentAmount`, `InstallmentSchedule` | Fixed periodic payment combining principal, service profit, and mandatory savings. |
| **সঞ্চয়** (Sanchay) | Savings / Member Deposit | `totalSavingsBalance`, `SavingsTransaction` | Mandatory or voluntary deposits collected alongside loan installments. |
| **সমিতি / রুট** (Samity / Route) | Center / Group / Route | `CenterOrSamity`, `centerId` | Field unit of 15–40 members meeting weekly or daily for group collections. |
| **শাখা** (Shakha) | Branch Office | `Branch`, `branchId` | Physical operational unit holding a cash vault managed by a Branch Manager & Cashier. |
| **মাঠকর্মী** (Mathkormi) | Field Officer (FO) | `UserStaff` (`role: 'FIELD_OFFICER'`) | Officer visiting samities in the morning to collect cash and disburse loans. |
| **শাখা ব্যবস্থাপক** (BM) | Branch Manager (BM) | `UserStaff` (`role: 'BRANCH_MANAGER'`) | Head of the branch with authority to approve loans and monitor portfolio quality. |
| **হিসাবরক্ষক / ক্যাশিয়ার** | Cashier / Accountant | `UserStaff` (`role: 'CASHIER'`) | Custodian of the branch vault who verifies day-end collections from field officers. |
| **জামিনদার** (Jamindar) | Guarantor | `CustomerGuarantor`, `primaryGuarantor` | Co-signers guaranteeing loan repayment with verified NID and phone numbers. |
| **বন্ধক / সিকিউরিটি** | Collateral / Security | `CustomerCollateral`, `hasBankCheque` | Bank cheques, 300 Tk court stamps, or deed copies deposited by borrowers. |
| **ভল্ট ক্যাশ** (Vault Cash) | Branch Vault Cash | `currentVaultCash` | Physical cash stored in the branch safe at any given moment. |
| **ক্যাশ ক্লোজিং** (Closing) | Day Reconciliation | `DailyReconciliation`, `cashierStatus` | Daily handover of physical field cash to the branch cashier. |
| **বকেয়া / খেলাপি** | Overdue / Defaulted | `LoanStatus: 'OVERDUE' \| 'DEFAULTED'` | Installments missed past their scheduled due date. |

---

## 3. Architecture & Technology Stack

### Technical Foundations
- **Frontend Framework:** Angular 21 (v21.2.24) using 100% **Standalone Components** (no `NgModule` anywhere in the app).
- **Reactive State Management:** Angular **Signals** (`signal()`, `computed()`, `model()`) and RxJS Observables (`toObservable()`).
- **Database & Backend:** Firebase Firestore (v12.19.0) with `@angular/fire` (v21.0.0-rc.2).
- **Offline / Local Fallback:** Firestore persistence enabled + localStorage session cache.
- **Styling Architecture:** Vanilla SCSS (`src/styles.scss`) with HSL design system tokens, CSS Grid/Flexbox, and comprehensive `@media print` rules.
- **Typography:** Google Fonts (`Hind Siliguri` for Bengali readability and `Inter` for numbers/English).
- **Test Runner:** Vitest (v4.0.8) configured in `package.json`.
- **Environment Management:** Dynamic generator (`scripts/set-env.js`) reading `.env` and writing `src/environments/environment.ts`.

---

## 4. Master File & Directory Map

```
c:/unversity/eKisti-app/
├── package.json                   # Project metadata, Angular 21 dependencies, and scripts
├── tsconfig.json                  # TypeScript compiler configuration (strict mode)
├── angular.json                   # Angular CLI workspace config (assets, styles, build target)
├── .env                           # Local environment secrets (Firebase config)
├── scripts/
│   ├── set-env.js                 # Injects .env into src/environments/environment.ts (prestart/prebuild)
│   └── seed-database.js           # Seeds initial demo data (branches, staff, customers, loans)
└── src/
    ├── index.html                 # Root HTML loading Google Fonts (Hind Siliguri, Inter, Material Icons)
    ├── main.ts                    # Application bootstrap via bootstrapApplication(App, appConfig)
    ├── styles.scss                # Global design system, utility classes, and print layout rules
    ├── environments/
    │   ├── environment.ts         # Production Firebase credentials (generated)
    │   └── environment.development.ts # Development Firebase credentials (generated)
    └── app/
        ├── app.ts                 # Root component handling layout toggle (Navbar, Sidebar, Outlet)
        ├── app.html               # Main template conditional layout wrapper
        ├── app.scss               # Root application styles
        ├── app.config.ts          # Application providers (Router, Firebase App, Firestore, Auth, Storage)
        ├── app.routes.ts          # Master routing table with lazy loaded components and guards
        │
        ├── core/                  # Core singletons, domain models, services, and guards
        │   ├── guards/
        │   │   └── auth.guard.ts  # authGuard (logged-in check) and superAdminGuard (admin permissions)
        │   ├── models/
        │   │   └── database.models.ts # Master domain schema (Customer, Loan, Branch, Staff, Audit, etc.)
        │   └── services/
        │       ├── kisti-database.service.ts # Firestore CRUD operations, queries, and business logic
        │       ├── auth-state.service.ts     # User session, 3-tier staff roles, permissions, demo logins
        │       ├── counter.service.ts        # Atomic Firestore transaction integer ID sequencer
        │       ├── audit-history.service.ts  # Generates and appends EditHistoryEntry logs
        │       └── language.service.ts       # Bilingual toggle (Bengali bn / English en)
        │
        ├── shared/                # Shared reusable UI components
        │   └── components/
        │       ├── navbar/        # Top bar: active branch, role switcher, current user, notifications
        │       ├── sidebar/       # Left navigation menu with badges and route highlighting
        │       └── history-modal/ # Universal audit history modal viewing who edited what & why
        │
        └── features/              # Feature modules (Domain-driven architecture)
            ├── auth/
            │   └── login/         # Interactive login screen with 1-click role demo buttons
            ├── dashboard/         # Executive KPIs, collection targets, loan balances, samity breakdown
            ├── customers/         # Member onboarding, directory, passbook, and printable admission form
            │   ├── customer-list/         # Searchable/filterable customer directory with print triggers
            │   └── customer-form/         # Create & edit customer KYC, address, guarantors, collateral
            ├── loans/             # Loan lifecycle management
            │   ├── loan-list/     # Portfolio view filterable by status (Active, Overdue, Closed)
            │   ├── loan-disburse/ # Loan creation calculator, interest rules, first due date, disburse voucher
            │   └── loan-detail/   # Loan account ledger, 40-installment schedule, savings balance & settlement
            ├── collections/       # Field collection sheets & money receipts
            │   ├── daily-sheet/   # Field Officer daily samity collection sheet with one-click collection
            │   └── receipt-list/  # Register of all payment receipts with printable thermal/A4 voucher
            ├── reconciliation/    # Day closing & accounting
            │   └── cash-closing/  # Cashier vault balance, FO cash handover verification, discrepancy notes
            ├── organization/      # Company structure
            │   └── branch-route-list/ # Branch management, route/samity scheduling, and meeting days
            └── users/             # Staff & access control
                ├── user-list/     # 3-tier staff directory, role permission configuration, printable ID cards
                └── user-form/     # Create & edit staff members with salary, designation, branch assignment
```

---

## 5. Core Data Models & Database Schema

All domain models reside in [src/app/core/models/database.models.ts](file:///c:/unversity/eKisti-app/src/app/core/models/database.models.ts).

### Key Entity Specifications

```
                     ┌──────────────┐
                     │    Branch    │ (branchId: 1, 2...)
                     └──────┬───────┘
                            │ 1:N
                     ┌──────▼───────┐
                     │CenterOrSamity│ (centerId: 101, 102...)
                     └──────┬───────┘
                            │ 1:N
                     ┌──────▼───────┐
       ┌─────────────┤   Customer   ├─────────────┐
       │             └──────┬───────┘             │
       │ 1:N                │ 1:N                 │ 1:N
┌──────▼───────┐     ┌──────▼───────┐      ┌──────▼────────────┐
│     Loan     │     │ Installments │      │SavingsTransactions│
└──────┬───────┘     └──────────────┘      └───────────────────┘
       │ 1:N
┌──────▼───────────┐
│PaymentCollections│
└──────────────────┘
```

#### 1. `Customer` (গ্রাহক / সদস্য)
- **Primary Key:** `customerId: number` (Sequence: `10001+`)
- **Code:** `customerCode: string` (e.g., `CUST-10001`)
- **Foreign Keys:** `branchId`, `centerId`, `assignedFieldOfficerId`
- **Personal Details:** `fullName`, `fatherName`, `motherName`, `spouseName`, `dateOfBirth`, `gender`, `phonePrimary`, `phoneSecondary`, `nidNumber`, `birthCertificateNo`
- **Addresses:** `presentAddress` (with `houseOwnership: 'OWN' | 'RENTED' | 'FAMILY'`), `permanentAddress`
- **Financial & Business:** `occupation`, `businessName`, `monthlyIncome`
- **Security:** `primaryGuarantor: CustomerGuarantor`, `secondaryGuarantor`, `collateral: CustomerCollateral` (bank cheque, 300 Tk stamp)
- **Balances:** `totalSavingsBalance: number`, `totalLoansTaken: number`, `activeLoansCount: number`, `creditScore: 'GOOD' | 'AVERAGE' | 'RISKY' | 'BLACKLISTED'`
- **Audit & Soft Delete:** `isDeleted`, `deletedAt`, `deletedByUserId`, `deleteReason`, `history: EditHistoryEntry[]`

#### 2. `Loan` (ঋণ হিসাব)
- **Primary Key:** `loanId: number` (Sequence: `20001+`)
- **Account No:** `loanAccountNo: string` (e.g., `LN-20001`)
- **Foreign Keys:** `customerId`, `branchId`, `centerId`, `fieldOfficerUserId`, `productId`
- **Financials:**
  - `principalAmount: number` (বিতরণকৃত আসল ঋণ, e.g. 20,000)
  - `interestOrServiceCharge: number` (সুদ / লাভ, e.g. 4,000)
  - `totalRepayableAmount: number` (মোট পরিশোধযোগ্য = আসল + লাভ, e.g. 24,000)
  - `installmentFrequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'`
  - `totalInstallments: number` (e.g. 40 কিস্তি)
  - `installmentAmount: number` (e.g. 600 টাকা)
  - `savingsPerInstallment: number` (বাধ্যতামূলক সঞ্চয়, e.g. 50 টাকা)
- **Real-time Status:** `totalPaidAmount`, `totalSavingsCollected`, `outstandingBalance`, `paidInstallmentsCount`, `remainingInstallmentsCount`, `overdueAmount`
- **Lifecycle:** `status: 'APPLIED' | 'FIELD_VERIFIED' | 'APPROVED' | 'DISBURSED' | 'OVERDUE' | 'CLOSED' | 'DEFAULTED' | 'CANCELLED'`
- **Dates:** `applicationDate`, `approvedDate`, `disbursementDate`, `firstInstallmentDueDate`, `expectedClosingDate`

#### 3. `InstallmentSchedule` (কিস্তি শিডিউল)
- **Primary Key:** `installmentId: number` (Sequence: `30001+`)
- **Foreign Keys:** `loanId`, `customerId`, `branchId`, `centerId`, `fieldOfficerUserId`
- **Schedule:** `installmentNo: number`, `dueDate: string`
- **Expected:** `expectedPrincipal`, `expectedProfit`, `expectedSavings`, `expectedTotalAmount`
- **Paid:** `paidPrincipal`, `paidProfit`, `paidSavings`, `paidTotalAmount`, `paidDate`, `collectionReceiptId`
- **Status:** `'PENDING' | 'PAID' | 'PARTIAL' | 'OVERDUE' | 'ADVANCE'`

#### 4. `PaymentCollection` (কিস্তি আদায় রসিদ)
- **Primary Key:** `receiptId: number` (Sequence: `40001+`)
- **Foreign Keys:** `loanId`, `customerId`, `installmentId`, `collectedByUserId`, `branchId`, `centerId`
- **Amounts:** `principalAmountCollected`, `profitAmountCollected`, `savingsAmountCollected`, `fineAmountCollected`, `totalAmountCollected`
- **Method:** `paymentMethod: 'CASH' | 'BKASH' | 'NAGAD' | 'BANK'`, `trxId`
- **Reconciliation:** `isHandedOverToBranch: boolean`, `reconciliationId?: number`, `reconciledAt?: string`

#### 5. `DailyReconciliation` (ক্যাশ ক্লোজিং)
- **Primary Key:** `reconciliationId: number` (Sequence: `50001+`)
- **Metadata:** `date: string`, `branchId: number`, `fieldOfficerUserId: number`, `fieldOfficerName: string`
- **Cash Handover:** `targetCollectionAmount`, `actualCashCollected`, `shortageOrDeficitAmount`, `cashHandedOverAmount`
- **Cashier Action:** `cashierUserId`, `cashierStatus: 'PENDING' | 'ACCEPTED' | 'MISMATCH_DISCREPANCY'`, `cashierNotes`

#### 6. `SavingsTransaction` (সঞ্চয় হিসাব)
- **Primary Key:** `transactionId: number` (Sequence: `60001+`)
- **Type:** `'DEPOSIT' | 'WITHDRAW' | 'KISTI_COLLECTION' | 'ADJUSTMENT' | 'ACCOUNT_CLOSURE'`
- **Balances:** `amount: number`, `isCredit: boolean`, `previousBalance: number`, `newBalance: number`

#### 7. `Branch` & `CenterOrSamity`
- **Branch:** `branchId: number` (`1+`), `branchCode: "BR-01"`, `name: "মিরপুর শাখা"`, `managerUserId`, `cashierUserId`, `currentVaultCash`
- **CenterOrSamity:** `centerId: number` (`101+`), `name: "শাপলা মহিলা সমিতি"`, `branchId`, `fieldOfficerUserId`, `meetingDay`, `meetingTime`, `location`

#### 8. `UserStaff` & `Role`
- **3-Tier Structure:**
  - `SYSTEM_ADMIN`: Super Admin, Admin (Access to all branches, role configurations, system counters).
  - `HEAD_OFFICE`: MD, Area Manager, Regional Manager, Central Auditor.
  - `BRANCH_STAFF`: Branch Manager, Cashier, Field Officer (Scoped to specific `branchId` & `assignedCenterIds`).
- **Dynamic Roles:** Configurable permissions via `SYSTEM_PERMISSIONS`.

---

## 6. Core Services Architecture

All core services live in [src/app/core/services/](file:///c:/unversity/eKisti-app/src/app/core/services/).

### 1. `KistiDatabaseService` ([kisti-database.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/kisti-database.service.ts))
The single database orchestration service for Firestore with local fallback:
- **Customer Ops:** `createCustomer()`, `getCustomers()`, `updateCustomer()`, `softDeleteCustomer()`.
- **Loan Ops:** `disburseLoan()`, `getLoans()`, `getLoansByCustomerId()`, `getLoanProducts()`, `updateLoanAccountNo()`.
- **Collection Ops:** `collectPayment()` (atomically updates receipt, installment schedule, loan balance, and customer savings).
- **Savings Ops:** `recordSavingsTransaction()`, `getSavingsTransactionsByCustomerId()`.
- **Branch & Center Ops:** `getBranches()`, `createBranch()`, `updateBranch()`, `getCenters()`, `createCenterOrRoute()`.
- **Staff & Role Ops:** `getRoles()`, `createRole()`, `updateRole()`, `getStaff()`, `createStaff()`, `updateStaff()`.
- **Generic Audit Helpers:** `editRecord()`, `softDeleteRecord()`.

### 2. `CounterService` ([counter.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/counter.service.ts))
Race-condition-proof atomic ID sequencer using Firestore `runTransaction`:
```typescript
async getNextIntegerId(entity: EntitySequence): Promise<number>
async peekNextIntegerId(entity: EntitySequence): Promise<number>
```
Sequence starting baselines:
- `branches`: 1
- `centers`: 101
- `staff`: 501
- `roles`: 10
- `customers`: 10001
- `loans`: 20001
- `installments`: 30001
- `receipts`: 40001
- `reconciliations`: 50001
- `savings`: 60001

### 3. `AuditHistoryService` ([audit-history.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/audit-history.service.ts))
- Generates `EditHistoryEntry` snapshots before and after modifications.
- Cleans nested history arrays to prevent recursive payload bloat.
- Helper `appendHistory(existingHistory, newEntry)` ensures chronological logging.

### 4. `AuthStateService` ([auth-state.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/auth-state.service.ts))
- **Active Signals:**
  - `currentUser = signal<ActiveUserSession>(...)`
  - `isAuthenticated = signal<boolean>(...)`
  - `availableUsers = signal<ActiveUserSession[]>(...)`
- **Computed Role Checks:** `isSuperAdmin`, `isAdmin`, `isAreaManager`, `isBranchManager`, `isFieldOfficer`, `isCashier`.
- **Computed Permissions:** `canManageUsers`, `canApproveLoans`, `canDisburseLoan`, `canCollectKisti`, `canVerifyCash`.
- **Switching & Demo:** `loginAsRole(role)`, `switchUser(userId)`, `logout()`.

### 5. `LanguageService` ([language.service.ts](file:///c:/unversity/eKisti-app/src/app/core/services/language.service.ts))
- Manages bilingual UI state (`'bn'` / `'en'`).
- Translates UI keys through `t(key, fallback)`.

---

## 7. Routing & Security Guards

Routes are defined in [src/app/app.routes.ts](file:///c:/unversity/eKisti-app/src/app/app.routes.ts) and protected by [src/app/core/guards/auth.guard.ts](file:///c:/unversity/eKisti-app/src/app/core/guards/auth.guard.ts).

| Path | Component | Guards | Responsibility |
| :--- | :--- | :--- | :--- |
| `/login` | `LoginComponent` | None | Authentication & 1-click role demo switcher |
| `/dashboard` | `DashboardComponent` | `[authGuard]` | Executive overview, branch summary & collections |
| `/customers` | `CustomerListComponent` | `[authGuard]` | Member directory, search, admission print triggers |
| `/customers/new` | `CustomerFormComponent` | `[authGuard]` | Member creation form with KYC, guarantors, collateral |
| `/customers/edit/:id` | `CustomerFormComponent` | `[authGuard]` | Member profile editor with audit logging |
| `/customers/register` | `CustomerFormComponent` | `[authGuard]` | Alias for member registration |
| `/loans` | `LoanListComponent` | `[authGuard]` | Loan portfolio filterable by status |
| `/loans/disburse` | `LoanDisburseComponent` | `[authGuard]` | Loan disburse calculator, schedule preview & voucher |
| `/loans/detail/:id` | `LoanDetailComponent` | `[authGuard]` | Ledger, 40-installment schedule, savings settlement |
| `/collections/daily` | `DailySheetComponent` | `[authGuard]` | Field officer daily collection sheet |
| `/collections/receipts`| `ReceiptListComponent` | `[authGuard]` | Payment receipts register & print vouchers |
| `/reconciliation` | `CashClosingComponent` | `[authGuard]` | Cashier vault closing & field officer reconciliation |
| `/branches` | `BranchRouteListComponent` | `[authGuard]` | Branch & samity/route management |
| `/users` | `UserListComponent` | `[authGuard, superAdminGuard]` | Staff management, role permissions & ID cards |
| `/users/new` | `UserFormComponent` | `[authGuard, superAdminGuard]` | Add/edit staff user profile |

---

## 8. Feature Modules & Component Breakdown

### Customers Feature
1. **[CustomerListComponent](file:///c:/unversity/eKisti-app/src/app/features/customers/customer-list/customer-list.component.ts):**
   - Renders data table with search by Name, Phone, Customer Code, and NID.
   - Filters by branch and samity.
   - View Passbook / Customer Details Modal with loan breakdown and savings history.
2. **[CustomerFormComponent](file:///c:/unversity/eKisti-app/src/app/features/customers/customer-form/customer-form.component.ts):**
   - Comprehensive form for creating new members and editing existing members with KYC, guarantors, collateral, and audit reasons.

### Loans Feature
1. **[LoanListComponent](file:///c:/unversity/eKisti-app/src/app/features/loans/loan-list/loan-list.component.ts):**
   - Displays all active, overdue, and closed loans.
   - Quick search by Loan Account No (`LN-20001`), Customer Name, or Phone.
2. **[LoanDisburseComponent](file:///c:/unversity/eKisti-app/src/app/features/loans/loan-disburse/loan-disburse.component.ts):**
   - Select customer from searchable dropdown.
   - Select loan product (Microloan, Enterprise, Daily Loan).
   - Auto-computes interest, total repayable, installment amount, and savings deduction.
   - Interactive schedule generator for 40 weekly / daily dates.
   - Prints official Loan Disbursement Voucher (`#printableLoanDisburseReceipt`).
3. **[LoanDetailComponent](file:///c:/unversity/eKisti-app/src/app/features/loans/loan-detail/loan-detail.component.ts):**
   - Shows loan account ledger, full repayment schedule with status pills (`PAID`, `PENDING`, `OVERDUE`).
   - Savings settlement module: Close loan and transfer/refund savings balance.

### Collections & Field Operations
1. **[DailySheetComponent](file:///c:/unversity/eKisti-app/src/app/features/collections/daily-sheet/daily-sheet.component.ts):**
   - Field collection sheet filtered by Samity and Field Officer.
   - Displays list of expected installments due today.
   - One-click collection: Records principal, profit, and savings with automatic receipt issuance.
2. **[ReceiptListComponent](file:///c:/unversity/eKisti-app/src/app/features/collections/receipt-list/receipt-list.component.ts):**
   - Chronological list of money receipts (`RCP-40001`).
   - Filter by date, payment method (Cash/bKash/Nagad), and field officer.
   - Thermal & A4 print receipt options.

### Reconciliation Feature
1. **[CashClosingComponent](file:///c:/unversity/eKisti-app/src/app/features/reconciliation/cash-closing/cash-closing.component.ts):**
   - Daily cash handover verification for Branch Cashiers.
   - Compares expected collections vs actual physical cash submitted by Field Officers.
   - Updates `currentVaultCash` of the branch upon acceptance.

### Users & Staff Feature
1. **[UserListComponent](file:///c:/unversity/eKisti-app/src/app/features/users/user-list/user-list.component.ts):**
   - 3-tier view: System Admins, Head Office Officers, Branch Staff.
   - Permission matrix management for each role.
   - Official Employee ID Card generator with QR/barcode preview and printing (`#printableCustomerIdCard`).

---

## 9. Print Engine Architecture (A4 Forms & Receipts)

eKisti features a dedicated print engine implemented in [src/styles.scss](file:///c:/unversity/eKisti-app/src/styles.scss#L462-L1176).

### Standard Print Elements
```
#printableCustomerAdmissionForm   --> 2-Page A4 Official Admission Form (Filled)
#printableBlankCustomerForm       --> 2-Page A4 Official Admission Form (Blank with dotted lines)
#printableCustomerDetails         --> Single/Multi-page Member KYC & Loan Statement
#printableCustomerIdCard          --> Staff/Member Identity Card Badge
#printableLoanDisburseReceipt     --> Loan Sanction & Disbursement Advice Slip
```

### Print Rules & Pagination Mechanics
1. **Body Target Class & Container Detection:**
   ```scss
   body:has(#printableCustomerAdmissionForm),
   body:has(#printableBlankCustomerForm) {
     @page {
       size: A4 portrait;
       margin: 8mm 10mm;
     }
     app-navbar, app-sidebar, .page-container, .modal-backdrop > *:not(...) {
       display: none !important;
     }
   }
   ```
2. **Page Breaking for 2-Page Forms:**
   - `.sheet-page-1`: `page-break-after: always !important; break-after: page !important;`
   - `.sheet-page-2`: `page-break-before: always !important; break-before: page !important;`
3. **Exact Dimensions:**
   - Min height: `275mm !important;`
   - Color adjustment: `-webkit-print-color-adjust: exact !important; print-color-adjust: exact !important;`
4. **Blank Form Dot Leaders:**
   - Inputs replaced or overlaid with `.f-line.dotted` using `border-bottom: 1px dotted #64748b !important;`

---

## 10. Build, Environment & Seed Scripts

### Available NPM Commands
```bash
# 1. Start development server (Automatically triggers prestart: env:config)
npm start

# 2. Build production bundle (Automatically triggers prebuild: env:config)
npm run build

# 3. Seed fresh Firestore database with counters, branches, staff, members, and loans
npm run db:seed

# 4. Generate environment config manually from .env
npm run env:config

# 5. Run unit tests via Vitest
npm test
```

### Environment Configuration Flow
1. `.env` stores Firebase API keys and Project ID:
   ```env
   FIREBASE_API_KEY=AIzaSy...
   FIREBASE_AUTH_DOMAIN=ekisti-app.firebaseapp.com
   FIREBASE_PROJECT_ID=ekisti-app
   FIREBASE_STORAGE_BUCKET=ekisti-app.appspot.com
   FIREBASE_MESSAGING_SENDER_ID=...
   FIREBASE_APP_ID=...
   ```
2. `scripts/set-env.js` reads `.env` and generates:
   - `src/environments/environment.ts`
   - `src/environments/environment.development.ts`

### Seeding Script (`scripts/seed-database.js`)
- Initializes atomic sequence counters in Firestore collection `counters/`.
- Inserts Branch `1` (মিরপুর শাখা), Samities `101` (শাপলা) & `102` (গোলাপ).
- Seeds default staff: Admin (`1`), Branch Manager (`501`), Field Officers (`502`, `504`), Cashier (`503`).
- Seeds realistic loan products, customers, and active loans.

---

## 11. Agent Rules & Implementation Guidelines

When writing code or assisting with `eKisti`, every AI Agent MUST follow these rules:

1. **Standalone Components Only:** Never generate or look for `NgModule`. Use `@Component({ standalone: true, imports: [...] })`.
2. **Signals Over Imperative State:** Use Angular signals (`signal()`, `computed()`) for UI state and reactive calculations.
3. **Sequential Integer IDs:** Never generate random UUIDs or Firestore string IDs for business records. Always use `CounterService.getNextIntegerId('customers' | 'loans' | ...)` and store documents with integer keys (`doc(firestore, 'collection', id.toString())`).
4. **Audit History Logging:** Any modification, deletion, or creation must create an `EditHistoryEntry` via `AuditHistoryService` with `changedByUserId`, `reason`, `previousData`, and `newData`.
5. **No Hardcoded Passwords in Production:** Staff authentication uses `AuthStateService` presets for testing and Firebase Auth UID links in production.
6. **Preserve Bengali Terminology:** Always preserve correct microfinance domain terminology in comments and UI templates (কিস্তি, সঞ্চয়, সমিতি, জামিনদার, ভল্ট ক্যাশ).
7. **Print CSS Discipline:** When adding printable sections, register the container ID in `src/styles.scss` under `@media print` and ensure non-printable navigation bars and buttons have `.no-print`.
8. **Verify Builds:** Always verify changes using `npx ng build --configuration development` to catch TypeScript and Angular template compiler diagnostics.

---
*Generated for AI Agents & Developers maintaining eKisti.*
