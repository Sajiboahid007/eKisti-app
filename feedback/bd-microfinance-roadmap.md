# eKisti — Bangladeshi Microfinance Feature & Database-History Roadmap

**Date:** 2026-10-22
**Inputs:** `claude-feedback.md`, `feedback/apis.md`, `AGENTS.md`, and the current code on `main`, including the uncommitted API fixes.
**Purpose:** Lists what eKisti still needs to work like a real Bangladeshi kisti / microfinance office (NGO-MFI or সমবায় সমিতি). Covers two things:
1. **Features** that are missing or incomplete.
2. **Database history**: the ledgers and audit records a financial system has to keep.

> **How to read this.** Every item has a priority:
> - **P0**: must be done before handling real money
> - **P1**: needed for normal branch operations
> - **P2**: needed for growth, reporting or regulators
> - **P3**: nice to have
>
> Items marked **⚖️ Verify** depend on regulation or your own policy. Confirm them against the current MRA / সমবায় অধিদপ্তর rules before building. Numbers given here are common practice, not legal advice.

---

## 0. First decision: which regulator?

AGENTS.md describes eKisti as both an **MFI** (ক্ষুদ্রঋণ) and a **cooperative** (সমবায় সমিতি). These are regulated differently:

| If you are… | Regulator | What changes in the app |
|---|---|---|
| An NGO-MFI with a licence | **MRA**, Microcredit Regulatory Authority | Service-charge cap, loan classification and provisioning, MRA periodic reports, savings rules |
| A registered cooperative | **সমবায় অধিদপ্তর** (Department of Cooperatives) | Share capital (শেয়ার), member dividend, AGM, cooperative audit format |
| An informal local lender / shop kisti | None formally | Simpler. Still needs the ledger and audit features below. |

**Decide this first.** Sections 3.2, 3.3 and 3.8 depend on it. The rest of this document assumes an **MRA-style MFI**, because the code already uses MFI terms (জাগরণ product, samity, compulsory savings).

---

## 1. Already done (not repeated below)

| Area | Status |
|---|---|
| Skeleton loading on all pages | ✅ Done |
| Receipt register: role scoping, filters, pagination, print, compact table | ✅ Done |
| Cash closing: per-branch, `DailyReconciliation` records, note-by-note counting, one atomic transaction, vault before/after, audit on receipts and branch | ✅ Done |
| Opening savings creates a `DEPOSIT` passbook entry | ✅ Done |
| Disbursement: IDs reserved in one step, loan + installments + customer counters written in one batch | ✅ Done |
| Customer `totalLoansTaken` / `activeLoansCount` kept in sync | ✅ Done |
| Account closure: adjusting loans from savings closes them, with a passbook entry | ✅ Done |
| Daily sheet N+1 queries | ✅ Done |
| Test suite runs (3/3 pass) | ✅ Done |

---

## 2. Still open from the earlier reviews (checked against the code today)

These are bugs in existing features. Fix them before adding new ones.

| # | Issue | Evidence in code today | Priority |
|---|---|---|---|
| 2.1 | Login accepts any user without a password, and the session can be forged | `auth-state.service.ts` `login(emailOrPhone, password?)` | P0 (**you are handling this**) |
| 2.2 | No Firestore security rules in the repo | `firestore.rules` doesn't exist | P0 |
| 2.3 | Routes only check "logged in", not role. A field officer can open `/loans/disburse` or `/reconciliation`. | `app.routes.ts`: only `authGuard` on these routes | P0 |
| 2.4 | **Collection isn't atomic.** The receipt, loan, savings and installment are separate writes. The installment is marked PAID by the component *after* `collectPayment()`, so a dropped connection allows a double collection. | `daily-sheet.component.ts` calls `collectPayment()` then `editRecord('installments')` | P0 |
| 2.5 | Rounding can leave a loan with ৳1–5 that never closes | `installmentAmount × count ≠ totalRepayable`; the remainder isn't put on the last installment | P0 |
| 2.6 | Partial payments are marked `PAID` | `loan-detail.component.ts:237` sets `status: 'PAID'` for any amount | P0 |
| 2.7 | **Overdue is never computed.** Nothing sets `OVERDUE`, `overdueAmount` or `missedInstallmentsCount`. Dashboard PAR is always 0%. | Only written as `0` at disbursement | P0 |
| 2.8 | The 7-day lockout applies to daily and monthly loans too | `daily-sheet.component.ts:248` `daysSinceLast < 7` | P1 |
| 2.9 | Disbursement doesn't reduce the branch vault | `loan-disburse` never touches `currentVaultCash` | P1 |
| 2.10 | No approval workflow (maker-checker). Loans are created directly as `DISBURSED`. | `loan-disburse.component.ts:492` | P1 |
| 2.11 | Running `npm run db:seed` again resets counters and overwrites real data | `scripts/seed-database.js` | P1 |
| 2.12 | Dates use UTC, but the business day is Asia/Dhaka (UTC+6) | `toISOString().split('T')[0]` in many places | P1 |
| 2.13 | No NID / phone validation and no duplicate-NID check | `customer-form` | P1 |
| 2.14 | Audit `history[]` grows inside each document (1 MiB limit) | See section 4 | P1 |
| 2.15 | Lists and the dashboard load whole collections | `getDocs(collection(...))` with no `where` | P2 |
| 2.16 | AGENTS.md says "offline-ready", but Firestore offline persistence is never enabled | `getFirestore()` with default settings | P2 |

