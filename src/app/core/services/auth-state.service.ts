import { Injectable, signal, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Firestore, collection, getDocs } from '@angular/fire/firestore';
import { StaffRole, UserStaff, Role, UserCategory } from '../models/database.models';
import { LOAN_APPROVE_ROLES, LOAN_DISBURSE_ROLES, LOAN_VERIFY_ROLES } from './loan-lifecycle.service';
import { canAccessVaultFor, canOperateVaultFor } from '../guards/vault-access';

export interface ActiveUserSession {
  userId: number;
  name: string;
  nameEn?: string;
  email: string;
  role: StaffRole;
  category: UserCategory;
  roleTitleBangla: string;
  roleTitleEnglish: string;
  branchId: number;
  branchName: string;
  areaName?: string;
  assignedCenterIds: number[];
  assignedBranchIds?: number[];   // এরিয়া/রিজিওনাল ম্যানেজারের শাখাসমূহ
  phone: string;
}

// এরিয়া ভিত্তিক তদারকি: নির্ধারিত শাখাগুলোর সব তথ্য দেখতে পারেন
export const AREA_SCOPED_ROLES: StaffRole[] = ['AREA_MANAGER', 'REGIONAL_MANAGER'];
// সারাদেশের সব শাখা দেখতে পারেন
export const NATIONWIDE_ROLES: StaffRole[] = ['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'CENTRAL_AUDITOR', 'AUDITOR'];

export const PRESET_STAFF_USERS: ActiveUserSession[] = [
  // 1. SYSTEM ADMINS (সুপার অ্যাডমিন ও সিস্টেম প্রশাসন)
  {
    userId: 1,
    name: 'Sajib Oahid',
    nameEn: 'Sajib Oahid',
    email: 'admin@ekisti.com',
    role: 'SUPER_ADMIN',
    category: 'SYSTEM_ADMIN',
    roleTitleBangla: 'সুপার অ্যাডমিন / প্রধান কার্যালয়',
    roleTitleEnglish: 'Super Admin / Managing Director',
    branchId: 0,
    branchName: 'সিস্টেম প্রশাসন (সর্বজনীন)',
    areaName: 'সারাদেশ (সকল শাখা)',
    assignedCenterIds: [],
    phone: '01700000001'
  },
  {
    userId: 2,
    name: 'ইঞ্জিঃ তানভীর আহমেদ',
    nameEn: 'Engr. Tanvir Ahmed',
    email: 'tanvir.admin@ekisti.com',
    role: 'ADMIN',
    category: 'SYSTEM_ADMIN',
    roleTitleBangla: 'সিস্টেম অ্যাডমিনিস্ট্রেটর',
    roleTitleEnglish: 'System Administrator',
    branchId: 0,
    branchName: 'সিস্টেম প্রশাসন (সর্বজনীন)',
    areaName: 'সারাদেশ (সকল শাখা)',
    assignedCenterIds: [],
    phone: '01700000002'
  },

  // 2. HEAD OFFICE STAFF (প্রধান কার্যালয় কর্মকর্তা)
  {
    userId: 3,
    name: 'মোঃ তারেক হাসান',
    nameEn: 'Md. Tareq Hasan',
    email: 'tareq.am@ekisti.com',
    role: 'AREA_MANAGER',
    category: 'HEAD_OFFICE',
    roleTitleBangla: 'এরিয়া ম্যানেজার (AM - হেড অফিস)',
    roleTitleEnglish: 'Area Manager (Head Office)',
    branchId: 0,
    branchName: 'প্রধান কার্যালয় (হেড অফিস)',
    areaName: 'মিরপুর ও ঢাকা উত্তর জোন',
    assignedCenterIds: [],
    assignedBranchIds: [1],
    phone: '01711224455'
  },
  {
    userId: 4,
    name: 'ফারহানা ইসলাম',
    nameEn: 'Farhana Islam',
    email: 'farhana.ho@ekisti.com',
    role: 'CENTRAL_AUDITOR',
    category: 'HEAD_OFFICE',
    roleTitleBangla: 'কেন্দ্রীয় নিরীক্ষক (Head Office Auditor)',
    roleTitleEnglish: 'Central Audit Officer',
    branchId: 0,
    branchName: 'প্রধান কার্যালয় (হেড অফিস)',
    areaName: 'ঢাকা বিভাগ',
    assignedCenterIds: [],
    phone: '01799887766'
  },

  // 3. BRANCH & FIELD STAFF (শাখা ও মাঠ পর্যায়ের কর্মী)
  {
    userId: 501,
    name: 'মোঃ কামরুল ইসলাম',
    nameEn: 'Md. Kamrul Islam',
    email: 'kamrul.bm@ekisti.com',
    role: 'BRANCH_MANAGER',
    category: 'BRANCH_STAFF',
    roleTitleBangla: 'শাখা ব্যবস্থাপক (BM - মিরপুর শাখা)',
    roleTitleEnglish: 'Branch Manager (BM - Mirpur Branch)',
    branchId: 1,
    branchName: 'মিরপুর শাখা',
    areaName: 'মিরপুর জোন',
    assignedCenterIds: [101, 102, 103],
    phone: '01712345678'
  },
  {
    userId: 502,
    name: 'মোঃ রফিকুল ইসলাম',
    nameEn: 'Md. Rafiqul Islam',
    email: 'rafiqul.fo@ekisti.com',
    role: 'FIELD_OFFICER',
    category: 'BRANCH_STAFF',
    roleTitleBangla: 'মাঠকর্মী (FO - রুট ১০১ শাপলা)',
    roleTitleEnglish: 'Field Officer (FO - Route 101)',
    branchId: 1,
    branchName: 'মিরপুর শাখা',
    areaName: 'মিরপুর জোন',
    assignedCenterIds: [101],
    phone: '01812345678'
  },
  {
    userId: 504,
    name: 'মোঃ আল-আমিন হোসেন',
    nameEn: 'Md. Al-Amin Hossain',
    email: 'alamin.fo@ekisti.com',
    role: 'FIELD_OFFICER',
    category: 'BRANCH_STAFF',
    roleTitleBangla: 'মাঠকর্মী (FO - রুট ১০২ গোলাপ)',
    roleTitleEnglish: 'Field Officer (FO - Route 102)',
    branchId: 1,
    branchName: 'মিরপুর শাখা',
    areaName: 'মিরপুর জোন',
    assignedCenterIds: [102],
    phone: '01888990011'
  },
  {
    userId: 503,
    name: 'নাসরিন আক্তার',
    nameEn: 'Nasrin Akter',
    email: 'nasrin.cashier@ekisti.com',
    role: 'CASHIER',
    category: 'BRANCH_STAFF',
    roleTitleBangla: 'হিসাবরক্ষক / ক্যাশিয়ার (মিরপুর শাখা)',
    roleTitleEnglish: 'Cashier / Accountant (Mirpur Branch)',
    branchId: 1,
    branchName: 'মিরপুর শাখা',
    areaName: 'মিরপুর জোন',
    assignedCenterIds: [],
    phone: '01912345678'
  }
];

@Injectable({
  providedIn: 'root'
})
export class AuthStateService {
  private router = inject(Router);
  private firestore = inject(Firestore);

  // Dynamic available users list loaded from database (initialized with presets)
  readonly availableUsers = signal<ActiveUserSession[]>(PRESET_STAFF_USERS);

  // Authentication status and user session
  readonly isAuthenticated = signal<boolean>(false);
  readonly currentUser = signal<ActiveUserSession>(PRESET_STAFF_USERS[0]);

  constructor() {
    const saved = localStorage.getItem('ekisti_user_session');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.userId) {
          this.currentUser.set(parsed);
          this.isAuthenticated.set(true);
        } else {
          this.isAuthenticated.set(false);
        }
      } catch (_) {
        this.isAuthenticated.set(false);
      }
    } else {
      this.isAuthenticated.set(false);
    }

    // Immediately fetch real users and roles from Firestore database
    this.loadUsersFromFirestore();
  }

  /**
   * Fetches real staff and roles from Firestore database and synchronizes active users
   */
  async loadUsersFromFirestore(): Promise<ActiveUserSession[]> {
    try {
      const [staffSnap, rolesSnap] = await Promise.all([
        getDocs(collection(this.firestore, 'staff')),
        getDocs(collection(this.firestore, 'roles'))
      ]);

      const staffList: UserStaff[] = [];
      staffSnap.forEach(d => {
        const u = d.data() as UserStaff;
        if (!u.isDeleted) {
          staffList.push(u);
        }
      });

      const rolesList: any[] = [];
      rolesSnap.forEach(d => {
        const r = d.data();
        if (!r['isDeleted']) {
          rolesList.push(r);
        }
      });

      if (staffList.length > 0) {
        this.syncUsersFromDb(staffList, rolesList);
      }
      return this.availableUsers();
    } catch (err) {
      console.error('Error loading users from database:', err);
      return this.availableUsers();
    }
  }

  // Computed helper signals
  readonly isSuperAdmin = computed(() => this.currentUser().role === 'SUPER_ADMIN');
  readonly isAdmin = computed(() => this.currentUser().role === 'ADMIN' || this.currentUser().role === 'SUPER_ADMIN');
  readonly isSystemAdmin = computed(() => this.currentUser().category === 'SYSTEM_ADMIN' || ['SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));
  readonly isHeadOfficeUser = computed(() => this.currentUser().category === 'HEAD_OFFICE');
  readonly isBranchStaff = computed(() => this.currentUser().category === 'BRANCH_STAFF');
  readonly isAreaManager = computed(() => this.currentUser().role === 'AREA_MANAGER' || this.isSuperAdmin());
  readonly isBranchManager = computed(() => this.currentUser().role === 'BRANCH_MANAGER' || this.isSuperAdmin());
  readonly isFieldOfficer = computed(() => this.currentUser().role === 'FIELD_OFFICER');
  readonly isCashier = computed(() => this.currentUser().role === 'CASHIER' || this.isSuperAdmin());

  // Permission checks
  readonly canManageUsers = computed(() => this.isSuperAdmin() || this.isAdmin());
  readonly canApproveLoans = computed(() => LOAN_APPROVE_ROLES.includes(this.currentUser().role));
  /** ঋণ বিতরণ = ভল্ট থেকে নগদ প্রদান — তাই ক্যাশিয়ার */
  readonly canDisburseLoan = computed(() => LOAN_DISBURSE_ROLES.includes(this.currentUser().role));
  readonly canCollectKisti = computed(() => ['FIELD_OFFICER', 'BRANCH_MANAGER', 'SUPER_ADMIN', 'ADMIN', 'AREA_MANAGER'].includes(this.currentUser().role));
  readonly canVerifyCash = computed(() => ['CASHIER', 'BRANCH_MANAGER', 'SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));

  // ঋণ অনুমোদন প্রবাহ (Maker-Checker)
  readonly canApplyLoan = computed(() => ['FIELD_OFFICER', 'BRANCH_MANAGER', 'SUPER_ADMIN', 'ADMIN', 'AREA_MANAGER', 'MANAGING_DIRECTOR'].includes(this.currentUser().role));
  /** মাঠ যাচাই — মাঠকর্মী সরেজমিনে করেন */
  readonly canVerifyLoan = computed(() => LOAN_VERIFY_ROLES.includes(this.currentUser().role));
  /** মাঠকর্মী যাচাই, BM অনুমোদন, ক্যাশিয়ার বিতরণ; বাকিরা শুধু তালিকা দেখেন */
  readonly canSeeLoanPipeline = computed(() => this.canApplyLoan() || this.canVerifyLoan() || this.canApproveLoans() || this.canDisburseLoan() || this.isCashier());
  readonly isLoanPipelineReadOnly = computed(() => !this.canVerifyLoan() && !this.canApproveLoans() && !this.canDisburseLoan());

  // রিপোর্ট — মাঠকর্মী দেখেন না
  readonly canViewReports = computed(() => !this.isFieldOfficer());

  // হিসাব, ভল্ট ও সমাপনী
  readonly canManageAccounts = computed(() => ['CASHIER', 'BRANCH_MANAGER', 'SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));
  /** ভল্ট, ব্যাংক, খরচ ও দিবস/মাস সমাপনী — সুপার অ্যাডমিন, অ্যাডমিন, হেড অফিস, BM, ক্যাশিয়ার */
  readonly canAccessVault = computed(() => canAccessVaultFor(this.currentUser().role, this.currentUser().category));
  /** ভল্টে লেনদেন ও সমাপনী — উপরের সবাই, তবে নিরীক্ষক (শুধু দেখা) বাদে */
  readonly canOperateVault = computed(() => canOperateVaultFor(this.currentUser().role, this.currentUser().category));
  readonly canReopenDay = computed(() => ['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR'].includes(this.currentUser().role));
  readonly canReverseReceipt = computed(() => ['BRANCH_MANAGER', 'SUPER_ADMIN', 'ADMIN', 'AREA_MANAGER'].includes(this.currentUser().role));

  // বিশেষ ঋণ সিদ্ধান্ত
  readonly canReschedule = computed(() => ['BRANCH_MANAGER', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'MANAGING_DIRECTOR', 'SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));
  readonly canWriteOff = computed(() => ['MANAGING_DIRECTOR', 'REGIONAL_MANAGER', 'SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));
  readonly canSettleLoan = computed(() => ['BRANCH_MANAGER', 'CASHIER', 'AREA_MANAGER', 'SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));

  // সদস্য ও সেটিংস
  readonly canTransferMember = computed(() => ['BRANCH_MANAGER', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));
  readonly canManageSettings = computed(() => ['SUPER_ADMIN', 'ADMIN'].includes(this.currentUser().role));
  readonly canManageBranches = computed(() => this.canManageUsers() || ['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'BRANCH_MANAGER'].includes(this.currentUser().role));

  // ==========================================
  // BRANCH ACCESS SCOPE (কে কোন শাখার তথ্য দেখতে ও হালনাগাদ করতে পারবেন)
  // ==========================================
  readonly isAreaScoped = computed(() => AREA_SCOPED_ROLES.includes(this.currentUser().role));
  readonly hasNationwideAccess = computed(() =>
    NATIONWIDE_ROLES.includes(this.currentUser().role) || this.currentUser().category === 'SYSTEM_ADMIN'
  );

  /**
   * Branch IDs the current user may see. `null` = all branches.
   * Area/Regional managers get only their assigned branches (empty list = no access until assigned);
   * branch staff get their own branch.
   */
  readonly accessibleBranchIds = computed<number[] | null>(() => {
    const user = this.currentUser();
    if (this.hasNationwideAccess()) return null;
    if (this.isAreaScoped()) return user.assignedBranchIds || [];
    return user.branchId > 0 ? [user.branchId] : [];
  });

  canAccessBranch(branchId: number): boolean {
    const ids = this.accessibleBranchIds();
    return ids === null || ids.includes(Number(branchId));
  }

  /**
   * Syncs active staff directory from database (Firestore) with roles
   */
  syncUsersFromDb(staffList: UserStaff[], rolesList?: any[]) {
    const roleMap = new Map<string, any>();
    if (rolesList) {
      rolesList.forEach(r => roleMap.set(r.code, r));
    }

    const mapped: ActiveUserSession[] = staffList.map(s => {
      const roleDef = roleMap.get(s.role);
      const roleTitleBangla = roleDef?.nameBn || this.getRoleTitleBanglaFallback(s.role);
      const roleTitleEnglish = roleDef?.nameEn || s.role;

      // Determine Category
      let category: UserCategory = s.category;
      if (!category) {
        if (['SUPER_ADMIN', 'ADMIN'].includes(s.role)) {
          category = 'SYSTEM_ADMIN';
        } else if (['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(s.role)) {
          category = 'HEAD_OFFICE';
        } else {
          category = 'BRANCH_STAFF';
        }
      }

      // Determine Branch Name
      let branchName = s.branchName;
      if (!branchName) {
        if (category === 'SYSTEM_ADMIN') {
          branchName = 'সিস্টেম প্রশাসন (সর্বজনীন)';
        } else if (category === 'HEAD_OFFICE') {
          branchName = 'প্রধান কার্যালয় (হেড অফিস)';
        } else {
          branchName = s.branchId === 1 ? 'মিরপুর শাখা' : ` শাখা #${s.branchId}`;
        }
      }

      return {
        userId: Number(s.userId),
        name: s.name,
        nameEn: s.name,
        email: s.email,
        role: s.role,
        category,
        roleTitleBangla,
        roleTitleEnglish,
        branchId: category === 'SYSTEM_ADMIN' || category === 'HEAD_OFFICE' ? 0 : Number(s.branchId),
        branchName,
        areaName: category === 'SYSTEM_ADMIN' ? 'সারাদেশ (সকল শাখা)' : category === 'HEAD_OFFICE' ? 'প্রধান কার্যালয়' : 'মিরপুর জোন',
        assignedCenterIds: s.assignedCenterIds || [],
        assignedBranchIds: s.assignedBranchIds || [],
        phone: s.phone
      };
    });

    if (mapped.length > 0) {
      this.availableUsers.set(mapped);

      // Keep PRESET_STAFF_USERS in-sync in-memory
      mapped.forEach(m => {
        const pIdx = PRESET_STAFF_USERS.findIndex(p => Number(p.userId) === Number(m.userId));
        if (pIdx >= 0) {
          PRESET_STAFF_USERS[pIdx] = m;
        } else {
          PRESET_STAFF_USERS.push(m);
        }
      });

      // Sync currentUser if currently logged in
      const current = this.currentUser();
      const updated = mapped.find(u => Number(u.userId) === Number(current.userId));
      if (updated) {
        this.currentUser.set(updated);
        localStorage.setItem('ekisti_user_session', JSON.stringify(updated));
      }
    }
  }

  /**
   * Sync single created or edited staff user
   */
  syncUserFromDb(staff: UserStaff, role?: any) {
    let category: UserCategory = staff.category;
    if (!category) {
      if (['SUPER_ADMIN', 'ADMIN'].includes(staff.role)) {
        category = 'SYSTEM_ADMIN';
      } else if (['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(staff.role)) {
        category = 'HEAD_OFFICE';
      } else {
        category = 'BRANCH_STAFF';
      }
    }

    let branchName = staff.branchName;
    if (!branchName) {
      if (category === 'SYSTEM_ADMIN') {
        branchName = 'সিস্টেম প্রশাসন (সর্বজনীন)';
      } else if (category === 'HEAD_OFFICE') {
        branchName = 'প্রধান কার্যালয় (হেড অফিস)';
      } else {
        branchName = staff.branchId === 1 ? 'মিরপুর শাখা' : `শাখা #${staff.branchId}`;
      }
    }

    const session: ActiveUserSession = {
      userId: Number(staff.userId),
      name: staff.name,
      nameEn: staff.name,
      email: staff.email,
      role: staff.role,
      category,
      roleTitleBangla: role?.nameBn || this.getRoleTitleBanglaFallback(staff.role),
      roleTitleEnglish: role?.nameEn || staff.role,
      branchId: category === 'SYSTEM_ADMIN' || category === 'HEAD_OFFICE' ? 0 : Number(staff.branchId),
      branchName,
      areaName: category === 'SYSTEM_ADMIN' ? 'সারাদেশ (সকল শাখা)' : category === 'HEAD_OFFICE' ? 'প্রধান কার্যালয়' : 'মিরপুর জোন',
      assignedCenterIds: staff.assignedCenterIds || [],
      assignedBranchIds: staff.assignedBranchIds || [],
      phone: staff.phone
    };

    const currentList = this.availableUsers();
    const idx = currentList.findIndex(u => Number(u.userId) === Number(session.userId));
    if (idx >= 0) {
      const updated = [...currentList];
      updated[idx] = session;
      this.availableUsers.set(updated);
    } else {
      this.availableUsers.set([...currentList, session]);
    }

    // Also update PRESET_STAFF_USERS array in-memory
    const presetIdx = PRESET_STAFF_USERS.findIndex(u => Number(u.userId) === Number(session.userId));
    if (presetIdx >= 0) {
      PRESET_STAFF_USERS[presetIdx] = session;
    } else {
      PRESET_STAFF_USERS.push(session);
    }

    // If active user is updated, update currentUser immediately
    if (Number(this.currentUser().userId) === Number(session.userId)) {
      this.currentUser.set(session);
      localStorage.setItem('ekisti_user_session', JSON.stringify(session));
    }
  }

  private getRoleTitleBanglaFallback(role: string): string {
    switch (role) {
      case 'SUPER_ADMIN': return 'সুপার অ্যাডমিন / প্রধান কার্যালয়';
      case 'AREA_MANAGER': return 'এরিয়া ম্যানেজার (AM)';
      case 'BRANCH_MANAGER': return 'শাখা ব্যবস্থাপক (BM)';
      case 'FIELD_OFFICER': return 'মাঠকর্মী (FO)';
      case 'CASHIER': return 'হিসাবরক্ষক / ক্যাশিয়ার';
      case 'AUDITOR': return 'অভ্যন্তরীণ অডিটর';
      default: return role;
    }
  }

  /**
   * Login using credentials (Email/Phone + Password)
   */
  login(emailOrPhone: string, password?: string): boolean {
    const cleanId = emailOrPhone.trim().toLowerCase();
    const users = this.availableUsers();
    const user = users.find(u => 
      u.email.toLowerCase() === cleanId || 
      u.phone === cleanId ||
      u.name.toLowerCase().includes(cleanId)
    );

    if (user) {
      this.setUserSession(user);
      return true;
    }

    return false;
  }

  /**
   * 1-Click login as specific role
   */
  loginAsRole(role: StaffRole) {
    const users = this.availableUsers();
    const user = users.find(u => u.role === role);
    if (user) {
      this.setUserSession(user);
      this.router.navigate(['/dashboard']);
    } else if (users.length > 0) {
      this.setUserSession(users[0]);
      this.router.navigate(['/dashboard']);
    }
  }

  /**
   * Switch user from dropdown and refresh/route view accordingly
   */
  switchUser(userId: number) {
    const user = this.availableUsers().find(u => Number(u.userId) === Number(userId));
    if (user) {
      this.setUserSession(user);

      // Re-route if user lacks permissions for current page
      const currentUrl = this.router.url;
      if (currentUrl.startsWith('/users') && !['SUPER_ADMIN', 'ADMIN'].includes(user.role)) {
        this.router.navigate(['/dashboard']);
      } else {
        // Trigger a clean route reload so all active component data re-queries for the switched user
        this.router.navigateByUrl('/', { skipLocationChange: true }).then(() => {
          this.router.navigate([currentUrl]);
        });
      }
    }
  }

  /**
   * Logs out user and routes to /login
   */
  logout() {
    this.isAuthenticated.set(false);
    localStorage.removeItem('ekisti_user_session');
    this.router.navigate(['/login']);
  }

  private setUserSession(user: ActiveUserSession) {
    this.currentUser.set(user);
    this.isAuthenticated.set(true);
    localStorage.setItem('ekisti_user_session', JSON.stringify(user));
  }
}
