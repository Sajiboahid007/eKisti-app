import { canAccessVaultFor, canOperateVaultFor } from './vault-access';

describe('guards/vault-access', () => {
  it('super admin, admin, head office, branch manager and cashier can open vault & day closing', () => {
    for (const role of ['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'REGIONAL_MANAGER', 'AREA_MANAGER', 'CENTRAL_AUDITOR', 'BRANCH_MANAGER', 'CASHIER']) {
      expect(canAccessVaultFor(role)).toBe(true);
    }
  });

  it('custom head office / system admin roles are allowed by category', () => {
    expect(canAccessVaultFor('ZONAL_HEAD', 'HEAD_OFFICE')).toBe(true);
    expect(canAccessVaultFor('IT_ADMIN', 'SYSTEM_ADMIN')).toBe(true);
  });

  it('central auditor can view but not operate (read-only role)', () => {
    expect(canAccessVaultFor('CENTRAL_AUDITOR', 'HEAD_OFFICE')).toBe(true);
    expect(canOperateVaultFor('CENTRAL_AUDITOR', 'HEAD_OFFICE')).toBe(false);
    expect(canOperateVaultFor('AREA_MANAGER', 'HEAD_OFFICE')).toBe(true);
    expect(canOperateVaultFor('CASHIER', 'BRANCH_STAFF')).toBe(true);
  });

  it('field officers and other branch staff are not allowed', () => {
    expect(canAccessVaultFor('FIELD_OFFICER', 'BRANCH_STAFF')).toBe(false);
    expect(canAccessVaultFor('AUDITOR', 'BRANCH_STAFF')).toBe(false);
    expect(canAccessVaultFor(undefined)).toBe(false);
  });
});
