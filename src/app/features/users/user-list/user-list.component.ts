import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { UserStaff, StaffRole, Branch, CenterOrSamity, Customer, Role, SYSTEM_PERMISSIONS, PermissionDefinition, UserCategory } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';

@Component({
  selector: 'app-user-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule],
  templateUrl: './user-list.component.html',
  styleUrl: './user-list.component.scss'
})
export class UserListComponent implements OnInit {
  private kistiService = inject(KistiDatabaseService);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  // 4-Tab State: 'admins' (সুপার অ্যাডমিন ও অ্যাডমিন) | 'head_office' (প্রধান কার্যালয়) | 'branch_staff' (শাখা ও মাঠকর্মী) | 'roles' (পদবী ও রোল ব্যবস্থাপনা)
  readonly activeTab = signal<'admins' | 'head_office' | 'branch_staff' | 'roles'>('admins');

  // Main Data Signals loaded directly from Firestore database
  readonly staffList = signal<UserStaff[]>([]);
  readonly rolesList = signal<Role[]>([]);
  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly customers = signal<Customer[]>([]);
  readonly loading = signal<boolean>(true);

  // Available System Permissions Definitions
  readonly systemPermissions: PermissionDefinition[] = SYSTEM_PERMISSIONS;

  // Search & Filter
  searchQuery: string = '';
  roleSearchQuery: string = '';

  // Filtered Computed Signals by Category
  readonly systemAdmins = computed(() => {
    return this.filteredStaff().filter(s => s.category === 'SYSTEM_ADMIN' || ['SUPER_ADMIN', 'ADMIN'].includes(s.role));
  });

