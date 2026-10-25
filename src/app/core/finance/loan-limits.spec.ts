import { maxOpenLoansFor } from './loan-limits';

describe('finance/loan-limits', () => {
  it('BM, admins, head office and area manager may give up to 3 loans to one member', () => {
    for (const role of ['BRANCH_MANAGER', 'ADMIN', 'SUPER_ADMIN', 'MANAGING_DIRECTOR', 'REGIONAL_MANAGER', 'AREA_MANAGER', 'CENTRAL_AUDITOR']) {
      expect(maxOpenLoansFor(role)).toBe(3);
    }
  });

  it('custom head office / system admin roles count by category', () => {
    expect(maxOpenLoansFor('ZONAL_HEAD', 'HEAD_OFFICE')).toBe(3);
    expect(maxOpenLoansFor('IT_ADMIN', 'SYSTEM_ADMIN')).toBe(3);
  });

  it('every other role may give only 1', () => {
    expect(maxOpenLoansFor('FIELD_OFFICER')).toBe(1);
    expect(maxOpenLoansFor('CASHIER', 'BRANCH_STAFF')).toBe(1);
    expect(maxOpenLoansFor(undefined)).toBe(1);
  });
});
