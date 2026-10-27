import { describe, expect, it } from 'vitest';
import { buildSchedule } from './schedule';
import { allocatePayment } from './allocation';
import { earlySettlementQuote } from './settlement';
import { addDaysKey, addMonthsKey, diffDaysKey } from './dates';
import { isValidBdMobile, isValidBdNid, normalizeBdMobile, normalizeNid } from './validation';
import { InstallmentSchedule } from '../models/database.models';

describe('QA Deep Audit — Edge Cases & Extreme Scenarios', () => {

  describe('1. Loan Schedule Odd Divisibility & Conservation of Money', () => {
    it('10,000 principal split into 3 installments must sum exactly to 10,000 (no penny lost)', () => {
      const schedule = buildSchedule({
        principal: 10000,
        ratePercent: 0,
        method: 'FLAT',
        count: 3,
        frequency: 'MONTHLY',
        firstDueDate: '2026-11-01'
      });

      const sumPrincipal = schedule.rows.reduce((s, r) => s + r.principal, 0);
      expect(sumPrincipal).toBe(10000);
      expect(schedule.totalPrincipal).toBe(10000);
      expect(schedule.totalRepayable).toBe(10000);
      // Rows should be 3333, 3333, 3334
      expect(schedule.rows[0].principal).toBe(3333);
      expect(schedule.rows[1].principal).toBe(3333);
      expect(schedule.rows[2].principal).toBe(3334);
    });

    it('15,000 principal at 13.33% interest in 7 installments must sum exactly', () => {
      const schedule = buildSchedule({
        principal: 15000,
        ratePercent: 13.33,
        method: 'FLAT',
        count: 7,
        frequency: 'WEEKLY',
        firstDueDate: '2026-11-01'
      });

      const sumPrincipal = schedule.rows.reduce((s, r) => s + r.principal, 0);
      const sumProfit = schedule.rows.reduce((s, r) => s + r.profit, 0);
      const sumTotal = schedule.rows.reduce((s, r) => s + r.total, 0);

      expect(sumPrincipal).toBe(15000);
      expect(sumTotal).toBe(sumPrincipal + sumProfit);
      expect(schedule.totalRepayable).toBe(sumTotal);
    });

    it('Declining balance method edge cases: 0% interest and high interest', () => {
      const zeroInterest = buildSchedule({
        principal: 12000,
        ratePercent: 0,
        method: 'DECLINING',
        count: 12,
        frequency: 'MONTHLY',
        firstDueDate: '2026-11-01'
      });
      const sumPrincipalZero = zeroInterest.rows.reduce((s, r) => s + r.principal, 0);
      expect(sumPrincipalZero).toBe(12000);
      expect(zeroInterest.totalProfit).toBe(0);

      const highInterest = buildSchedule({
        principal: 50000,
        ratePercent: 48,
        method: 'DECLINING',
        count: 24,
        frequency: 'MONTHLY',
        firstDueDate: '2026-11-01'
      });
      const sumPrincipalHigh = highInterest.rows.reduce((s, r) => s + r.principal, 0);
      expect(sumPrincipalHigh).toBe(50000);
      expect(highInterest.rows[highInterest.rows.length - 1].principal).toBeGreaterThan(0);
    });
  });

  describe('2. Date Arithmetic & Leap Years (Asia/Dhaka timezone)', () => {
    it('handles leap year 2028: Feb 28 + 1 day = Feb 29, Feb 29 + 1 day = Mar 1', () => {
      expect(addDaysKey('2028-02-28', 1)).toBe('2028-02-29');
      expect(addDaysKey('2028-02-29', 1)).toBe('2028-03-01');
    });

    it('handles non-leap year 2026: Feb 28 + 1 day = Mar 1', () => {
      expect(addDaysKey('2026-02-28', 1)).toBe('2026-03-01');
    });

    it('clamps month overflow: Jan 31 + 1 month = Feb 28 (non-leap) and Feb 29 (leap)', () => {
      expect(addMonthsKey('2026-01-31', 1)).toBe('2026-02-28');
      expect(addMonthsKey('2028-01-31', 1)).toBe('2028-02-29');
      expect(addMonthsKey('2026-03-31', 1)).toBe('2026-04-30');
    });

    it('diffDaysKey calculates exact calendar days regardless of DST', () => {
      expect(diffDaysKey('2026-01-01', '2026-01-10')).toBe(9);
      expect(diffDaysKey('2026-10-01', '2026-11-01')).toBe(31);
    });
  });

  describe('3. Payment Allocation & Multi-Installment Cascading', () => {
    const mockInst = (id: number, no: number, due: string, pExp: number, prExp: number, sExp = 50): InstallmentSchedule => ({
      installmentId: id,
      loanId: 20001,
      customerId: 10001,
      branchId: 1,
      centerId: 101,
      fieldOfficerUserId: 502,
      installmentNo: no,
      dueDate: due,
      expectedPrincipal: pExp,
      expectedProfit: prExp,
      expectedSavings: sExp,
      expectedTotalAmount: pExp + prExp + sExp,
      paidPrincipal: 0,
      paidProfit: 0,
      paidSavings: 0,
      paidTotalAmount: 0,
      status: 'PENDING',
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    } as InstallmentSchedule);

    it('prioritizes profit before principal in partial payments', () => {
      const schedule = [mockInst(30001, 1, '2026-10-20', 500, 100)];
      const res = allocatePayment(schedule, 80, 0, '2026-10-25');
      expect(res.profitTotal).toBe(80);
      expect(res.principalTotal).toBe(0);
      expect(res.allocations[0].newStatus).toBe('PARTIAL');
    });

    it('handles floating-point precision on final penny/paisa payment (500 - 499.90 = 0.10)', () => {
      // Installment where 499.90 was already paid, leaving 0.10 expected principal
      const schedule = [mockInst(30001, 1, '2026-10-20', 500, 0)];
      schedule[0].paidPrincipal = 499.90;
      schedule[0].status = 'PARTIAL';

      const res = allocatePayment(schedule, 0.10, 0, '2026-10-25');
      expect(res.allocations[0].newStatus).toBe('PAID'); // Must NOT get stuck in PARTIAL
      expect(res.unallocated).toBe(0);
    });

    it('cascades excess amount across multiple installments (overdue -> current -> advance)', () => {
      const schedule = [
        mockInst(30001, 1, '2026-10-15', 500, 100), // Overdue
        mockInst(30002, 2, '2026-10-22', 500, 100), // Due
        mockInst(30003, 3, '2026-10-29', 500, 100)  // Future / Advance
      ];

      // Member pays 1500 taka loan amount on 2026-10-22
      const res = allocatePayment(schedule, 1500, 0, '2026-10-22');
      expect(res.allocations.length).toBe(3);
      // 1st: fully paid (600) -> PAID
      expect(res.allocations[0].newStatus).toBe('PAID');
      expect(res.allocations[0].principal).toBe(500);
      expect(res.allocations[0].profit).toBe(100);
      // 2nd: fully paid (600) -> PAID (due today)
      expect(res.allocations[1].newStatus).toBe('PAID');
      // 3rd: partially paid (300) -> PARTIAL (remaining 300)
      expect(res.allocations[2].newStatus).toBe('PARTIAL');
      expect(res.allocations[2].profit).toBe(100);
      expect(res.allocations[2].principal).toBe(200);
    });

    it('marks future installment as ADVANCE when fully paid', () => {
      const schedule = [mockInst(30001, 1, '2026-11-05', 500, 100)];
      const res = allocatePayment(schedule, 600, 50, '2026-10-27');
      expect(res.allocations[0].newStatus).toBe('ADVANCE');
      expect(res.savingsTotal).toBe(50);
      expect(res.unallocated).toBe(0);
    });

    it('reports unallocated money when payment exceeds total loan balance', () => {
      const schedule = [mockInst(30001, 1, '2026-10-27', 500, 100)];
      const res = allocatePayment(schedule, 1000, 0, '2026-10-27');
      expect(res.allocations[0].newStatus).toBe('PAID');
      expect(res.principalTotal).toBe(500);
      expect(res.profitTotal).toBe(100);
      expect(res.unallocated).toBe(400); // 400 excess money returned
    });
  });

  describe('4. Early Settlement & Rebate Calculation', () => {
    it('calculates 50% rebate on future profit while demanding 100% of overdue profit and principal', () => {
      const schedule: InstallmentSchedule[] = [
        {
          installmentId: 30001, loanId: 20001, customerId: 10001, branchId: 1, centerId: 101, fieldOfficerUserId: 502,
          installmentNo: 1, dueDate: '2026-10-10', expectedPrincipal: 1000, expectedProfit: 200, expectedSavings: 0,
          expectedTotalAmount: 1200, paidPrincipal: 0, paidProfit: 0, paidSavings: 0, paidTotalAmount: 0,
          status: 'OVERDUE', isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: []
        },
        {
          installmentId: 30002, loanId: 20001, customerId: 10001, branchId: 1, centerId: 101, fieldOfficerUserId: 502,
          installmentNo: 2, dueDate: '2026-11-10', expectedPrincipal: 1000, expectedProfit: 200, expectedSavings: 0,
          expectedTotalAmount: 1200, paidPrincipal: 0, paidProfit: 0, paidSavings: 0, paidTotalAmount: 0,
          status: 'PENDING', isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: []
        }
      ];

      const quote = earlySettlementQuote(schedule, '2026-10-27', 50);
      expect(quote.remainingPrincipal).toBe(2000);
      expect(quote.dueProfit).toBe(200);     // 100% due, no rebate
      expect(quote.futureProfit).toBe(200);  // Unearned future profit
      expect(quote.rebate).toBe(100);        // 50% of 200 = 100 rebate
      expect(quote.payoffAmount).toBe(2300); // 2000 principal + 200 due profit + (200 future profit - 100 rebate) = 2300
    });
  });

  describe('5. Bangladeshi KYC & Mobile Validation', () => {
    it('validates 10-digit Smart NID, 13-digit legacy NID, and 17-digit birth-prefixed NID', () => {
      expect(isValidBdNid('1234567890')).toBe(true);        // 10 digits
      expect(isValidBdNid('1234567890123')).toBe(true);     // 13 digits
      expect(isValidBdNid('19901234567890123')).toBe(true); // 17 digits

      // Invalid lengths
      expect(isValidBdNid('123456789')).toBe(false);        // 9 digits
      expect(isValidBdNid('12345678901')).toBe(false);       // 11 digits
      expect(isValidBdNid('12345678901234')).toBe(false);    // 14 digits
    });

    it('validates Bengali unicode numbers for NID and mobile', () => {
      expect(isValidBdNid('১২৩৪৫৬৭৮৯০')).toBe(true);
      expect(normalizeNid('১২৩৪৫৬৭৮৯০')).toBe('1234567890');
      expect(isValidBdMobile('০১৭১২৩৪৫৬৭৮')).toBe(true);
      expect(normalizeBdMobile('০১৭১২৩৪৫৬৭৮')).toBe('01712345678');
      expect(normalizeBdMobile('+8801712345678')).toBe('01712345678');
      expect(normalizeBdMobile('8801812345678')).toBe('01812345678');
    });

    it('rejects invalid BD mobile telecom codes', () => {
      expect(isValidBdMobile('01012345678')).toBe(false); // 010 not valid BD operator
      expect(isValidBdMobile('01112345678')).toBe(false); // 011 inactive
      expect(isValidBdMobile('01212345678')).toBe(false); // 012 not valid BD operator
      expect(isValidBdMobile('0171234567')).toBe(false);  // 10 digits only (must be 11)
      expect(isValidBdMobile('017123456789')).toBe(false); // 12 digits (too long)
    });
  });
});