---

## 3. Missing Bangladeshi microfinance features

### 3.1 Loan lifecycle (ঋণ জীবনচক্র)

| Feature | Why it matters in BD | What to build | Data model | Priority |
|---|---|---|---|---|
| **Approval workflow (maker-checker)** | Standard MFI control: the FO applies, the BM verifies and approves, then the cashier disburses. Prevents fake loans. | Application screen (`APPLIED`), FO field-verification checklist (`FIELD_VERIFIED`), BM approval (`APPROVED`), disbursement. The approver must not be the applicant. | The `LoanStatus` values already exist. Add `appliedByUserId`, `verifiedByUserId`, `verificationNotes`, `rejectedReason`. Record each step in loan status history (section 4). | P1 |
| **Loan cycle and ceiling** (ঋণ চক্র) | First loan small, later loans larger if repaid well. Every BD MFI does this. | Ceiling per product per cycle (e.g. cycle 1 ≤ ৳20,000, cycle 2 ≤ ৳30,000). Block a new loan while one is active, unless the product allows it. | `Loan.loanCycle`, `LoanProduct.cycleCeilings[]` | P1 |
| **Grace period** | Weekly loans usually start 1–2 weeks after disbursement. | Product field; first due date = disbursement + grace. | `LoanProduct.graceDays` | P1 |
| **Holiday calendar** | No collection on Fridays (for most samities), government holidays or Eid. Due dates must skip them. | Branch / head-office holiday list. Schedule generation moves due dates forward. | New `holidays` collection `{ date, name, branchIds \| 'ALL' }` | P1 |
| **Flat vs declining balance, and effective-rate disclosure** | ⚖️ Verify: MRA caps the service charge (commonly cited as 24% per year on a declining-balance basis). Flat rates must be converted to their effective rate for disclosure. | Product setting for the method. Show both the flat rate and the effective annual rate on the disbursement voucher. | `LoanProduct.interestMethod: 'FLAT' \| 'DECLINING'`, `effectiveAnnualRate` | P1 ⚖️ |
| **Early settlement and rebate** (আগাম পরিশোধ) | Members pay off early, and a service-charge rebate is common. | "Settle loan" action: compute the remaining principal and the rebate on unearned profit, close the loan, post a ledger entry. | Loan transaction type `EARLY_SETTLEMENT`, `rebateAmount` | P1 |
| **Advance and multiple-installment payment** | A member pays 2–3 weeks in advance before travelling. | Allocate the payment across the next installments (status `ADVANCE`) instead of rejecting it. | Uses the existing `ADVANCE` status | P1 |
| **Rescheduling** (পুনঃতফসিল) | After floods, illness or a business loss, the BM or head office reschedules. | Cancel the remaining installments, generate a new schedule, keep the old one for history, require approval. | `Loan.rescheduleCount`, transaction `RESCHEDULE`, old installments → status `RESCHEDULED` | P2 |
| **Write-off** (অবলোপন) | Bad loans past a threshold are written off with head-office approval but still tracked for recovery. | Write-off action (head-office role), recoveries after write-off. | `LoanStatus: 'WRITTEN_OFF'`, transactions `WRITE_OFF` / `WRITE_OFF_RECOVERY` | P2 |
| **Death / disability claim** (মৃত্যুজনিত দাবি) | Most BD MFIs run a loan-risk fund or micro-insurance. On a borrower's death the outstanding balance is waived and the family may get a benefit. `insuranceFeePaid` is collected but never used. | Claim form, approval, waive outstanding via the risk fund, payout to the nominee. | `riskFundTransactions`, `insuranceClaims` collections | P2 |
| **Guarantor follow-up** | For overdue loans, field staff contact the জামিনদার. | Overdue list shows guarantor name and phone (the dashboard already does part of this); log each contact. | `followUps` collection `{ loanId, contactedPerson, outcome, promiseDate }` | P2 |

