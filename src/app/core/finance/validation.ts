/** বাংলাদেশি NID: ১০, ১৩ বা ১৭ ডিজিট */
export function isValidBdNid(value: string | undefined | null): boolean {
  const digits = toAsciiDigits(value || '').replace(/\s|-/g, '');
  return /^(\d{10}|\d{13}|\d{17})$/.test(digits);
}

/** বাংলাদেশি মোবাইল: 01[3-9]XXXXXXXX (ঐচ্ছিক +88 / 88) */
export function isValidBdMobile(value: string | undefined | null): boolean {
  return /^01[3-9]\d{8}$/.test(normalizeBdMobile(value || ''));
}

export function normalizeBdMobile(value: string): string {
  return toAsciiDigits(value).replace(/[\s-]/g, '').replace(/^\+?88/, '');
}

export function normalizeNid(value: string): string {
  return toAsciiDigits(value || '').replace(/[\s-]/g, '');
}

/** বাংলা অংক (০-৯) → ইংরেজি অংক */
export function toAsciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
}