  readonly headOfficeStaff = computed(() => {
    return this.filteredStaff().filter(s => s.category === 'HEAD_OFFICE' || ['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(s.role));
  });

  readonly branchStaff = computed(() => {
    return this.filteredStaff().filter(s => s.category === 'BRANCH_STAFF' || (!['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(s.role) && s.category !== 'SYSTEM_ADMIN' && s.category !== 'HEAD_OFFICE'));
  });

  readonly systemAdminsCount = computed(() => {
    return this.staffList().filter(s => s.category === 'SYSTEM_ADMIN' || ['SUPER_ADMIN', 'ADMIN'].includes(s.role)).length;
  });

  readonly headOfficeCount = computed(() => {
    return this.staffList().filter(s => s.category === 'HEAD_OFFICE' || ['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(s.role)).length;
  });

  readonly branchStaffCount = computed(() => {
    return this.staffList().filter(s => s.category === 'BRANCH_STAFF' || (!['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(s.role) && s.category !== 'SYSTEM_ADMIN' && s.category !== 'HEAD_OFFICE')).length;
  });

  readonly rolesCount = computed(() => {
    return this.rolesList().length;
  });

  // Staff Modals State
  showDetailsModal = signal<boolean>(false);
  selectedStaffForDetails = signal<UserStaff | null>(null);

  showIdCardModal = signal<boolean>(false);
  selectedStaffForCard = signal<UserStaff | null>(null);

  showEditModal = signal<boolean>(false);
  selectedStaffForEdit = signal<UserStaff | null>(null);
  isSavingStaff = signal<boolean>(false);
  editReason: string = '';
  editForm = {
    name: '',
    email: '',
    phone: '',
    nidNumber: '',
    category: 'BRANCH_STAFF' as UserCategory,
    role: 'FIELD_OFFICER' as StaffRole,
    branchId: 1,
    assignedCenterIds: [] as number[],
    salary: 25000,
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE'
  };

  showDeleteModal = signal<boolean>(false);
  staffToDelete = signal<UserStaff | null>(null);
  deleteReason: string = '';
  isDeletingStaff = signal<boolean>(false);

  // Role Modals State
  showAddRoleModal = signal<boolean>(false);
  showEditRoleModal = signal<boolean>(false);
  selectedRoleForEdit = signal<Role | null>(null);
  showDeleteRoleModal = signal<boolean>(false);
  roleToDelete = signal<Role | null>(null);
  isSavingRole = signal<boolean>(false);
  isDeletingRole = signal<boolean>(false);

  roleForm = {
    code: '',
    nameBn: '',
    nameEn: '',
    description: '',
    category: 'BRANCH_STAFF' as UserCategory,
    permissions: [] as string[],
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE'
  };
  roleEditReason: string = '';
  roleDeleteReason: string = '';

  async ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['tab'] === 'roles') {
        this.activeTab.set('roles');
      } else if (params['tab'] === 'admins') {
        this.activeTab.set('admins');
      } else if (params['tab'] === 'head_office') {
        this.activeTab.set('head_office');
      } else if (params['tab'] === 'branch_staff' || params['tab'] === 'staff') {
        this.activeTab.set('branch_staff');
      }
    });

    await this.loadAllData();
  }

  async loadAllData() {
    this.loading.set(true);
    try {
      const [branches, centers, customers, roles, staff] = await Promise.all([
        this.kistiService.getBranches(),
        this.kistiService.getCenters(),
        this.kistiService.getCustomers(),
        this.kistiService.getRoles(),
        this.kistiService.getStaff()
      ]);

      this.branches.set(branches);
      this.centers.set(centers);
      this.customers.set(customers);
      this.rolesList.set(roles);
      this.staffList.set(staff);

      // Sync active session users list with fresh database records
      this.authService.syncUsersFromDb(staff, roles);
    } catch (err) {
      console.error('Error loading initial data from Firestore:', err);
    } finally {
      this.loading.set(false);
    }
  }

  filteredStaff(): UserStaff[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.staffList();

    return this.staffList().filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.email.toLowerCase().includes(q) ||
      s.phone.includes(q) ||
      s.userId.toString().includes(q) ||
      (s.nidNumber && s.nidNumber.includes(q)) ||
      s.role.toLowerCase().includes(q)
    );
  }

  filteredRoles(): Role[] {
    const q = this.roleSearchQuery.trim().toLowerCase();
    if (!q) return this.rolesList();

    return this.rolesList().filter(r =>
      r.code.toLowerCase().includes(q) ||
      r.nameBn.toLowerCase().includes(q) ||
      r.nameEn.toLowerCase().includes(q) ||
      (r.description && r.description.toLowerCase().includes(q))
    );
  }
  getRoleBadgeClass(role: string): string {
    switch (role) {
      case 'SUPER_ADMIN': return 'badge-danger';
      case 'BRANCH_MANAGER': return 'badge-role';
      case 'FIELD_OFFICER': return 'badge-success';
      case 'CASHIER': return 'badge-warning';
      case 'AREA_MANAGER': return 'badge-info';
      case 'AUDITOR': return 'badge-secondary';
      default: return 'badge-primary';
    }
  }

  getRoleTitle(role: string): string {
    const found = this.rolesList().find(r => r.code === role);
    if (found) {
      return this.lang.isBangla() ? found.nameBn : found.nameEn;
    }
    switch (role) {
      case 'SUPER_ADMIN': return this.lang.isBangla() ? 'সুপার অ্যাডমিন' : 'Super Admin';
      case 'BRANCH_MANAGER': return this.lang.isBangla() ? 'শাখা ব্যবস্থাপক (BM)' : 'Branch Manager';
      case 'FIELD_OFFICER': return this.lang.isBangla() ? 'মাঠকর্মী (FO)' : 'Field Officer';
      case 'CASHIER': return this.lang.isBangla() ? 'ক্যাশিয়ার' : 'Cashier';
      case 'AREA_MANAGER': return this.lang.isBangla() ? 'এরিয়া ম্যানেজার' : 'Area Manager';
      case 'AUDITOR': return this.lang.isBangla() ? 'অডিটর' : 'Auditor';
      default: return role;
    }
  }

  // ==========================================
  // ROLE MANAGEMENT METHODS (পদবী ও রোল নিয়ন্ত্রণ)
  // ==========================================

  openAddRole(defaultCategory: UserCategory = 'BRANCH_STAFF') {
    this.roleForm = {
      code: '',
      nameBn: '',
      nameEn: '',
      description: '',
      category: defaultCategory,
      permissions: ['DASHBOARD_ACCESS', 'VIEW_CUSTOMERS'],
      status: 'ACTIVE'
    };
    this.showAddRoleModal.set(true);
  }

  closeAddRole() {
    this.showAddRoleModal.set(false);
    this.isSavingRole.set(false);
  }

  toggleRolePermission(key: string) {
    const idx = this.roleForm.permissions.indexOf(key);
    if (idx >= 0) {
      this.roleForm.permissions.splice(idx, 1);
    } else {
      this.roleForm.permissions.push(key);
    }
  }

  isRolePermissionSelected(key: string): boolean {
    return this.roleForm.permissions.includes(key);
  }

  async saveNewRole() {
    if (!this.roleForm.code.trim() || !this.roleForm.nameBn.trim() || !this.roleForm.nameEn.trim()) {
      alert(this.lang.isBangla() ? 'অনুগ্রহ করে রোল কোড, বাংলা ও ইংরেজি নাম প্রদান করুন।' : 'Please provide Role Code, Bangla and English title.');
      return;
    }

    const cleanCode = this.roleForm.code.trim().toUpperCase().replace(/\s+/g, '_');
    if (this.rolesList().some(r => r.code === cleanCode)) {
      alert(this.lang.isBangla() ? `রোল কোড "${cleanCode}" ইতিমধ্যে রয়েছে। অন্য কোড দিন।` : `Role code "${cleanCode}" already exists.`);
      return;
    }

    this.isSavingRole.set(true);
    const currentUser = this.authService.currentUser();

    try {
      const newRole = await this.kistiService.createRole(
        {
          code: cleanCode,
          nameBn: this.roleForm.nameBn.trim(),
          nameEn: this.roleForm.nameEn.trim(),
          description: this.roleForm.description.trim(),
          category: this.roleForm.category,
          permissions: [...this.roleForm.permissions],
          isSystem: false,
          status: this.roleForm.status
        },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        `সুপার অ্যাডমিন কর্তৃক নতুন পদবী/রোল (${cleanCode}) তৈরি`
      );

      this.rolesList.update(list => [...list, newRole]);
      this.authService.syncUsersFromDb(this.staffList(), this.rolesList());
      this.closeAddRole();

      alert(this.lang.isBangla() ? `নতুন পদবী "${newRole.nameBn}" সফলভাবে তৈরি হয়েছে!` : `Role "${newRole.nameEn}" created successfully!`);
    } catch (err) {
      console.error('Error creating role:', err);
      alert(this.lang.isBangla() ? 'রোল তৈরি করতে সমস্যা হয়েছে।' : 'Error creating role.');
    } finally {
      this.isSavingRole.set(false);
    }
  }

  openEditRole(role: Role) {
    this.selectedRoleForEdit.set(role);
    this.roleEditReason = '';
    this.roleForm = {
      code: role.code,
      nameBn: role.nameBn,
      nameEn: role.nameEn,
      description: role.description || '',
      category: role.category || 'BRANCH_STAFF',
      permissions: [...(role.permissions || [])],
      status: role.status
    };
    this.showEditRoleModal.set(true);
  }

  closeEditRole() {
    this.showEditRoleModal.set(false);
    this.selectedRoleForEdit.set(null);
    this.isSavingRole.set(false);
  }

  async saveEditRole() {
    const role = this.selectedRoleForEdit();
    if (!role) return;

    if (!this.roleForm.nameBn.trim() || !this.roleForm.nameEn.trim()) {
      alert(this.lang.isBangla() ? 'অনুগ্রহ করে পদবীর বাংলা ও ইংরেজি নাম দিন।' : 'Please provide Bangla and English title.');
      return;
    }

    this.isSavingRole.set(true);
    const currentUser = this.authService.currentUser();
    const reason = this.roleEditReason.trim() || 'পদবী ও অধিকার হালনাগাদ';

    try {
      const updatedFields: Partial<Role> = {
        nameBn: this.roleForm.nameBn.trim(),
        nameEn: this.roleForm.nameEn.trim(),
        description: this.roleForm.description.trim(),
        category: this.roleForm.category,
        permissions: [...this.roleForm.permissions],
        status: this.roleForm.status
      };

      await this.kistiService.updateRole(
        role.roleId,
        updatedFields,
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        reason
      );

      this.rolesList.update(list => list.map(r => r.roleId === role.roleId ? { ...r, ...updatedFields } : r));
      this.authService.syncUsersFromDb(this.staffList(), this.rolesList());
      this.closeEditRole();

      alert(this.lang.isBangla() ? `পদবী "${role.nameBn}" এর তথ্য সফলভাবে আপডেট হয়েছে!` : `Role updated successfully!`);
    } catch (err) {
      console.error('Error updating role:', err);
      alert(this.lang.isBangla() ? 'পদবী তথ্য হালনাগাদ করতে সমস্যা হয়েছে।' : 'Error updating role.');
    } finally {
      this.isSavingRole.set(false);
    }
  }

  openDeleteRole(role: Role) {
    if (role.isSystem) {
      alert(this.lang.isBangla() ? 'সিস্টেমের মূল পদবী ডিলিট করা সম্ভব নয়।' : 'System default roles cannot be deleted.');
      return;
    }

    const staffWithRole = this.staffList().filter(s => s.role === role.code);
    if (staffWithRole.length > 0) {
      alert(
        this.lang.isBangla()
          ? `এই পদবীতে বর্তমানে ${staffWithRole.length} জন কর্মী নিযুক্ত আছেন। প্রথমে কর্মীদের পদবী পরিবর্তন করুন।`
          : `Cannot delete: ${staffWithRole.length} staff member(s) are currently assigned to this role.`
      );
      return;
    }

    this.roleToDelete.set(role);
    this.roleDeleteReason = '';
    this.showDeleteRoleModal.set(true);
  }

  closeDeleteRole() {
    this.showDeleteRoleModal.set(false);
    this.roleToDelete.set(null);
    this.isDeletingRole.set(false);
  }

  async confirmDeleteRole() {
    const role = this.roleToDelete();
    if (!role) return;

    if (!this.roleDeleteReason.trim()) {
      alert(this.lang.isBangla() ? 'পদবী বাতিলের কারণ উল্লেখ করুন।' : 'Please provide reason for deletion.');
      return;
    }

    this.isDeletingRole.set(true);
    const currentUser = this.authService.currentUser();

    try {
      await this.kistiService.softDeleteRole(
        role.roleId,
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        this.roleDeleteReason.trim()
      );

      this.rolesList.update(list => list.filter(r => r.roleId !== role.roleId));
      this.closeDeleteRole();

      alert(this.lang.isBangla() ? `পদবী "${role.nameBn}" সফট-ডিলিট করা হয়েছে।` : `Role deleted successfully.`);
    } catch (err) {
      console.error('Error deleting role:', err);
      alert(this.lang.isBangla() ? 'পদবী ডিলিট করতে সমস্যা হয়েছে।' : 'Error deleting role.');
    } finally {
      this.isDeletingRole.set(false);
    }
  }

  async toggleRoleStatus(role: Role) {
    const newStatus = role.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const currentUser = this.authService.currentUser();
    const reason = `রোল স্ট্যাটাস পরিবর্তন: ${newStatus}`;

    try {
      await this.kistiService.updateRole(
        role.roleId,
        { status: newStatus },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        reason
      );

      this.rolesList.update(list => list.map(r => r.roleId === role.roleId ? { ...r, status: newStatus } : r));
    } catch (err) {
      console.error('Error toggling role status:', err);
      alert(this.lang.isBangla() ? 'স্ট্যাটাস পরিবর্তনে সমস্যা হয়েছে।' : 'Error changing role status.');
    }
  }

  getStaffCountForRole(roleCode: string): number {
    return this.staffList().filter(s => s.role === roleCode).length;
  }

  getBranchName(branchId: number): string {
    const b = this.branches().find(item => item.branchId === branchId);
    if (!b) return `শাখা #${branchId}`;
    return `${b.name} (#${b.branchId})`;
  }

  getCenterName(centerId: number): string {
    const c = this.centers().find(item => item.centerId === centerId);
    return c ? c.name : `সমিতি #${centerId}`;
  }

  getStaffBranch(branchId: number): Branch | undefined {
    return this.branches().find(b => b.branchId === branchId);
  }

  getStaffAssignedCenters(staff: UserStaff): CenterOrSamity[] {
    const assignedIds = staff.assignedCenterIds || [];
    return this.centers().filter(c => 
      assignedIds.includes(c.centerId) || c.fieldOfficerUserId === staff.userId
    );
  }

  getStaffAssignedCustomers(staff: UserStaff): Customer[] {
    const assignedCenterIds = (this.getStaffAssignedCenters(staff)).map(c => c.centerId);
    return this.customers().filter(c => 
      c.assignedFieldOfficerId === staff.userId || assignedCenterIds.includes(c.centerId)
    );
  }

  getStaffTotalSavings(custs: Customer[]): number {
    return custs.reduce((sum, c) => sum + (c.totalSavingsBalance || 0), 0);
  }

  getStaffTotalLoans(custs: Customer[]): number {
    return custs.reduce((sum, c) => sum + (c.totalLoansTaken || 0), 0);
  }

  // ==========================================
  // VIEW DETAILS MODAL
  // ==========================================
  openStaffDetails(staff: UserStaff) {
    this.selectedStaffForDetails.set(staff);
    this.showDetailsModal.set(true);
  }

  closeStaffDetails() {
    this.showDetailsModal.set(false);
    this.selectedStaffForDetails.set(null);
  }

  // ==========================================
  // PRINT ID CARD MODAL
  // ==========================================
  openIdCard(staff: UserStaff) {
    this.selectedStaffForCard.set(staff);
    this.showIdCardModal.set(true);
  }

  closeIdCard() {
    this.showIdCardModal.set(false);
    this.selectedStaffForCard.set(null);
  }

  printIdCard() {
    window.print();
  }

  // ==========================================
  // EDIT STAFF MODAL
  // ==========================================
  openEditStaff(staff: UserStaff) {
    this.selectedStaffForEdit.set(staff);
    this.editReason = '';
    const category: UserCategory = staff.category || (
      ['SUPER_ADMIN', 'ADMIN'].includes(staff.role)
        ? 'SYSTEM_ADMIN'
        : (['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(staff.role) ? 'HEAD_OFFICE' : 'BRANCH_STAFF')
    );
    this.editForm = {
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      nidNumber: staff.nidNumber || '',
      category,
      role: staff.role,
      branchId: staff.branchId,
      assignedCenterIds: [...(staff.assignedCenterIds || [])],
      salary: staff.salary || 25000,
      status: (staff.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE') as 'ACTIVE' | 'INACTIVE'
    };
    this.showEditModal.set(true);
  }

  closeEditStaff() {
    this.showEditModal.set(false);
    this.selectedStaffForEdit.set(null);
    this.isSavingStaff.set(false);
  }

  isCenterAssigned(centerId: number): boolean {
    return this.editForm.assignedCenterIds.includes(centerId);
  }

  toggleCenterAssignment(centerId: number) {
    const idx = this.editForm.assignedCenterIds.indexOf(centerId);
    if (idx > -1) {
      this.editForm.assignedCenterIds.splice(idx, 1);
    } else {
      this.editForm.assignedCenterIds.push(centerId);
    }
  }

  getAvailableCentersForSelectedBranch(): CenterOrSamity[] {
    return this.centers().filter(c => c.branchId === this.editForm.branchId);
  }

  async saveEditStaff() {
    const staff = this.selectedStaffForEdit();
    if (!staff) return;

    if (!this.editForm.name.trim() || !this.editForm.phone.trim()) {
      alert(this.lang.isBangla() ? 'অনুগ্রহ করে কর্মীর নাম ও ফোন নম্বর লিখুন' : 'Please provide staff name and phone');
      return;
    }

    this.isSavingStaff.set(true);
    const currentUser = this.authService.currentUser();
    const reason = this.editReason.trim() || 'স্টাফ তথ্য ও কাজের এলাকা হালনাগাদ';

    try {
      const isSystemOrHO = this.editForm.category === 'SYSTEM_ADMIN' || this.editForm.category === 'HEAD_OFFICE';
      const branchId = isSystemOrHO ? 0 : Number(this.editForm.branchId);
      const branchName = this.editForm.category === 'SYSTEM_ADMIN'
        ? 'সিস্টেম প্রশাসন (সর্বজনীন)'
        : (this.editForm.category === 'HEAD_OFFICE' ? 'প্রধান কার্যালয় (হেড অফিস)' : this.getBranchName(branchId));

      const updatedFields: Partial<UserStaff> = {
        name: this.editForm.name.trim(),
        email: this.editForm.email.trim(),
        phone: this.editForm.phone.trim(),
        nidNumber: this.editForm.nidNumber.trim(),
        category: this.editForm.category,
        role: this.editForm.role,
        branchId,
        branchName,
        assignedCenterIds: isSystemOrHO ? [] : [...this.editForm.assignedCenterIds],
        salary: Number(this.editForm.salary),
        status: this.editForm.status
      };

      await this.kistiService.updateStaff(
        staff.userId,
        updatedFields,
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        reason
      );

      // Update in local list
      this.staffList.update(list => list.map(item => {
        if (item.userId === staff.userId) {
          return { ...item, ...updatedFields };
        }
        return item;
      }));
      this.authService.syncUsersFromDb(this.staffList(), this.rolesList());

      this.closeEditStaff();
      alert(this.lang.isBangla() ? `কর্মী #${staff.userId} এর তথ্য সফলভাবে আপডেট হয়েছে` : `Staff #${staff.userId} updated successfully`);
    } catch (err) {
      console.error('Error saving staff edit:', err);
      alert(this.lang.isBangla() ? 'তথ্য সংরক্ষণ করতে ত্রুটি হয়েছে' : 'Error updating staff record');
    } finally {
      this.isSavingStaff.set(false);
    }
  }

  getCategoryLabel(category?: UserCategory): string {
    switch (category) {
      case 'SYSTEM_ADMIN': return this.lang.isBangla() ? 'সিস্টেম প্রশাসন' : 'System Admin';
      case 'HEAD_OFFICE': return this.lang.isBangla() ? 'প্রধান কার্যালয়' : 'Head Office';
      case 'BRANCH_STAFF': return this.lang.isBangla() ? 'শাখা ও মাঠকর্মী' : 'Branch Staff';
      default: return this.lang.isBangla() ? 'শাখা ও মাঠকর্মী' : 'Branch Staff';
    }
  }

  getCategoryBadgeClass(category?: UserCategory): string {
    switch (category) {
      case 'SYSTEM_ADMIN': return 'badge-cat-admin';
      case 'HEAD_OFFICE': return 'badge-cat-ho';
      case 'BRANCH_STAFF': return 'badge-cat-branch';
      default: return 'badge-cat-branch';
    }
  }

  // ==========================================
  // DELETE STAFF MODAL
  // ==========================================
  openDeleteStaff(staff: UserStaff) {
    this.staffToDelete.set(staff);
    this.deleteReason = '';
    this.showDeleteModal.set(true);
  }

  closeDeleteStaff() {
    this.showDeleteModal.set(false);
    this.staffToDelete.set(null);
    this.isDeletingStaff.set(false);
  }

  async confirmDeleteStaff() {
    const staff = this.staffToDelete();
    if (!staff) return;

    if (!this.deleteReason.trim()) {
      alert(this.lang.isBangla() ? 'অনুগ্রহ করে কর্মী বাতিলের কারণ উল্লেখ করুন' : 'Please provide reason for deletion');
      return;
    }

    this.isDeletingStaff.set(true);
    const currentUser = this.authService.currentUser();

    try {
      await this.kistiService.softDeleteStaff(
        staff.userId,
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        this.deleteReason.trim()
      );

      this.staffList.update(list => list.filter(item => item.userId !== staff.userId));
      this.closeDeleteStaff();
      alert(this.lang.isBangla() ? `কর্মী #${staff.userId} সফলভাবে সফট-ডিলিট করা হয়েছে` : `Staff #${staff.userId} deleted successfully`);
    } catch (err) {
      console.error('Delete staff error:', err);
      alert(this.lang.isBangla() ? 'কর্মী ডিলিট করতে ত্রুটি হয়েছে' : 'Error deleting staff');
    } finally {
      this.isDeletingStaff.set(false);
    }
  }

  // ==========================================
  // QUICK ACTIVE / INACTIVE TOGGLE
  // ==========================================
  async toggleUserStatus(user: UserStaff) {
    if (!this.authService.canManageUsers()) {
      alert(this.lang.isBangla() ? 'শুধুমাত্র অনুমোদিত ব্যবহারকারী স্ট্যাটাস পরিবর্তন করতে পারেন' : 'Access denied');
      return;
    }

    const newStatus = user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const reason = `স্ট্যাটাস পরিবর্তন: ${newStatus}`;
    const currentUser = this.authService.currentUser();

    try {
      await this.kistiService.updateStaff(
        user.userId,
        { status: newStatus },
        { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
        reason
      );

      // Instant local update
      this.staffList.update(list => list.map(item => {
        if (item.userId === user.userId) {
          return { ...item, status: newStatus };
        }
        return item;
      }));
    } catch (err) {
      console.error('Toggle error:', err);
      alert(this.lang.isBangla() ? 'স্ট্যাটাস পরিবর্তনে সমস্যা হয়েছে' : 'Error toggling status');
    }
  }
}