### 3.2 Loan classification & provisioning (MRA)  ⚖️ Verify

None of this exists yet, and it's required for MRA reporting and for an honest portfolio view. Common MRA-style buckets:

| Class | Overdue period (typical) | Loan-loss provision (typical) |
|---|---|---|
| নিয়মিত (Standard) | not overdue | 1% |
| পর্যবেক্ষণাধীন (Watchful) | 1–30 days | 5% |
| নিম্নমান (Substandard) | 31–180 days | 25% |
| সন্দেহজনক (Doubtful) | 181–365 days | 75% |
| মন্দ / ক্ষতি (Bad / Loss) | > 365 days | 100% |

**Build:**
- **Overdue engine (needed first; see 2.7):** a nightly job, run at 00:05 Asia/Dhaka (Cloud Function or Cloud Scheduler), that:
  - marks past-due installments `OVERDUE`;
  - fills `overdueAmount`, `missedInstallmentsCount` and `daysPastDue`;
  - sets `Loan.classification`.
- **Portfolio KPIs:** PAR > 1 day and PAR > 30 days, OTR (on-time recovery rate), CRR (cumulative recovery rate), and the required provision amount per branch.
- **Data:** add `Loan.daysPastDue`, `Loan.classification`, `Loan.classifiedAt`. Save a daily snapshot (section 4.6) so trends and month-end figures can't be rewritten.

Priority: **P1** (the engine) / **P2** (provisioning reports).

### 3.3 Savings products (সঞ্চয়)

Today there is a single `totalSavingsBalance` per customer. Real MFIs run several savings accounts per member.

| Feature | Detail | Data model | Priority |
|---|---|---|---|
| **Savings accounts per product** | Compulsory savings (সাধারণ / বাধ্যতামূলক সঞ্চয়), voluntary savings (স্বেচ্ছা সঞ্চয়), DPS (monthly deposit scheme), and term deposits / FDR. Note that ⚖️ MRA restricts who can take voluntary and term deposits. | New `savingsAccounts` collection `{ accountId, customerId, productType, balance, interestRate, openedAt, maturityDate, status }`. `SavingsTransaction.accountId` | P1 |
| **Withdrawal rules** | Compulsory savings are usually locked while a loan is active (or kept above a minimum). | Validation in `recordSavingsTransaction` | P1 |
| **Interest / profit posting** | Periodic (monthly or yearly) interest credited to savings. ⚖️ Verify the rate and method. | Batch job → `SavingsTransaction` of type `INTEREST`. Add `'INTEREST'` to `SavingsTransactionType`. | P2 |
| **DPS maturity and FDR encashment** | Maturity value, premature encashment penalty. | Fields on `savingsAccounts`, transaction `MATURITY_PAYOUT` | P2 |
| **Nominee** (নমিনি) | Required for savings payout and insurance claims on death. **The `Customer` model has no nominee today.** | `Customer.nominees: { name, relation, nid, phone, sharePercent }[]` | **P1** |

### 3.4 Member, group & samity (সদস্য, দল ও সমিতি)

