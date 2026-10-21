import { Routes } from '@angular/router';
import { authGuard, superAdminGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () => import('./features/auth/login/login.component').then(m => m.LoginComponent)
  },
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'dashboard'
  },
  {
    path: 'dashboard',
    canActivate: [authGuard],
    loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent)
  },
  {
    path: 'customers',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/customers/customer-list/customer-list.component').then(m => m.CustomerListComponent)
      },
      {
        path: 'new',
        loadComponent: () => import('./features/customers/customer-form/customer-form.component').then(m => m.CustomerFormComponent)
      },
      {
        path: 'register',
        loadComponent: () => import('./features/customers/customer-form/customer-form.component').then(m => m.CustomerFormComponent)
      },
      {
        path: 'edit/:id',
        loadComponent: () => import('./features/customers/customer-form/customer-form.component').then(m => m.CustomerFormComponent)
      }
    ]
  },
  {
    path: 'loans',
    canActivate: [authGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/loans/loan-list/loan-list.component').then(m => m.LoanListComponent)
      },
      {
        path: 'disburse',
        loadComponent: () => import('./features/loans/loan-disburse/loan-disburse.component').then(m => m.LoanDisburseComponent)
      },
      {
        path: 'detail/:id',
        loadComponent: () => import('./features/loans/loan-detail/loan-detail.component').then(m => m.LoanDetailComponent)
      }
    ]
  },
  {
    path: 'collections',
    canActivate: [authGuard],
    children: [
      {
        path: 'daily',
        loadComponent: () => import('./features/collections/daily-sheet/daily-sheet.component').then(m => m.DailySheetComponent)
      },
      {
        path: 'receipts',
        loadComponent: () => import('./features/collections/receipt-list/receipt-list.component').then(m => m.ReceiptListComponent)
      }
    ]
  },
  {
    path: 'reconciliation',
    canActivate: [authGuard],
    loadComponent: () => import('./features/reconciliation/cash-closing/cash-closing.component').then(m => m.CashClosingComponent)
  },
  {
    path: 'branches',
    canActivate: [authGuard],
    loadComponent: () => import('./features/organization/branch-route-list/branch-route-list.component').then(m => m.BranchRouteListComponent)
  },
  {
    path: 'users',
    canActivate: [authGuard, superAdminGuard],
    children: [
      {
        path: '',
        loadComponent: () => import('./features/users/user-list/user-list.component').then(m => m.UserListComponent)
      },
      {
        path: 'new',
        loadComponent: () => import('./features/users/user-form/user-form.component').then(m => m.UserFormComponent)
      }
    ]
  },
  {
    path: '**',
    redirectTo: 'dashboard'
  }
];
