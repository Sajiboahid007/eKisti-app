import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthStateService } from '../services/auth-state.service';

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthStateService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    return true;
  }

  // Not authenticated, redirect to /login
  return router.createUrlTree(['/login']);
};

export const superAdminGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthStateService);
  const router = inject(Router);

  if (authService.isSuperAdmin()) {
    return true;
  }

  return router.createUrlTree(['/dashboard'], { queryParams: { denied: 'users' } });
};

/** যেসব অনুমতি রুটে যাচাই করা যায় (AuthStateService-এর computed সিগন্যাল) */
export type RoutePermission =
  | 'canCollectKisti' | 'canVerifyCash' | 'canApplyLoan' | 'canSeeLoanPipeline' | 'canDisburseLoan'
  | 'canManageAccounts' | 'canManageSettings' | 'canManageBranches' | 'isFieldOfficer' | 'canViewReports';

/**
 * ভূমিকা-ভিত্তিক রুট গার্ড — যেকোনো একটি অনুমতি থাকলেই প্রবেশ।
 * সতর্কতা: ক্লায়েন্ট গার্ড শুধু UX; আসল নিরাপত্তা Firestore Security Rules-এ (firestore.rules)।
 */
export const permissionGuard = (...permissions: RoutePermission[]): CanActivateFn => () => {
  const authService = inject(AuthStateService);
  const router = inject(Router);
  if (!authService.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }
  const allowed = permissions.some(p => (authService[p] as () => boolean)());
  return allowed ? true : router.createUrlTree(['/dashboard'], { queryParams: { denied: permissions[0] } });
};
