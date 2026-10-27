import { InstallmentSchedule, Loan } from '../models/database.models';
import { nextCreditScore, overdueMarkerId, planOverdueRun, scoreForDaysPastDue } from './overdue';

function inst(loanId: number, no: number, dueDate: string, over: Partial<InstallmentSchedule> = {}): InstallmentSchedule {
  return {
    installmentId: loanId * 100 + no, loanId, customerId: 10001, branchId: 1, centerId: 101, fieldOfficerUserId: 502,
    installmentNo: no, dueDate,
    expectedPrincipal: 500, expectedProfit: 100, expectedSavings: 0, expectedTotalAmount: 600,
    paidPrincipal: 0, paidProfit: 0, paidSavings: 0, paidTotalAmount: 0,
    status: 'PENDING', history: [], ...over
  } as InstallmentSchedule;
}

function loan(over: Partial<Loan>): Loan {
  return { loanId: 20001, customerId: 10001, branchId: 1, status: 'DISBURSED', classification: 'STANDARD', ...over } as Loan;
}

describe('finance/overdue', () => {
  it('marks past-due PENDING installments and flips the loan to OVERDUE', () => {
    const l = loan({});
    const byLoan = new Map([[20001, [inst(20001, 1, '2026-10-01'), inst(20001, 2, '2026-10-08', { status: 'OVERDUE' }), inst(20001, 3, '2026-10-29')]]]);
    const plan = planOverdueRun([l], byLoan, '2026-10-22');

    expect(plan.loansChecked).toBe(1);
    expect(plan.installmentIdsToMark).toEqual([2000101]); // already-OVERDUE and future rows untouched
    expect(plan.loanUpdates).toHaveLength(1);
    const u = plan.loanUpdates[0];
    expect(u.status).toBe('OVERDUE');
    expect(u.statusChanged).toBe(true);
    expect(u.missedInstallmentsCount).toBe(2);
    expect(u.overdueAmount).toBe(1200);
    expect(u.daysPastDue).toBe(21);
    expect(u.classification).toBe('WATCHFUL');
    expect(plan.maxDpdByCustomer.get(10001)).toBe(21);
  });

  it('is idempotent: a loan already in the computed state produces no update', () => {
    const l = loan({ status: 'OVERDUE', overdueAmount: 600, missedInstallmentsCount: 1, daysPastDue: 7, classification: 'WATCHFUL' });
    const byLoan = new Map([[20001, [inst(20001, 1, '2026-10-15', { status: 'OVERDUE' })]]]);
    const plan = planOverdueRun([l], byLoan, '2026-10-22');
    expect(plan.loanUpdates).toEqual([]);
    expect(plan.installmentIdsToMark).toEqual([]);
  });

  it('returns a cured loan to DISBURSED', () => {
    const l = loan({ status: 'OVERDUE', overdueAmount: 600, missedInstallmentsCount: 1, daysPastDue: 7, classification: 'WATCHFUL' });
    const plan = planOverdueRun([l], new Map([[20001, [inst(20001, 4, '2026-10-29')]]]), '2026-10-22');
    expect(plan.loanUpdates[0]).toMatchObject({ status: 'DISBURSED', statusChanged: true, overdueAmount: 0, reason: 'বকেয়া পরিশোধিত' });
  });

  it('takes the worst loan per customer', () => {
    const a = loan({ loanId: 1 });
    const b = loan({ loanId: 2 });
    const byLoan = new Map([[1, [inst(1, 1, '2026-10-20')]], [2, [inst(2, 1, '2026-09-22')]]]);
    expect(planOverdueRun([a, b], byLoan, '2026-10-22').maxDpdByCustomer.get(10001)).toBe(30);
  });

  it('credit score rules', () => {
    expect(scoreForDaysPastDue(0)).toBe('GOOD');
    expect(scoreForDaysPastDue(30)).toBe('AVERAGE');
    expect(scoreForDaysPastDue(31)).toBe('RISKY');
    expect(nextCreditScore('GOOD', 0)).toBeNull();
    expect(nextCreditScore('GOOD', 45)).toBe('RISKY');
    expect(nextCreditScore('RISKY', 0)).toBe('AVERAGE');
    expect(nextCreditScore('BLACKLISTED', 0)).toBeNull();
  });

  it('marker id', () => {
    expect(overdueMarkerId(null)).toBe('overdue_ALL');
    expect(overdueMarkerId([3, 1])).toBe('overdue_1-3');
    expect(overdueMarkerId([])).toBe('overdue_NONE');
  });
});
