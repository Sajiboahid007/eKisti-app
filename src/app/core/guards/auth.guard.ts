import { inject } from '@angular/core';
import { CanActivateFn, Router, UrlTree } from '@angular/router';
import { AuthStateService } from '../services/auth-state.service';

export const authGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthStateService);
  const router = inject(Router);

  if (authService.isAuthenticated()) {
    return mustChangeRedirect(authService, router, state.url) ?? true;
  }

  // Not authenticated, redirect to /login
  return router.createUrlTree(['/login']);
};

export const superAdminGuard: CanActivateFn = (route, state) => {
  const authService = inject(AuthStateService);
  const router = inject(Router);

  if (authService.canManageUsers()) {
    return true;
  }

  return router.createUrlTree(['/dashboard'], { queryParams: { denied: 'users' } });
};

/** যেসব অনুমতি রুটে যাচাই করা যায় (AuthStateService-এর computed সিগন্যাল) */
export type RoutePermission =
  | 'canCollectKisti' | 'canVerifyCash' | 'canApplyLoan' | 'canSeeLoanPipeline' | 'canDisburseLoan'
  | 'canManageAccounts' | 'canAccessVault' | 'canManageSettings' | 'canManageBranches' | 'isFieldOfficer' | 'canViewReports';

/**
 * ভূমিকা-ভিত্তিক রুট গার্ড — যেকোনো একটি অনুমতি থাকলেই প্রবেশ।
 * সতর্কতা: ক্লায়েন্ট গার্ড শুধু UX; আসল নিরাপত্তা Firestore Security Rules-এ (firestore.rules)।
 */
export const permissionGuard = (...permissions: RoutePermission[]): CanActivateFn => (route, state) => {
  const authService = inject(AuthStateService);
  const router = inject(Router);
  if (!authService.isAuthenticated()) {
    return router.createUrlTree(['/login']);
  }
  const forced = mustChangeRedirect(authService, router, state.url);
  if (forced) return forced;
  const allowed = permissions.some(p => (authService[p] as () => boolean)());
  return allowed ? true : router.createUrlTree(['/dashboard'], { queryParams: { denied: permissions[0] } });
};

/** অস্থায়ী পাসওয়ার্ডে লগইন করলে নতুন পাসওয়ার্ড না দেওয়া পর্যন্ত শুধু /profile */
function mustChangeRedirect(authService: AuthStateService, router: Router, url: string): UrlTree | null {
  if (!authService.mustChangePassword() || url.startsWith('/profile')) return null;
  return router.createUrlTree(['/profile'], { queryParams: { mustChange: 1 } });
}
