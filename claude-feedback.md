# eKisti — Project Review (Claude)

**Date:** 2026-10-22
**Scope:** Whole repo at `main` plus uncommitted working-tree changes (customer-list refactor, deleted `customer-register-form`).
**Method:** Read the core services, guards, routes, and the money-moving components (loan disburse/detail, daily sheet, cash closing, dashboard). Ran a dev build, a production build, and the test suite. Each finding below links to the code it's based on. Anything I inferred rather than ran is marked as an inference.

---

## TL;DR

The domain model is good. Customers, loans, installments, receipts, savings and branch/samity are the right entities with the right fields, the UI is bilingual and has a lot of features, and the app **builds cleanly**. But the system **isn't safe to use with real money yet**, for three reasons:

1. **There's no real authentication or authorization.** Anyone can log in as anyone, and every permission check runs in the browser.
2. **Money operations aren't atomic.** A single collection takes 5+ separate Firestore writes. A failure or a concurrent user part-way through leaves balances inconsistent.
3. **Some ledger math is wrong.** Rounding can leave loans that never close. Partial payments are marked `PAID`. Overdue status is never computed.

Fix those three before adding features.

### Verified build/test status

| Check | Result |
|---|---|
| `ng build --configuration development` | ✅ Passes, no diagnostics |
| `ng build` (production) | ⚠️ Passes with budget warning: `customer-list.component.scss` is **45 kB** (budget 25 kB, hard error at 50 kB, so one more feature will break the build) |
| `ng test` | ❌ **2/2 tests fail** with `NG0201: No provider found for Firestore` (`AuthStateService -> Firestore`). The spec also still asserts the CLI scaffold text `Hello, eKisti-app`. |

> Note: the existing `feedback.md` says the test failure is `ReferenceError: describe is not defined`. That's not what happens today: the runner works, but the spec has no Firestore provider and is stale.

---

## 🔴 P0 — Critical (fix before any real use)

