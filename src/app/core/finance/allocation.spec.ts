import { InstallmentSchedule, InstallmentStatus } from '../models/database.models';
import { allocatePayment, collectionView, isSettledStatus, remainingOf } from './allocation';

function inst(no: number, dueDate: string, over: Partial<InstallmentSchedule> = {}): InstallmentSchedule {
  return {
    installmentId: 30000 + no,
    loanId: 20001,
    customerId: 10001,
    branchId: 1,
    centerId: 101,
    fieldOfficerUserId: 502,
    installmentNo: no,
    dueDate,
    expectedPrincipal: 500,
    expectedProfit: 100,
    expectedSavings: 50,
    expectedTotalAmount: 650,
    paidPrincipal: 0,
    paidProfit: 0,
    paidSavings: 0,
    paidTotalAmount: 0,
    status: 'PENDING',
    history: [],
    ...over
  } as InstallmentSchedule;
}

const TODAY = '2026-10-22';
const schedule = () => [inst(3, '2026-10-29'), inst(1, '2026-10-15', { status: 'OVERDUE' }), inst(2, '2026-10-22')];

describe('finance/allocation', () => {
  it('isSettledStatus / remainingOf', () => {
    for (const s of ['PAID', 'ADVANCE', 'WAIVED', 'RESCHEDULED'] as InstallmentStatus[]) expect(isSettledStatus(s)).toBe(true);
    for (const s of ['PENDING', 'PARTIAL', 'OVERDUE'] as InstallmentStatus[]) expect(isSettledStatus(s)).toBe(false);
    expect(remainingOf(inst(1, TODAY, { paidProfit: 100, paidPrincipal: 200, status: 'PARTIAL' }))).toEqual({ principal: 300, profit: 0, total: 300 });
    expect(remainingOf(inst(1, TODAY, { status: 'PAID' })).total).toBe(0);
  });

  it('partial payment → PARTIAL on the oldest installment, profit before principal', () => {
    const r = allocatePayment(schedule(), 50, 0, TODAY);
    expect(r.allocations.length).toBe(1);
    expect(r.allocations[0]).toMatchObject({ installmentNo: 1, profit: 50, principal: 0, previousStatus: 'OVERDUE', newStatus: 'PARTIAL' });
    expect(r.unallocated).toBe(0);
  });

  it('covers the oldest fully before moving to the next', () => {
    const r = allocatePayment(schedule(), 650, 0, TODAY);
    expect(r.allocations.map(a => [a.installmentNo, a.profit, a.principal, a.newStatus])).toEqual([
      [1, 100, 500, 'PAID'],
      [2, 50, 0, 'PARTIAL']
    ]);
    expect(r.profitTotal).toBe(150);
    expect(r.principalTotal).toBe(500);
  });

  it('continues a previously partial installment from where it left off', () => {
    const list = [inst(1, '2026-10-15', { paidProfit: 100, paidPrincipal: 100, status: 'PARTIAL' }), inst(2, '2026-10-29')];
    const r = allocatePayment(list, 450, 0, TODAY);
    expect(r.allocations[0]).toMatchObject({ installmentNo: 1, profit: 0, principal: 400, newStatus: 'PAID' });
    expect(r.allocations[1]).toMatchObject({ installmentNo: 2, profit: 50, principal: 0, newStatus: 'PARTIAL' });
  });

  it('due-today fully paid → PAID, future-dated fully paid → ADVANCE', () => {
    const r = allocatePayment(schedule(), 1800, 0, TODAY);
    expect(r.allocations.map(a => a.newStatus)).toEqual(['PAID', 'PAID', 'ADVANCE']);
    expect(r.unallocated).toBe(0);
  });

  it('reports unallocated amount when overpaid', () => {
    const r = allocatePayment(schedule(), 2000, 0, TODAY);
    expect(r.principalTotal + r.profitTotal).toBe(1800);
    expect(r.unallocated).toBe(200);
  });

  it('skips settled and deleted installments', () => {
    const list = [
      inst(1, '2026-10-08', { status: 'PAID' }),
      inst(2, '2026-10-15', { isDeleted: true } as Partial<InstallmentSchedule>),
      inst(3, '2026-10-22')
    ];
    const r = allocatePayment(list, 600, 0, TODAY);
    expect(r.allocations.map(a => a.installmentNo)).toEqual([3]);
    expect(r.allocations[0].newStatus).toBe('PAID');
  });

  it('attaches savings to the first allocated installment; savings-only keeps status', () => {
    const r = allocatePayment(schedule(), 650, 50, TODAY);
    expect(r.allocations[0].savings).toBe(50);
    expect(r.allocations[1].savings).toBe(0);
    expect(r.savingsTotal).toBe(50);

    const s = allocatePayment(schedule(), 0, 50, TODAY);
    expect(s.allocations.length).toBe(1);
    expect(s.allocations[0]).toMatchObject({ installmentNo: 1, principal: 0, profit: 0, savings: 50, previousStatus: 'OVERDUE', newStatus: 'OVERDUE' });
  });

  it('negative amounts allocate nothing', () => {
    const r = allocatePayment(schedule(), -100, -10, TODAY);
    expect(r.allocations).toEqual([]);
    expect(r.unallocated).toBe(0);
  });

  describe('collectionView', () => {
    const dayKey = (iso: string) => iso.slice(0, 10);

    it('due = overdue + today, next = oldest open', () => {
      const v = collectionView(schedule(), TODAY, dayKey);
      expect(v.dueAmount).toBe(1200);
      expect(v.dueSavings).toBe(100);
      expect(v.dueInstallments.map(i => i.installmentNo)).toEqual([1, 2]);
      expect(v.overdueCount).toBe(1);
      expect(v.hasDue).toBe(true);
      expect(v.nextInstallment?.installmentNo).toBe(1);
      expect(v.totalOutstanding).toBe(1800);
      expect(v.collectedToday).toBe(false);
    });

    it('nothing due before the next due date; collectedToday from paidDate', () => {
      const list = [inst(1, '2026-10-15', { status: 'PAID', paidDate: '2026-10-22T05:00:00.000Z' }), inst(2, '2026-10-29')];
      const v = collectionView(list, TODAY, dayKey);
      expect(v.hasDue).toBe(false);
      expect(v.dueAmount).toBe(0);
      expect(v.overdueCount).toBe(0);
      expect(v.nextInstallment?.installmentNo).toBe(2);
      expect(v.collectedToday).toBe(true);
      expect(v.totalOutstanding).toBe(600);
    });
  });
});
