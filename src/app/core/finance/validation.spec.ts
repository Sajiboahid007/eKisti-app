import { isValidBdMobile, isValidBdNid, normalizeBdMobile, normalizeNid, toAsciiDigits } from './validation';

describe('finance/validation', () => {
  it('NID accepts 10, 13 or 17 digits only', () => {
    expect(isValidBdNid('1234567890')).toBe(true);
    expect(isValidBdNid('1234567890123')).toBe(true);
    expect(isValidBdNid('12345678901234567')).toBe(true);
    const bad: (string | null | undefined)[] = ['123456789', '12345678901', '123456789012', '12345678901234', '123456789012345678', '12345abcde', '', null, undefined];
    for (const b of bad) expect(isValidBdNid(b)).toBe(false);
  });

  it('NID accepts Bengali digits, spaces and dashes', () => {
    expect(isValidBdNid('১২৩৪৫৬৭৮৯০')).toBe(true);
    expect(isValidBdNid('123 456 7890')).toBe(true);
    expect(isValidBdNid('1234-567-890-123')).toBe(true);
    expect(normalizeNid('১২৩ ৪৫৬-৭৮৯০')).toBe('1234567890');
  });

  it('toAsciiDigits', () => {
    expect(toAsciiDigits('০১২৩৪৫৬৭৮৯')).toBe('0123456789');
    expect(toAsciiDigits('টাকা ৫০০')).toBe('টাকা 500');
  });

  it('mobile: 01[3-9] + 8 digits, optional +88 / 88', () => {
    for (const ok of ['01712345678', '01312345678', '01912345678', '+8801712345678', '8801712345678', '017-1234-5678', '০১৭১২৩৪৫৬৭৮']) {
      expect(isValidBdMobile(ok)).toBe(true);
    }
    const bad: (string | null | undefined)[] = ['01212345678', '01112345678', '0171234567', '017123456789', '1712345678', '', null, undefined];
    for (const b of bad) expect(isValidBdMobile(b)).toBe(false);
    expect(normalizeBdMobile('+88 01712-345678')).toBe('01712345678');
  });
});