### 1. Login accepts any user without a password, and the session can be forged
- [auth-state.service.ts:390](src/app/core/services/auth-state.service.ts#L390): `login()` ignores `password` and matches `u.name.toLowerCase().includes(cleanId)`. Typing a single letter like `a` logs you in as the first staff member whose name contains it.
- [auth-state.service.ts:165](src/app/core/services/auth-state.service.ts#L165): the session is read straight from `localStorage`. If the userId isn't a preset, the parsed object is trusted as-is. Editing `ekisti_user_session` in DevTools to `{"userId":999,"role":"SUPER_ADMIN",...}` grants super admin.
- `provideAuth()` is configured in [app.config.ts](src/app/app.config.ts) but Firebase Auth is never used.
- **Fix:** Use Firebase Auth (email/password or phone OTP). Store `role`/`branchId` as **custom claims** set by a trusted backend (Cloud Function / Admin SDK), and derive `currentUser` from `onAuthStateChanged`. Keep the 1-click demo logins behind an `environment.demoMode` flag.

### 2. No Firestore security rules in the repo, and the database is very likely open
- No `firestore.rules` / `firebase.json` is checked in.
- *Inference:* [scripts/seed-database.js](scripts/seed-database.js) writes with the **client** SDK and no sign-in. That only works if the rules allow unauthenticated writes. If so, anyone with the public web config (it ships in every JS bundle) can read every customer's NID, phone and address, and rewrite loan balances.
- **Fix:** Commit `firestore.rules` that require `request.auth`, scope reads/writes by `request.auth.token.branchId`, and make `counters`, `collections` (receipts), and `history` append-only. Move seeding to the Admin SDK.

### 3. Route guards only check "logged in", not role
- [app.routes.ts](src/app/app.routes.ts): `/loans/disburse`, `/reconciliation`, `/collections/daily` and `/branches` use only `authGuard`. The sidebar hides links by role, but a Field Officer can type `/loans/disburse` and disburse a loan, or open `/reconciliation` and accept cash into the vault.
- `canDisburseLoan`, `canVerifyCash`, etc. exist in `AuthStateService` but are only used to hide buttons.
- **Fix:** Add a `permissionGuard(perm)` and apply it per route. Also enforce the same rules in Firestore rules, because client guards are UX, not security.

### 4. Collection flow isn't atomic and can double-collect
A single kisti collection does, in order: counter txn (receipt), counter txn (history), `setDoc` receipt, `getDoc`+`updateDoc` loan, `getDoc`+`updateDoc` customer, counter txn (savings), counter txn (history), `setDoc` savings txn, `getDoc`+`updateDoc` customer *again*, then (in the component) counter txn (history), `getDoc`+`updateDoc` installment.
- [kisti-database.service.ts:341](src/app/core/services/kisti-database.service.ts#L341) and [daily-sheet.component.ts:320-360](src/app/features/collections/daily-sheet/daily-sheet.component.ts#L320)
- **Failure scenario:** The network drops after the loan balance is updated but before the installment is marked `PAID`. The installment stays `PENDING` and the sheet lets the FO collect it again. The loan is now credited twice.
- **Race scenario:** Two users collect on the same loan at once. Both read `totalPaidAmount = X` and both write `X + 673`, so one payment is lost from the loan balance even though two receipts exist.
- **Fix:** Move the installment update into `collectPayment()` and do the whole thing in **one `runTransaction`**. Allocate IDs inside the same transaction, or switch counters to a single transaction per operation. Use `increment()` for balances. Reject the write if `installment.status !== 'PENDING'` inside the transaction.

### 5. Cash closing is hardcoded to branch 1 and loses updates
- [cash-closing.component.ts:36](src/app/features/reconciliation/cash-closing/cash-closing.component.ts#L36) and [:87](src/app/features/reconciliation/cash-closing/cash-closing.component.ts#L87): it always reads and writes `branches/1`, regardless of the cashier's branch.
- [:42](src/app/features/reconciliation/cash-closing/cash-closing.component.ts#L42): it loads **every receipt from every branch**, including soft-deleted ones (no `isDeleted` filter), and lets them be accepted into the vault.
- The vault update is `currentVault + amount` using the value loaded when the page opened. Two quick accepts, or two cashiers, overwrite each other.
- bKash/Nagad/Bank receipts are added to **physical vault cash**.
- No `DailyReconciliation` record is ever created. The `reconciliations` counter exists but is unused, so the `ক্যাশ ক্লোজিং` model in AGENTS.md is aspirational.
- **Fix:** Scope by `currentUser.branchId`. Filter `isDeleted` and `paymentMethod === 'CASH'`. Update the vault and the receipt in one transaction with `increment()`. Create a `DailyReconciliation` doc per FO per day (target vs actual vs handed over).

---

## 🟠 P1 — High (financial correctness)

### 6. Rounding can leave a loan that never closes
`installmentAmount = Math.round(totalRepayable / count)` ([loan-disburse.component.ts:117](src/app/features/loans/loan-disburse/loan-disburse.component.ts#L117)), and every installment uses the same amount ([kisti-database.service.ts:244](src/app/core/services/kisti-database.service.ts#L244)).
- **Concrete case:** 25,000 Tk, weekly, 40 installments, 10% flat. The effective rate is 7.7%, so profit is 1,925 and the total is 26,925. 26,925 / 40 = 673.125, rounded to **673**, and 673 × 40 = 26,920. After all 40 installments are paid, `outstandingBalance = 5`, no `PENDING` installment remains, and the loan stays `DISBURSED` forever.
- When rounding goes up instead (e.g. 20,000 → 539 × 40 = 21,560 vs 21,540), the customer is overcharged.
- The per-installment principal/profit split also drifts: `expectedProfit` sums to 1,920, not 1,925.
- **Fix:** Put the remainder into the **last installment** (for both principal and profit). Do money math in integer poisha, or at least reconcile the last row.

### 7. Partial payments are recorded as fully `PAID`
- [loan-detail.component.ts:236](src/app/features/loans/loan-detail/loan-detail.component.ts#L236): any amount greater than 0 sets `status: 'PAID'`. Collecting 100 Tk against a 673 Tk installment closes that installment.
- [daily-sheet.component.ts:317-331](src/app/features/collections/daily-sheet/daily-sheet.component.ts#L317): the modal lets the user edit `collectAmount`, but the receipt always records `expectedPrincipal`/`expectedProfit` while `totalAmountCollected` uses the edited value. The receipt's components then don't add up to its total, and the loan is credited with the full expected amount.
- [kisti-database.service.ts:381](src/app/core/services/kisti-database.service.ts#L381): `paidInstallmentsCount + 1` on every receipt, regardless of amount.
- **Fix:** Use `PARTIAL` (it's already in the model). Carry the shortfall to the same installment. Only increment the paid count when an installment becomes fully paid.

### 8. Overdue and default status are never computed
`OVERDUE`, `DEFAULTED`, `PARTIAL`, `overdueAmount` and `missedInstallmentsCount` are read in many places but **never written** anywhere. The dashboard's "বকেয়া" (overdue) KPI and the loan list's overdue filter will always show 0.
- **Fix:** Add a day-start job (Cloud Function scheduled at 00:05 Asia/Dhaka) that marks past-due `PENDING` installments as `OVERDUE` and rolls `overdueAmount` and `missedInstallmentsCount` up to the loan.

### 9. The 7-day lockout applies to every frequency, and loan-detail bypasses it
- [daily-sheet.component.ts:238](src/app/features/collections/daily-sheet/daily-sheet.component.ts#L238): `daysSinceLast < 7` applies to **daily** loans too. A daily-kisti customer can only pay once a week from the field sheet, so it can't be used for daily loans. For monthly loans it allows 4 payments a month.
- [loan-detail.component.ts:130](src/app/features/loans/loan-detail/loan-detail.component.ts#L130) ignores the lock completely, so the two screens enforce different rules.
- **Fix:** Base eligibility on `installment.dueDate` vs today (and allow advance payments explicitly as `ADVANCE`), not on time since the last payment. Put the rule in the service so both screens share it.

### 10. Disbursement side effects are missing
- The branch `currentVaultCash` isn't reduced when cash is disbursed.
- The customer's `activeLoansCount` and `totalLoansTaken` aren't updated.
- There's no approval workflow: loans are created straight into `DISBURSED` with `approvedByUserId = self`. That defeats maker-checker, which matters most in microfinance.
- A custom `loanAccountNo` has no uniqueness check, and [updateLoanAccountNo](src/app/core/services/kisti-database.service.ts#L299) writes **no audit history**, which breaks AGENTS.md rule #4.

### 11. Running the seed script again corrupts an existing database
[seed-database.js:28-38](scripts/seed-database.js#L28) resets every counter to its baseline (`customers: 10001`, `loans: 20001`, …). If you run `npm run db:seed` on a database that already has data, the next `createCustomer()` gets ID `10002` and `setDoc` **silently overwrites** the existing customer 10002. Same for loans and installments.
- **Fix:** Refuse to run when `counters/customers` exists unless `--force` is passed, or only set counters with `max(existing, seed)`.

### 12. Dates are UTC, but the business runs on Asia/Dhaka (UTC+6)
`new Date().toISOString().split('T')[0]` is used for "today" in the dashboard, disbursement dates, due dates and `collectionDate`. Between 00:00 and 05:59 local time, "today" is yesterday, so midnight-to-6 am collections land on the wrong closing day. `setMonth(+1)` on Jan 31 jumps to Mar 3.
- **Fix:** Add a `DateService.todayDhaka()` (via `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' })`) and store business dates as `YYYY-MM-DD` strings. For monthly schedules, clamp to the last day of the month.

---

## 🟡 P2 — Medium (architecture & scale)

13. **Every list loads entire collections.** `getCustomers/getLoans/getBranches/getCenters/getStaff` call `getDocs(collection(...))` with no `where`/`limit`. The dashboard reads **all loans, all receipts, all branches and all installments** on every visit ([dashboard.component.ts](src/app/features/dashboard/dashboard.component.ts)). With 5k loans × 40 installments, that's 200k document reads per dashboard load. `getLoansByCustomerId` loads all loans and filters them in memory.
    → Query with `where('branchId','==',…)` / `where('dueDate','==',today)`, add composite indexes, and keep pre-aggregated daily/branch summary docs.
14. **N+1 queries in the daily sheet.** [daily-sheet.component.ts:191](src/app/features/collections/daily-sheet/daily-sheet.component.ts#L191) runs one `installments` query per loan, sequentially. 40 members means 40 round-trips.
    → One query: `where('centerId','==',id), where('status','in',['PENDING','OVERDUE','PARTIAL'])`.
15. **Disbursement makes 41+ serial transactions.** One counter transaction per installment ([kisti-database.service.ts:249](src/app/core/services/kisti-database.service.ts#L249)), plus one for history. A 100-installment daily loan is about 200 sequential round-trips, and failing midway leaves a loan with a partial schedule.
    → Reserve a block (`currentSequenceId += n`) in one transaction and write everything in a `writeBatch`.
16. **A global `history` counter is a hotspot.** Every write in the system runs a transaction on `counters/history`. Firestore sustains about 1 write/sec per document, so this will throttle under concurrent field use. History IDs don't need to be sequential; use the parent doc's array index or an auto-ID subcollection.
17. **Audit history is embedded in the parent document.** `history[]` grows forever and stores full `previousData` snapshots. A frequently edited customer will approach the **1 MiB document limit**, and every list read downloads the whole history. → Move it to a `history` subcollection.
18. **Firestore calls live in the components.** `DashboardComponent`, `DailySheetComponent`, `LoanDetailComponent`, `CashClosingComponent` and `ReceiptListComponent` call `getDocs`/`updateDoc` directly, which bypasses the service and its audit trail (e.g. the vault update in cash-closing writes no history). Route all writes through `KistiDatabaseService`.
19. **Dashboard isn't scoped by role.** A Field Officer sees company-wide outstanding, vault cash and recent receipts.
20. **Hardcoded data.** `assignedCenterIds: [101]` for every new FO ([user-form.component.ts:147](src/app/features/users/user-form/user-form.component.ts#L147)), `'মিরপুর শাখা'` as the default branch name in the service and auth, `selectedCenterId = signal(101)`, and `PRESET_STAFF_USERS` is mutated at runtime ([auth-state.service.ts:365](src/app/core/services/auth-state.service.ts#L365)).
21. **Dead code.** [src/app/firebase.config.ts](src/app/firebase.config.ts) initializes a second Firebase app and is imported nowhere. Delete it.
22. **Validation gaps.** There's no duplicate-NID check on customer registration, no NID/phone format validation (10/13/17-digit NID, `01[3-9]\d{8}` phone), and no check that a customer doesn't already have an active loan when one is disbursed.

---

## 🟢 P3 — Maintainability / UX

23. **SCSS size.** `customer-list.component.scss` (2,546 lines / 45 kB), `user-list.component.scss` (1,438) and `loan-disburse.component.scss` (1,076) are close to the 50 kB error budget. Move the shared print and modal styles into `styles.scss` partials.
24. **Very large templates.** `user-list.component.html` (1,647 lines) and `customer-list.component.html` (1,016) each mix the list, modals, ID card and print forms. Split them into child components (`<app-customer-passbook>`, `<app-admission-form>`, `<app-id-card>`).
25. **`alert()` / `confirm()` everywhere,** including inside a route guard ([auth.guard.ts](src/app/core/guards/auth.guard.ts)). Replace them with a toast/snackbar service. Alerts block the UI and are awkward on mobile, which is where field officers work.
26. **Mixed state patterns.** Some components use `ChangeDetectorRef.markForCheck()` together with signals and plain mutable fields (`collectAmount`, `isProcessing`). Pick signals consistently, and consider `OnPush` + zoneless.
27. **Unmanaged subscriptions.** `route.queryParams.subscribe` in `user-form`/`user-list` isn't cleaned up. Use `takeUntilDestroyed()` or `toSignal()`.
28. **Line endings.** The working-tree diff on `customer-list.component.html` shows 1,017+/1,036− lines, but `git diff -w` shows only **19 real deletions**. The rest is CRLF/LF churn. Add a `.gitattributes` (`* text=auto eol=lf`) before committing, or the history becomes unreadable.
29. **AGENTS.md drift.** It mentions FO `504` as seeded (the seed only creates 501–503; 504 exists only as an in-memory preset), `DailyReconciliation` (never created), and "offline-ready" collection (Firestore offline persistence is never enabled; `getFirestore()` is called with default settings). Docs that overstate features will mislead future agents.
30. **No real tests.** The money paths that most need tests are all pure functions waiting to be extracted: schedule generation, profit calculation, partial-payment allocation, lockout eligibility, and overdue rollup. Pull them out of components into `core/finance/*.ts` and unit-test them with Vitest. Add `@firebase/rules-unit-testing` once rules exist.

---

## What's good (keep doing this)

- **Domain modelling:** The Branch → Samity → Customer → Loan → Installment → Receipt hierarchy, dual guarantors, collateral, and savings ledger with `previousBalance/newBalance` are well thought out and match how Bangladeshi MFIs actually operate.
- **Angular usage:** 100% standalone, lazy-loaded routes, `@if`/`@for` control flow, signals and `computed` for calculators, and `strict` + `strictTemplates` on. The build is clean.
- **Audit intent:** Soft delete plus `EditHistoryEntry` with reason, actor and before/after snapshots is the right idea for a financial system. It needs better storage (see #17), not removal.
- **Print engine:** The A4 admission form, disbursement voucher and ID card with dedicated `@media print` rules are a real differentiator for branches that still keep paper files.
- **Bilingual UX:** Consistent Bengali domain terminology throughout.

---

## Suggested order of work

| Phase | Items | Outcome |
|---|---|---|
| **1. Lock it down** | #1, #2, #3 | Real auth, rules in repo, role-based routes |
| **2. Make money correct** | #4, #5, #6, #7, #11 | Atomic collection/closing, correct rounding, partial payments, safe seeding |
| **3. Close domain gaps** | #8, #9, #10, #12 | Overdue engine, frequency-aware eligibility, approval workflow, Dhaka dates |
| **4. Scale** | #13–#17 | Scoped queries, no N+1, batched disbursement, history subcollection |
| **5. Clean up** | #18–#30 | Service layering, component split, tests, docs |

Phases 1–2 are the minimum before a pilot branch uses the system with real cash.
