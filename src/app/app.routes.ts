import { Routes } from '@angular/router';
import { authGuard, permissionGuard, superAdminGuard } from './core/guards/auth.guard';

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
        // ঋণ আবেদন (মাঠকর্মী / শাখা ব্যবস্থাপক) এবং ?loanId= দিয়ে অনুমোদিত ঋণ বিতরণ (ক্যাশিয়ার / BM)
        path: 'disburse',
        canActivate: [permissionGuard('canApplyLoan', 'canDisburseLoan')],
        loadComponent: () => import('./features/loans/loan-disburse/loan-disburse.component').then(m => m.LoanDisburseComponent)
      },
      {
        path: 'approvals',
        canActivate: [permissionGuard('canSeeLoanPipeline')],
        loadComponent: () => import('./features/loans/loan-approvals/loan-approvals.component').then(m => m.LoanApprovalsComponent)
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
        canActivate: [permissionGuard('canCollectKisti')],
        loadComponent: () => import('./features/collections/daily-sheet/daily-sheet.component').then(m => m.DailySheetComponent)
      },
      {
        path: 'receipts',
        loadComponent: () => import('./features/collections/receipt-list/receipt-list.component').then(m => m.ReceiptListComponent)
      }
    ]
  },
  {
    // ক্যাশিয়ার/BM জমা নেন; মাঠকর্মী শুধু নিজের অপেক্ষমাণ নগদ দেখেন
    path: 'reconciliation',
    canActivate: [permissionGuard('canVerifyCash')],
    loadComponent: () => import('./features/reconciliation/cash-closing/cash-closing.component').then(m => m.CashClosingComponent)
  },
  {
    path: 'accounts',
    canActivate: [permissionGuard('canAccessVault')],
    loadComponent: () => import('./features/accounts/vault-ledger/vault-ledger.component').then(m => m.VaultLedgerComponent)
  },
  {
    // সঞ্চয়: সবাই দেখতে পারেন (মাঠকর্মী শুধু নিজের সদস্য); জমা/উত্তোলন শুধু ক্যাশিয়ার/BM
    path: 'savings',
    canActivate: [authGuard],
    loadComponent: () => import('./features/savings/savings.component').then(m => m.SavingsComponent)
  },
  {
    path: 'reports',
    canActivate: [permissionGuard('canViewReports')],
    loadComponent: () => import('./features/reports/reports.component').then(m => m.ReportsComponent)
  },
  {
    path: 'settings',
    canActivate: [permissionGuard('canManageSettings')],
    loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent)
  },
  {
    path: 'branches',
    canActivate: [permissionGuard('canManageBranches')],
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
    // আমার প্রোফাইল — লগইন করা কর্মী নিজের তথ্য ও পাসওয়ার্ড হালনাগাদ করেন
    path: 'profile',
    canActivate: [authGuard],
    loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent)
  },
  {
    path: '**',
    redirectTo: 'dashboard'
  }
];
