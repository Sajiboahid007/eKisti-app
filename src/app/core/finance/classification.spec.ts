import { InstallmentSchedule, Loan } from '../models/database.models';
import { classificationRule, classify, loanOverdueState, outstandingPrincipal, portfolioQuality, recoveryRates } from './classification';

function inst(no: number, dueDate: string, over: Partial<InstallmentSchedule> = {}): InstallmentSchedule {
  return {
    installmentId: 30000 + no, loanId: 20001, customerId: 10001, branchId: 1, centerId: 101, fieldOfficerUserId: 502,
    installmentNo: no, dueDate,
    expectedPrincipal: 500, expectedProfit: 100, expectedSavings: 0, expectedTotalAmount: 600,
    paidPrincipal: 0, paidProfit: 0, paidSavings: 0, paidTotalAmount: 0,
    status: 'PENDING', history: [], ...over
  } as InstallmentSchedule;
}

function loan(over: Partial<Loan>): Loan {
  return { loanId: 20001, status: 'DISBURSED', principalAmount: 10000, totalRepayableAmount: 12000, outstandingBalance: 0, ...over } as Loan;
}

describe('finance/classification', () => {
  it('classify boundaries', () => {
    const cases: [number, string][] = [
      [0, 'STANDARD'], [1, 'WATCHFUL'], [30, 'WATCHFUL'], [31, 'SUBSTANDARD'], [180, 'SUBSTANDARD'],
      [181, 'DOUBTFUL'], [365, 'DOUBTFUL'], [366, 'BAD'], [5000, 'BAD']
    ];
    for (const [days, cls] of cases) expect(classify(days).classification).toBe(cls);
    expect(classificationRule('BAD').provisionRate).toBe(1);
    expect(classificationRule(undefined).classification).toBe('STANDARD');
  });

  describe('loanOverdueState', () => {
    it('counts only open installments due before today', () => {
      const list = [
        inst(1, '2026-10-01', { status: 'PAID' }),
        inst(2, '2026-10-08', { status: 'PARTIAL', paidProfit: 100, paidPrincipal: 200 }),
        inst(3, '2026-10-15'),
        inst(4, '2026-10-22'),
        inst(5, '2026-10-29')
      ];
      const s = loanOverdueState(list, '2026-10-22');
      expect(s.missedInstallmentsCount).toBe(2);
      expect(s.overdueAmount).toBe(300 + 600);
      expect(s.oldestOverdueDate).toBe('2026-10-08');
      expect(s.daysPastDue).toBe(14);
      expect(s.classification).toBe('WATCHFUL');
      expect(s.overdueInstallmentIds).toEqual([30002, 30003]);
    });

    it('no overdue → STANDARD with 0 DPD', () => {
      const s = loanOverdueState([inst(1, '2026-10-22'), inst(2, '2026-10-29')], '2026-10-22');
      expect(s).toMatchObject({ overdueAmount: 0, missedInstallmentsCount: 0, daysPastDue: 0, oldestOverdueDate: null, classification: 'STANDARD' });
    });

    it('long overdue → SUBSTANDARD / BAD', () => {
      expect(loanOverdueState([inst(1, '2026-08-01')], '2026-10-22').classification).toBe('SUBSTANDARD');
      expect(loanOverdueState([inst(1, '2025-01-01')], '2026-10-22').classification).toBe('BAD');
    });
  });

  it('outstandingPrincipal', () => {
    expect(outstandingPrincipal(loan({ outstandingPrincipal: 4000 }))).toBe(4000);
    expect(outstandingPrincipal(loan({ outstandingBalance: 6000 }))).toBe(5000);
    expect(outstandingPrincipal(loan({ status: 'CLOSED', outstandingPrincipal: 4000 }))).toBe(0);
  });

  it('portfolioQuality PAR and provision', () => {
    const q = portfolioQuality([
      loan({ loanId: 1, outstandingPrincipal: 10000, daysPastDue: 0 }),
      loan({ loanId: 2, outstandingPrincipal: 5000, daysPastDue: 5, status: 'OVERDUE' }),
      loan({ loanId: 3, outstandingPrincipal: 5000, daysPastDue: 40, status: 'OVERDUE' }),
      loan({ loanId: 4, outstandingPrincipal: 9999, daysPastDue: 99, status: 'CLOSED' }),
      loan({ loanId: 5, outstandingPrincipal: 9999, daysPastDue: 99, isDeleted: true } as Partial<Loan>)
    ]);
    expect(q.loansCount).toBe(3);
    expect(q.outstandingPrincipal).toBe(20000);
    expect(q.par1Amount).toBe(10000);
    expect(q.par30Amount).toBe(5000);
    expect(q.par1Percent).toBe(50);
    expect(q.par30Percent).toBe(25);
    expect(q.requiredProvision).toBe(100 + 250 + 1250);
    expect(q.byClass.find(b => b.rule.classification === 'SUBSTANDARD')?.loans).toBe(1);
  });

  it('portfolioQuality PAR30 boundary: 30 days is not PAR30', () => {
    const q = portfolioQuality([loan({ outstandingPrincipal: 1000, daysPastDue: 30 })]);
    expect(q.par1Percent).toBe(100);
    expect(q.par30Percent).toBe(0);
  });

  it('recoveryRates OTR / CRR', () => {
    const key = (iso: string) => iso.slice(0, 10);
    const r = recoveryRates([
      inst(1, '2026-10-01', { status: 'PAID', paidPrincipal: 500, paidProfit: 100, paidDate: '2026-10-01T04:00:00Z' }),
      inst(2, '2026-10-08', { status: 'PAID', paidPrincipal: 500, paidProfit: 100, paidDate: '2026-10-10T04:00:00Z' }),
      inst(3, '2026-10-15'),
      inst(4, '2026-10-29')
    ], '2026-10-22', key);
    expect(r.dueTotal).toBe(1800);
    expect(r.collected).toBe(1200);
    expect(r.onTimeCollected).toBe(600);
    expect(r.crrPercent).toBe(66.67);
    expect(r.otrPercent).toBe(33.33);
  });
});