| Feature | Detail | Data model | Priority |
|---|---|---|---|
| **Groups within a samity** (দল) | The classic Grameen/BRAC model: groups of about 5 inside a samity, each with a group leader (দলনেতা). The samity has a center chief (কেন্দ্র প্রধান). Peer guarantee works through the group. | `groups` collection or `Customer.groupNo`. `CenterOrSamity.centerChiefCustomerId` | P2 |
| **Meeting attendance** (সাপ্তাহিক মিটিং হাজিরা) | Attendance is recorded at each weekly meeting and used to judge loan eligibility. | `meetings` collection `{ centerId, date, attendees[], absentees[], notes }` | P2 |
| **Admission and passbook fees** (ভর্তি ফি, পাসবুক ফি) | Charged once at admission. Today only the loan form fee exists. | Fee ledger entry at registration (section 4) | P1 |
| **Member transfer** | Moving a member between samities or branches (relocation or FO change). The loans and savings move too. | Transfer action + `memberTransfers` history | P2 |
| **KYC documents upload** | Photo, NID front/back and signature/thumbprint. The URL fields already exist (`photoUrl`, `nidFrontPhotoUrl` …) and Firebase Storage is configured, but there's no upload flow. | Upload to Storage `customers/{id}/...`, keep previous versions | P1 |
| **NID validation and duplicate check** | BD NID is 10, 13 or 17 digits. Mobile numbers match `01[3-9]XXXXXXXX`. A duplicate NID means the same person registered twice. | Validator + query on `nidNumber` before create | P1 |
| **Overlap / multiple borrowing check** | Borrowing from several samities or branches at once is a big risk in BD. At minimum, check across all branches inside eKisti. | Query by NID across branches; warn or block | P1 |
| **Credit score and blacklist** | `creditScore` exists but nothing calculates it. | Rule-based score from repayment history; blacklist with reason and approver | P2 |

### 3.5 Field collection (মাঠ আদায়)

| Feature | Detail | Priority |
|---|---|---|
| **One atomic collection** (see 2.4) | Receipt + installment + loan + savings in one `runTransaction`. Reject if the installment isn't `PENDING` / `OVERDUE` / `PARTIAL`. | **P0** |
| **Due-date-based eligibility** (see 2.8) | "Due today / overdue / advance", not "7 days since the last payment". | P1 |
| **Receipt cancellation by reversal** | Never edit or delete a receipt. Cancelling creates a **reversal** entry with a reason and BM approval, which restores the installment and loan balance. | **P1** |
| **Late fee / fine policy** ⚖️ Verify | `fineAmountCollected` exists but is always 0. Decide whether your institution charges fines at all; many BD MFIs do not. If yes: rule per product and a waiver with approval. | P2 |
| **Printable samity collection sheet** | FOs often still carry a paper sheet: member, due, previous balance, empty columns for signatures. | P1 |
| **Offline-first for FOs** | Rural areas have weak signal. Enable Firestore `persistentLocalCache`, queue collections, and show the sync status. Make it a PWA (installable on Android). | P1 |
| **Bangla SMS** | SMS on collection (receipt no., amount, balance), due reminders the day before, and an overdue notice. Use a BD SMS gateway via a Cloud Function, never from the browser. | P2 |
| **bKash / Nagad verification** | TrxID is stored but never verified. Integrate the merchant API or require cashier verification before closing. | P2 |

### 3.6 Cash, vault & accounting (হিসাব ও ভল্ট)

The vault currently only goes **up** (collections at cash closing). A real branch cash book needs every movement:

| Feature | Detail | Priority |
|---|---|---|
| **Vault ledger** | Every vault movement is a row: closing receipt (in), loan disbursement (out), bank deposit (out), bank withdrawal (in), expense (out), fund from / to head office, opening balance. `currentVaultCash` becomes the running total of this ledger. | **P1** |
| **Disbursement reduces the vault** (see 2.9) | Disbursement → vault ledger "out". Block it if the vault doesn't hold enough cash. | P1 |
| **Bank account register** | Branch bank accounts, deposits and withdrawals with slip numbers (cash in the vault vs in the bank). | P1 |
| **Expense management** | Office rent, utilities, conveyance, salaries; voucher number, approval, receipt photo. | P1 |
| **Fund transfer: head office ↔ branch** | Head office sends funds for disbursement, and branches send surplus back. Sender and receiver both confirm. | P2 |
| **Day-end and month-end closing** (দিবস / মাস সমাপনী) | After day-end, nothing can be posted to that date (period lock). Month-end produces snapshots and reports. | **P1** |
| **Double-entry general ledger** | Chart of accounts (cash, bank, loans receivable, member savings, service-charge income, fee income, expenses, loan-loss provision). Each business operation posts balanced journal entries. Gives you a cash book, trial balance, income statement and balance sheet. | P2 |

### 3.7 Staff & operations (কর্মী)

| Feature | Detail | Priority |
|---|---|---|
| **FO targets and performance** | Monthly disbursement / collection / new-member targets vs actuals. The dashboard leaderboard is a start. | P2 |
| **Staff transfer history** | When an FO changes branch or samity, keep who was responsible for which samity on which dates. | P1 (history) |
| **Cash-in-hand limit** | Alert when an FO holds more than ৳X uncollected cash or hasn't closed by evening. | P2 |
| **Staff attendance and leave** | Optional; many MFIs keep this in a separate HR system. | P3 |

