import { InstallmentSchedule } from '../models/database.models';
import { earlySettlementQuote } from './settlement';

function inst(no: number, dueDate: string, over: Partial<InstallmentSchedule> = {}): InstallmentSchedule {
  return {
    installmentId: 30000 + no, loanId: 20001, customerId: 10001, branchId: 1, centerId: 101, fieldOfficerUserId: 502,
    installmentNo: no, dueDate,
    expectedPrincipal: 500, expectedProfit: 100, expectedSavings: 0, expectedTotalAmount: 600,
    paidPrincipal: 0, paidProfit: 0, paidSavings: 0, paidTotalAmount: 0,
    status: 'PENDING', history: [], ...over
  } as InstallmentSchedule;
}

const TODAY = '2026-10-22';
const list = () => [
  inst(1, '2026-10-08', { status: 'PAID', paidPrincipal: 500, paidProfit: 100 }),
  inst(2, '2026-10-15', { status: 'PARTIAL', paidProfit: 40 }),
  inst(3, '2026-10-22'),
  inst(4, '2026-10-29'),
  inst(5, '2026-11-05')
];

describe('finance/settlement', () => {
  it('splits due vs future profit and applies the rebate on future profit only', () => {
    const q = earlySettlementQuote(list(), TODAY, 50);
    expect(q.remainingPrincipal).toBe(2000);
    expect(q.dueProfit).toBe(60 + 100);
    expect(q.futureProfit).toBe(200);
    expect(q.rebate).toBe(100);
    expect(q.payoffAmount).toBe(2000 + 160 + 200 - 100);
  });

  it('0% rebate = full outstanding; 100% rebate waives all future profit', () => {
    expect(earlySettlementQuote(list(), TODAY, 0).payoffAmount).toBe(2360);
    const full = earlySettlementQuote(list(), TODAY, 100);
    expect(full.rebate).toBe(200);
    expect(full.payoffAmount).toBe(2160);
  });

  it('clamps rebate percent to 0..100 and rounds to whole taka', () => {
    expect(earlySettlementQuote(list(), TODAY, 150).rebate).toBe(200);
    expect(earlySettlementQuote(list(), TODAY, -20).rebate).toBe(0);
    expect(earlySettlementQuote(list(), TODAY, 33.3).rebate).toBe(67);
  });

  it('ignores deleted / settled installments', () => {
    const q = earlySettlementQuote([
      inst(1, '2026-10-29', { status: 'WAIVED' }),
      inst(2, '2026-11-05', { isDeleted: true } as Partial<InstallmentSchedule>)
    ], TODAY, 50);
    expect(q).toEqual({ remainingPrincipal: 0, dueProfit: 0, futureProfit: 0, rebate: 0, payoffAmount: 0 });
  });
});
