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

  alert('এই পেজে শুধুমাত্র সুপার অ্যাডমিনের অনুমতি রয়েছে (Super Admin Access Only)');
  return router.createUrlTree(['/dashboard']);
};