### 3.8 Reports (রিপোর্ট)

| Report | Users | Priority |
|---|---|---|
| Daily collection report (per FO / samity / branch) | BM, cashier | P1 |
| Due list and overdue list with guarantors | FO, BM | P1 |
| Loan ledger statement and savings statement (member passbook print) | Member, FO | P1 |
| Day book / cash book | Cashier, auditor | P1 |
| Portfolio and aging report (PAR, classification, provision) | Head office, MRA | P2 |
| MRA periodic returns ⚖️ Verify which formats apply to you | Head office | P2 |
| Branch MIS (members, borrowers, outstanding, disbursement, OTR) | Area manager, MD | P2 |
| Export to Excel / PDF | All | P2 |

---

## 4. Database history: what to store and how

### 4.1 Principles (the audit-trail rules for financial data)

1. **Money records are never edited or deleted.** A mistake is fixed by a **reversal** entry plus a new correct entry. Balances on `Loan`, `Customer` and `Branch` are *derived totals*. The ledgers are the source of truth.
2. **Every business operation gets a `correlationId`** (e.g. `COL-40021`, `DSB-20005`). Every document written by that operation stores it, so one receipt can be traced through installment → loan → savings → vault → GL.
3. **Every record stores who, when and why:** `userId`, `userName`, `role`, `branchId`, the timestamp, `reason`, and optionally the device / app version.
4. **Write ledgers in the same transaction** as the balance they change, so they can never disagree.
5. **Firestore rules enforce append-only:** `allow update, delete: if false;` on ledger and audit collections.
6. **Closed periods are locked.** After day-end or month-end, writes dated in that period are rejected.

### 4.2 Move `history[]` out of the documents

The `history: EditHistoryEntry[]` array inside each customer, loan and branch keeps growing, and full `previousData` snapshots are stored every time. A busy branch document (vault updates on every closing) or loan document will eventually hit Firestore's **1 MiB** limit, and every list read downloads all of that history.

**Change:**
- Write audit entries to a top-level `auditLogs` collection, or a `history` subcollection per entity: `{ entityType, entityId, action, changedFields, before, after, reason, actor, timestamp, correlationId }`.
- Store **only the changed fields** in `before` / `after`, not the whole document.
- `HistoryModalComponent` queries `auditLogs where entityType == X and entityId == Y orderBy timestamp`.
- Drop the global `counters/history` sequence. It's a write hotspot (about 1 write/sec per document). Audit IDs don't need to be sequential integers; an auto ID + timestamp is fine. This is an exception to AGENTS rule 3, so document it there.
- Migration: a one-time script copies existing arrays into `auditLogs`, then clears them.

### 4.3 New ledger collections

| Collection | One row per… | Key fields | Sequence (suggested) |
|---|---|---|---|
| `loanTransactions` | Every money movement on a loan | `type: DISBURSEMENT \| REPAYMENT \| REVERSAL \| ADJUSTMENT_FROM_SAVINGS \| EARLY_SETTLEMENT \| REBATE \| RESCHEDULE \| WRITE_OFF \| WRITE_OFF_RECOVERY \| INSURANCE_WAIVER`, `principal`, `profit`, `balanceBefore`, `balanceAfter`, `receiptId?`, `correlationId` | `70001+` |
| `vaultTransactions` | Every branch cash movement | `branchId`, `type: CLOSING_IN \| DISBURSEMENT_OUT \| BANK_DEPOSIT \| BANK_WITHDRAW \| EXPENSE \| HO_TRANSFER_IN \| HO_TRANSFER_OUT \| OPENING`, `amount`, `balanceBefore`, `balanceAfter`, `refId` | `80001+` |
| `feeTransactions` | Admission, passbook, form and insurance fees | `customerId`, `loanId?`, `feeType`, `amount`, `receiptNo` | `90001+` |
| `expenses` | Branch expenses | `branchId`, `head`, `amount`, `voucherNo`, `approvedBy`, `attachmentUrl` | `91001+` |
| `journalEntries` (when the GL is added) | Double-entry postings | `date`, `lines: { accountCode, debit, credit }[]`, `correlationId` | `100001+` |

