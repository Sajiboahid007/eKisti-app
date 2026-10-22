import { addDaysKey, addMonthsKey, dayOfWeekKey, diffDaysKey, isLastDayOfMonth, monthKeyDhaka, toDhakaDayKey } from './dates';

describe('finance/dates', () => {
  it('toDhakaDayKey converts UTC instants to the Dhaka (UTC+6) calendar day', () => {
    expect(toDhakaDayKey('2026-10-21T19:30:00Z')).toBe('2026-10-22');
    expect(toDhakaDayKey('2026-10-21T17:59:59Z')).toBe('2026-10-21');
    expect(toDhakaDayKey('2026-10-21T18:00:00Z')).toBe('2026-10-22');
    expect(toDhakaDayKey(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01');
    expect(toDhakaDayKey(Date.parse('2026-10-21T19:30:00Z'))).toBe('2026-10-22');
  });

  it('toDhakaDayKey passes through plain day keys', () => {
    expect(toDhakaDayKey('2026-02-28')).toBe('2026-02-28');
  });

  it('monthKeyDhaka', () => {
    expect(monthKeyDhaka('2026-10-31T19:00:00Z')).toBe('2026-11');
  });

  it('addDaysKey', () => {
    expect(addDaysKey('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysKey('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('addMonthsKey clamps to month end', () => {
    expect(addMonthsKey('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsKey('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsKey('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonthsKey('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonthsKey('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonthsKey('2026-03-31', -1)).toBe('2026-02-28');
  });

  it('diffDaysKey = b − a', () => {
    expect(diffDaysKey('2026-10-01', '2026-10-22')).toBe(21);
    expect(diffDaysKey('2026-10-22', '2026-10-01')).toBe(-21);
    expect(diffDaysKey('2024-02-28', '2024-03-01')).toBe(2);
    expect(diffDaysKey('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('dayOfWeekKey / isLastDayOfMonth', () => {
    expect(dayOfWeekKey('2026-10-23')).toBe(5); // শুক্রবার
    expect(dayOfWeekKey('2026-10-25')).toBe(0);
    expect(isLastDayOfMonth('2026-02-28')).toBe(true);
    expect(isLastDayOfMonth('2028-02-28')).toBe(false);
    expect(isLastDayOfMonth('2026-10-31')).toBe(true);
  });
});
