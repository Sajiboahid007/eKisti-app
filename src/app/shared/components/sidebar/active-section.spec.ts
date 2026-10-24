import { describe, expect, it } from 'vitest';
import { innerPageOf, resolveActiveSection } from './active-section';

describe('innerPageOf', () => {
  it('names the inner pages shown as sidebar sub-items', () => {
    expect(innerPageOf('/loans/disburse')?.label).toBe('নতুন ঋণ আবেদন');
    expect(innerPageOf('/loans/disburse?loanId=20005')).toMatchObject({ queryParams: { loanId: '20005' }, labelEn: 'Disburse Loan #20005' });
    expect(innerPageOf('/loans/detail/20001')).toMatchObject({ path: '/loans/detail/20001', labelEn: 'Installment Schedule #20001' });
    expect(innerPageOf('/customers/edit/10001')?.labelEn).toBe('Edit Customer #10001');
    expect(innerPageOf('/loans')).toBeNull();
  });
});

describe('resolveActiveSection', () => {
  it('uses the menu page itself', () => {
    expect(resolveActiveSection('/loans/approvals', '/loans')).toBe('/loans/approvals');
    expect(resolveActiveSection('/loans?status=OVERDUE', '/dashboard')).toBe('/loans');
  });

  it('puts new loan application and disbursement under Loan Approvals wherever they were opened from', () => {
    expect(resolveActiveSection('/loans/disburse', '/loans')).toBe('/loans/approvals');
    expect(resolveActiveSection('/loans/disburse?loanId=20005', '/dashboard')).toBe('/loans/approvals');
    expect(resolveActiveSection('/loans/disburse', null)).toBe('/loans/approvals');
  });

  it('keeps the section the user came from on inner pages', () => {
    expect(resolveActiveSection('/loans/detail/20001', '/collections/daily')).toBe('/collections/daily');
    expect(resolveActiveSection('/customers/edit/10001', '/customers')).toBe('/customers');
  });

  it('falls back to the closest menu path when the origin is unknown', () => {
    expect(resolveActiveSection('/loans/detail/20001', null)).toBe('/loans');
    expect(resolveActiveSection('/users/new', null)).toBe('/users');
    expect(resolveActiveSection('/login', null)).toBeNull();
  });
});