`savingsTransactions` already exists and follows this pattern (`previousBalance` / `newBalance`). Add `accountId` and `correlationId` to it.

### 4.4 State-change history (who moved what, when)

| Collection | Why |
|---|---|
| `loanStatusHistory` | APPLIED → FIELD_VERIFIED → APPROVED → DISBURSED → OVERDUE → CLOSED / WRITTEN_OFF, with actor and reason at each step. Needed for maker-checker audits. |
| `memberTransfers` | Samity / branch / FO changes for a member, with dates. |
| `staffAssignments` | Which FO handled which samity, and which BM / cashier ran which branch, from when to when. Needed to attribute old collections and shortages to the right person. |
| `creditScoreHistory` | Why a member became RISKY or BLACKLISTED, and who approved it. |
| `documentVersions` | KYC document uploads. Keep old NID / photo files instead of overwriting them. |

### 4.5 Security & access history

| Collection | Why |
|---|---|
| `loginEvents` | Login / logout / failed attempts with user, time and device (fits with the auth work you're doing). |
| `permissionChanges` | Role and permission edits are high-risk. Already partly covered by role `history[]`; move these to `auditLogs`. |
| `smsLogs` | What was sent to which number, and delivery status (proof of notification). |

### 4.6 Snapshots & period closing

| Collection | Why |
|---|---|
| `dailyBranchSummaries/{branchId}_{date}` | Written at day-end: opening and closing vault, collections, disbursements, expenses, PAR, new members. Makes the dashboard cheap (fixes 2.15) and freezes figures. |
| `periodClosings` | `{ branchId, periodType: DAY \| MONTH, date, closedBy, closedAt }`. The service rejects writes into closed periods. |
| `monthlyPortfolioSnapshots` | Classification, provision and outstanding per branch at month-end, for MRA reports and trends. |

### 4.7 New counter sequences

Add to `EntitySequence` and `STARTING_SEQUENCES` in `counter.service.ts`, and to `scripts/seed-database.js` (which must stop overwriting existing counters; see 2.11):

```ts
loanTransactions: 70001,
vaultTransactions: 80001,
feeTransactions: 90001,
expenses: 91001,
journalEntries: 100001,
```

> Note: these ranges are only starting points. Once customers pass 9,999, customer IDs move into the loan range (20001+). That's harmless, because they're separate collections, but always show IDs with their prefix (`CUST-`, `LN-`, `RCP-`) in the UI and on printouts.

---

## 5. Suggested order of work

| Phase | Contents | Outcome |
|---|---|---|
| **1. Safe money** | 2.2 rules, 2.3 role guards, 2.4 atomic collection, 2.5 rounding, 2.6 partial payments, receipt reversal (3.5), period lock (3.6) | Balances can't drift or be double-collected |
| **2. Real branch day** | 2.7 overdue engine, 2.8 due-date eligibility, 2.9 + vault ledger, bank and expenses (3.6), day-end closing, nominee, KYC upload, NID checks, admission fees | A branch can run a full day and close its books |
| **3. Audit storage** | Section 4.2 (`auditLogs`), 4.3 `loanTransactions` / `vaultTransactions`, 4.4 status / assignment history, daily summaries | Every taka is traceable, documents stay small, dashboard stays fast |
| **4. Loan products** | Approval workflow, loan cycle, grace period, holidays, declining rate, early settlement, advance payments | Matches how BD MFIs design products |
| **5. Regulator & growth** | Classification and provision, savings accounts / DPS / interest, rescheduling, write-off, insurance claims, MRA reports, SMS, bKash verification, offline PWA, GL | Ready for MRA reporting and multiple branches |

---

## 6. Questions to answer before building

1. **Regulator:** MRA-licensed MFI, cooperative, or informal lender? (Section 0)
2. **Service charge:** flat, declining, or both? Which effective annual rate do you disclose?
3. **Late fees:** do you charge them at all? If yes, what are the rule and the waiver authority?
4. **Savings:** which products (compulsory only, or also voluntary / DPS / FDR)? Interest rate and posting frequency?
5. **Insurance / risk fund:** what does `insuranceFeePaid` cover, and what happens on a borrower's death?
6. **Approval limits:** up to what amount can a BM approve before the area manager or head office must?
7. **Weekly holiday:** is Friday off for every samity, and are there branch-specific holidays?
8. **Day-end:** who closes the day (cashier or BM), and can a closed day ever be reopened (with head-office approval)?
