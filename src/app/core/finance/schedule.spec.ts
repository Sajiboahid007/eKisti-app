import { buildDueDates, buildSchedule, buildScheduleFromTotals, effectiveAnnualRate, nextWorkingDay, WorkingCalendar } from './schedule';

describe('finance/schedule', () => {
  describe('flat schedule', () => {
    const schedule = buildSchedule({
      principal: 25000,
      ratePercent: 7.7,
      method: 'FLAT',
      count: 40,
      frequency: 'WEEKLY',
      firstDueDate: '2026-10-29'
    });

    it('25,000 @ 7.7% / 40 weekly totals exactly 26,925', () => {
      expect(schedule.rows.length).toBe(40);
      expect(schedule.totalPrincipal).toBe(25000);
      expect(schedule.totalProfit).toBe(1925);
      expect(schedule.totalRepayable).toBe(26925);
      expect(schedule.rows.reduce((s, r) => s + r.total, 0)).toBe(26925);
      expect(schedule.rows.reduce((s, r) => s + r.principal, 0)).toBe(25000);
      expect(schedule.rows.reduce((s, r) => s + r.profit, 0)).toBe(1925);
    });

    it('uses integer taka and the last installment absorbs the rounding remainder', () => {
      for (const r of schedule.rows) {
        expect(Number.isInteger(r.principal)).toBe(true);
        expect(Number.isInteger(r.profit)).toBe(true);
        expect(r.total).toBe(r.principal + r.profit);
      }
      expect(schedule.installmentAmount).toBe(673);
      for (const r of schedule.rows.slice(0, 39)) expect(r.total).toBe(673);
      expect(schedule.lastInstallmentAmount).toBe(26925 - 39 * 673);
      expect(schedule.lastInstallmentAmount).toBe(678);
    });

    it('numbers installments 1..N and closes on the last due date', () => {
      expect(schedule.rows.map(r => r.installmentNo)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(schedule.rows[0].dueDate).toBe('2026-10-29');
      expect(schedule.rows[1].dueDate).toBe('2026-11-05');
      expect(schedule.expectedClosingDate).toBe(schedule.rows[39].dueDate);
    });

    it('sums exactly for awkward amounts', () => {
      const cases: [number, number, number][] = [[10000, 12, 46], [7777, 9.9, 13], [50000, 15, 365], [1, 10, 3]];
      for (const [p, r, n] of cases) {
        const s = buildSchedule({ principal: p, ratePercent: r, method: 'FLAT', count: n, frequency: 'DAILY', firstDueDate: '2026-01-01' });
        const profit = Math.round((p * r) / 100);
        expect(s.rows.reduce((a, x) => a + x.principal, 0)).toBe(p);
        expect(s.rows.reduce((a, x) => a + x.profit, 0)).toBe(profit);
        expect(s.totalRepayable).toBe(p + profit);
        for (const x of s.rows) {
          expect(x.principal).toBeGreaterThanOrEqual(0);
          expect(x.profit).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it('effectiveAnnualRate is higher than the (annualised) flat rate', () => {
      const annualisedFlat = 7.7 * (52 / 40);
      expect(schedule.effectiveAnnualRate).toBeGreaterThan(annualisedFlat);
      expect(schedule.effectiveAnnualRate).toBeGreaterThan(7.7);
    });
  });

  describe('declining schedule', () => {
    const s = buildSchedule({
      principal: 20000,
      ratePercent: 24,
      method: 'DECLINING',
      count: 12,
      frequency: 'MONTHLY',
      firstDueDate: '2026-11-15'
    });

    it('principal parts sum exactly to the principal', () => {
      expect(s.rows.reduce((a, r) => a + r.principal, 0)).toBe(20000);
      expect(s.totalPrincipal).toBe(20000);
      expect(s.totalRepayable).toBe(20000 + s.totalProfit);
    });

    it('profit declines as the balance falls', () => {
      expect(s.rows[0].profit).toBe(400); // 20000 × 2%
      for (let i = 1; i < s.rows.length; i++) {
        expect(s.rows[i].profit).toBeLessThanOrEqual(s.rows[i - 1].profit);
      }
      expect(s.totalProfit).toBeGreaterThan(0);
    });

    it('effective annual rate is about the declining nominal rate', () => {
      expect(s.effectiveAnnualRate).toBeGreaterThan(23);
      expect(s.effectiveAnnualRate).toBeLessThan(25);
    });

    it('zero rate splits principal evenly', () => {
      const z = buildSchedule({ principal: 1000, ratePercent: 0, method: 'DECLINING', count: 3, frequency: 'WEEKLY', firstDueDate: '2026-11-01' });
      expect(z.rows.reduce((a, r) => a + r.principal, 0)).toBe(1000);
      expect(z.totalProfit).toBe(0);
      expect(z.effectiveAnnualRate).toBe(0);
    });
  });

  describe('due dates and calendar', () => {
    // 2026-10-23 is a Friday (5)
    const cal: WorkingCalendar = { weeklyOffDays: [5], holidays: new Set(['2026-10-31']) };

    it('nextWorkingDay skips weekly off-day and holidays', () => {
      expect(nextWorkingDay('2026-10-23', cal)).toBe('2026-10-24');
      expect(nextWorkingDay('2026-10-31', cal)).toBe('2026-11-01');
      expect(nextWorkingDay('2026-10-22', cal)).toBe('2026-10-22');
    });

    it('weekly dates shift off Friday/holidays without dragging later installments', () => {
      expect(buildDueDates('2026-10-23', 3, 'WEEKLY', cal)).toEqual(['2026-10-24', '2026-11-01', '2026-11-07']);
    });

    it('daily dates count only working days', () => {
      expect(buildDueDates('2026-10-22', 4, 'DAILY', cal)).toEqual(['2026-10-22', '2026-10-24', '2026-10-25', '2026-10-26']);
    });

    it('buildSchedule applies the calendar', () => {
      const s = buildSchedule({ principal: 3000, ratePercent: 10, method: 'FLAT', count: 3, frequency: 'WEEKLY', firstDueDate: '2026-10-23', calendar: cal });
      expect(s.rows.map(r => r.dueDate)).toEqual(['2026-10-24', '2026-11-01', '2026-11-07']);
      expect(s.expectedClosingDate).toBe('2026-11-07');
    });

    it('monthly from Jan 31 clamps to month end (Feb 28 / Feb 29)', () => {
      expect(buildDueDates('2026-01-31', 4, 'MONTHLY')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
      expect(buildDueDates('2028-01-31', 2, 'MONTHLY')).toEqual(['2028-01-31', '2028-02-29']);
    });

    it('never produces duplicate or decreasing due dates', () => {
      const dense: WorkingCalendar = {
        weeklyOffDays: [5, 6],
        holidays: new Set(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-08'])
      };
      const dates = buildDueDates('2026-10-29', 6, 'WEEKLY', dense);
      for (let i = 1; i < dates.length; i++) expect(dates[i] > dates[i - 1]).toBe(true);
    });
  });

  describe('buildScheduleFromTotals', () => {
    it('splits given totals and offsets installment numbers', () => {
      const rows = buildScheduleFromTotals({ principal: 10001, profit: 999, count: 7, frequency: 'WEEKLY', firstDueDate: '2026-11-01', startNo: 11 });
      expect(rows.length).toBe(7);
      expect(rows[0].installmentNo).toBe(11);
      expect(rows[6].installmentNo).toBe(17);
      expect(rows.reduce((a, r) => a + r.principal, 0)).toBe(10001);
      expect(rows.reduce((a, r) => a + r.profit, 0)).toBe(999);
    });
  });

  describe('effectiveAnnualRate', () => {
    it('returns 0 when nothing above principal is paid', () => {
      expect(effectiveAnnualRate(1000, [500, 500], 'MONTHLY')).toBe(0);
      expect(effectiveAnnualRate(0, [500], 'MONTHLY')).toBe(0);
    });

    it('matches a known single-period rate', () => {
      // 1000 → 1010 after one month = 1%/month = 12%/year
      expect(effectiveAnnualRate(1000, [1010], 'MONTHLY')).toBeCloseTo(12, 1);
    });
  });
});
