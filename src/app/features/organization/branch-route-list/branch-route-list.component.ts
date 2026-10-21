import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { Branch, CenterOrSamity, UserStaff } from '../../../core/models/database.models';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';

@Component({
  selector: 'app-branch-route-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './branch-route-list.component.html',
  styleUrl: './branch-route-list.component.scss'
})
export class BranchRouteListComponent implements OnInit {
  private kistiService = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly branches = signal<Branch[]>([]);
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly staffList = signal<UserStaff[]>([]);
  readonly loading = signal<boolean>(true);
  readonly activeTab = signal<'branches' | 'routes'>('routes');

  // Modals state
  showBranchModal = signal<boolean>(false);
  branchModalMode = signal<'CREATE' | 'EDIT'>('CREATE');
  selectedBranchForEdit = signal<Branch | null>(null);

  showRouteModal = signal<boolean>(false);
  routeModalMode = signal<'CREATE' | 'EDIT'>('CREATE');
  selectedRouteForEdit = signal<CenterOrSamity | null>(null);

  showDeleteModal = signal<boolean>(false);
  deleteItem = signal<{ type: 'branch' | 'route'; id: number; name: string } | null>(null);
  deleteReason: string = '';

  isSubmitting = signal<boolean>(false);
  successMessage = signal<string>('');
  editReason: string = '';

  // Filters & Search
  searchQuery: string = '';
  filterBranchId: number = 0; // 0 = all
  filterStatus: 'ALL' | 'ACTIVE' | 'INACTIVE' = 'ALL';

  // Branch Form Model
  branchForm = {
    name: '',
    branchCode: '',
    regionName: 'ঢাকা বিভাগ',
    areaName: 'মিরপুর জোন',
    address: '',
    phone: '',
    managerUserId: 501,
    cashierUserId: 503,
    currentVaultCash: 100000,
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE'
  };

  // Route / Village / Samity Form Model
  routeForm = {
    name: '',
    centerCode: '',
    branchId: 1,
    fieldOfficerUserId: 502,
    meetingDay: 'Monday' as CenterOrSamity['meetingDay'],
    meetingTime: '10:00 AM',
    location: '',
    totalMembers: 20,
    status: 'ACTIVE' as 'ACTIVE' | 'INACTIVE'
  };

  readonly fieldOfficers = computed(() => {
    return this.authService.availableUsers().filter(u => u.role === 'FIELD_OFFICER' || u.role === 'BRANCH_MANAGER' || u.role === 'SUPER_ADMIN');
  });

  readonly managers = computed(() => {
    return this.authService.availableUsers().filter(u => u.role === 'BRANCH_MANAGER' || u.role === 'SUPER_ADMIN' || u.role === 'AREA_MANAGER');
  });

  async ngOnInit() {
    await this.loadAll();
  }

  async loadAll() {
    this.loading.set(true);
    try {
      const [branchData, centerData] = await Promise.all([
        this.kistiService.getBranches(),
        this.kistiService.getCenters()
      ]);
      this.branches.set(branchData);
      this.centers.set(centerData);

      if (branchData.length > 0 && !this.routeForm.branchId) {
        this.routeForm.branchId = branchData[0].branchId;
      }
    } catch (err) {
      console.error('Error loading organization data:', err);
    } finally {
      this.loading.set(false);
    }
  }

  getBranchName(branchId: number): string {
    const b = this.branches().find(x => x.branchId === branchId);
    return b ? b.name : `Branch #${branchId}`;
  }

  getStaffName(userId: number): string {
    const s = this.authService.availableUsers().find(x => x.userId === userId);
    return s ? `${s.name}` : `User #${userId}`;
  }

  filteredBranches(): Branch[] {
    let list = this.branches();
    if (this.filterStatus !== 'ALL') {
      list = list.filter(b => (b.status || 'ACTIVE') === this.filterStatus);
    }
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(b => 
      b.name.toLowerCase().includes(q) ||
      b.branchCode.toLowerCase().includes(q) ||
      b.areaName.toLowerCase().includes(q) ||
      b.regionName.toLowerCase().includes(q)
    );
  }

  filteredCenters(): CenterOrSamity[] {
    let list = this.centers();
    if (this.filterBranchId > 0) {
      list = list.filter(c => c.branchId === Number(this.filterBranchId));
    }
    if (this.filterStatus !== 'ALL') {
      list = list.filter(c => (c.status || 'ACTIVE') === this.filterStatus);
    }
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(c => 
      c.name.toLowerCase().includes(q) ||
      c.centerCode.toLowerCase().includes(q) ||
      c.location.toLowerCase().includes(q)
    );
  }

  // ==========================================
  // BRANCH ACTIONS (Create, Edit, Toggle, Delete)
  // ==========================================

  openCreateBranchModal() {
    this.branchModalMode.set('CREATE');
    this.selectedBranchForEdit.set(null);
    this.editReason = '';
    const nextCode = `BR-0${this.branches().length + 1}`;
    this.branchForm = {
      name: '',
      branchCode: nextCode,
      regionName: 'ঢাকা বিভাগ',
      areaName: '',
      address: '',
      phone: '',
      managerUserId: 501,
      cashierUserId: 503,
      currentVaultCash: 100000,
      status: 'ACTIVE'
    };
    this.showBranchModal.set(true);
  }

  openEditBranchModal(branch: Branch) {
    this.branchModalMode.set('EDIT');
    this.selectedBranchForEdit.set(branch);
    this.editReason = 'শাখার তথ্যাদি হালনাগাদ';
    this.branchForm = {
      name: branch.name,
      branchCode: branch.branchCode,
      regionName: branch.regionName || '',
      areaName: branch.areaName || '',
      address: branch.address || '',
      phone: branch.phone || '',
      managerUserId: branch.managerUserId || 501,
      cashierUserId: branch.cashierUserId || 503,
      currentVaultCash: branch.currentVaultCash || 0,
      status: branch.status || 'ACTIVE'
    };
    this.showBranchModal.set(true);
  }

  async submitBranchForm() {
    if (!this.branchForm.name.trim()) return;

    this.isSubmitting.set(true);
    const currentUser = {
      userId: this.authService.currentUser().userId,
      name: this.authService.currentUser().name,
      role: this.authService.currentUser().role
    };

    try {
      if (this.branchModalMode() === 'CREATE') {
        const created = await this.kistiService.createBranch({
          name: this.branchForm.name.trim(),
          branchCode: this.branchForm.branchCode.trim(),
          regionName: this.branchForm.regionName,
          areaName: this.branchForm.areaName,
          address: this.branchForm.address,
          phone: this.branchForm.phone,
          managerUserId: Number(this.branchForm.managerUserId),
          cashierUserId: Number(this.branchForm.cashierUserId),
          currentVaultCash: Number(this.branchForm.currentVaultCash) || 0,
          status: this.branchForm.status
        }, currentUser);

        this.branches.update(prev => [...prev, created]);
        this.showToast(`শাখা "${created.name}" সফলভাবে ডাটাবেজে তৈরি হয়েছে (ID: #${created.branchId})`);
      } else {
        const branch = this.selectedBranchForEdit();
        if (!branch) return;

        const updatedFields: Partial<Branch> = {
          name: this.branchForm.name.trim(),
          branchCode: this.branchForm.branchCode.trim(),
          regionName: this.branchForm.regionName,
          areaName: this.branchForm.areaName,
          address: this.branchForm.address,
          phone: this.branchForm.phone,
          managerUserId: Number(this.branchForm.managerUserId),
          cashierUserId: Number(this.branchForm.cashierUserId),
          currentVaultCash: Number(this.branchForm.currentVaultCash) || 0,
          status: this.branchForm.status
        };

        await this.kistiService.updateBranch(
          branch.branchId,
          updatedFields,
          currentUser,
          this.editReason || 'শাখা তথ্য সংশোধন'
        );

        this.branches.update(prev => prev.map(b => b.branchId === branch.branchId ? { ...b, ...updatedFields } : b));
        this.showToast(`শাখা "${updatedFields.name}" সফলভাবে আপডেট করা হয়েছে`);
      }

      this.showBranchModal.set(false);
    } catch (err: any) {
      alert('শাখা সংরক্ষণ ব্যর্থ হয়েছে: ' + (err.message || err));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  async toggleBranchStatus(branch: Branch) {
    const newStatus = (branch.status || 'ACTIVE') === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const currentUser = {
      userId: this.authService.currentUser().userId,
      name: this.authService.currentUser().name,
      role: this.authService.currentUser().role
    };

    try {
      await this.kistiService.updateBranch(
        branch.branchId,
        { status: newStatus },
        currentUser,
        `স্ট্যাটাস পরিবর্তন: ${newStatus}`
      );
      this.branches.update(prev => prev.map(b => b.branchId === branch.branchId ? { ...b, status: newStatus } : b));
      this.showToast(`শাখা "${branch.name}" এখন ${newStatus === 'ACTIVE' ? 'সক্রিয় (Active)' : 'নিষ্ক্রিয় (Inactive)'}`);
    } catch (err: any) {
      alert('স্ট্যাটাস পরিবর্তন ব্যর্থ হয়েছে: ' + (err.message || err));
    }
  }

  // ==========================================
  // ROUTE / SAMITY ACTIONS (Create, Edit, Toggle, Delete)
  // ==========================================

  openCreateRouteModal() {
    this.routeModalMode.set('CREATE');
    this.selectedRouteForEdit.set(null);
    this.editReason = '';
    const nextCode = `CEN-${101 + this.centers().length}`;
    this.routeForm = {
      name: '',
      centerCode: nextCode,
      branchId: this.branches().length > 0 ? this.branches()[0].branchId : 1,
      fieldOfficerUserId: 502,
      meetingDay: 'Monday',
      meetingTime: '10:00 AM',
      location: '',
      totalMembers: 20,
      status: 'ACTIVE'
    };
    this.showRouteModal.set(true);
  }

  openEditRouteModal(center: CenterOrSamity) {
    this.routeModalMode.set('EDIT');
    this.selectedRouteForEdit.set(center);
    this.editReason = 'রুট/সমিতি তথ্য হালনাগাদ';
    this.routeForm = {
      name: center.name,
      centerCode: center.centerCode,
      branchId: center.branchId,
      fieldOfficerUserId: center.fieldOfficerUserId || 502,
      meetingDay: center.meetingDay,
      meetingTime: center.meetingTime || '10:00 AM',
      location: center.location,
      totalMembers: center.totalMembers || 0,
      status: center.status || 'ACTIVE'
    };
    this.showRouteModal.set(true);
  }

  async submitRouteForm() {
    if (!this.routeForm.name.trim() || !this.routeForm.location.trim()) return;

    this.isSubmitting.set(true);
    const currentUser = {
      userId: this.authService.currentUser().userId,
      name: this.authService.currentUser().name,
      role: this.authService.currentUser().role
    };

    try {
      if (this.routeModalMode() === 'CREATE') {
        const created = await this.kistiService.createCenterOrRoute({
          name: this.routeForm.name.trim(),
          centerCode: this.routeForm.centerCode.trim(),
          branchId: Number(this.routeForm.branchId),
          fieldOfficerUserId: Number(this.routeForm.fieldOfficerUserId),
          meetingDay: this.routeForm.meetingDay,
          meetingTime: this.routeForm.meetingTime,
          location: this.routeForm.location.trim(),
          totalMembers: Number(this.routeForm.totalMembers) || 0,
          activeLoansCount: 0,
          status: this.routeForm.status
        }, currentUser);

        this.centers.update(prev => [...prev, created]);
        this.showToast(`রুট/সমিতি "${created.name}" ডাটাবেজে যুক্ত হয়েছে (ID: #${created.centerId})`);
      } else {
        const center = this.selectedRouteForEdit();
        if (!center) return;

        const updatedFields: Partial<CenterOrSamity> = {
          name: this.routeForm.name.trim(),
          centerCode: this.routeForm.centerCode.trim(),
          branchId: Number(this.routeForm.branchId),
          fieldOfficerUserId: Number(this.routeForm.fieldOfficerUserId),
          meetingDay: this.routeForm.meetingDay,
          meetingTime: this.routeForm.meetingTime,
          location: this.routeForm.location.trim(),
          totalMembers: Number(this.routeForm.totalMembers) || 0,
          status: this.routeForm.status
        };

        await this.kistiService.updateCenter(
          center.centerId,
          updatedFields,
          currentUser,
          this.editReason || 'রুট তথ্য সংশোধন'
        );

        this.centers.update(prev => prev.map(c => c.centerId === center.centerId ? { ...c, ...updatedFields } : c));
        this.showToast(`রুট/সমিতি "${updatedFields.name}" সফলভাবে আপডেট করা হয়েছে`);
      }

      this.showRouteModal.set(false);
    } catch (err: any) {
      alert('রুট সংরক্ষণ ব্যর্থ হয়েছে: ' + (err.message || err));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  async toggleRouteStatus(center: CenterOrSamity) {
    const newStatus = (center.status || 'ACTIVE') === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const currentUser = {
      userId: this.authService.currentUser().userId,
      name: this.authService.currentUser().name,
      role: this.authService.currentUser().role
    };

    try {
      await this.kistiService.updateCenter(
        center.centerId,
        { status: newStatus },
        currentUser,
        `স্ট্যাটাস পরিবর্তন: ${newStatus}`
      );
      this.centers.update(prev => prev.map(c => c.centerId === center.centerId ? { ...c, status: newStatus } : c));
      this.showToast(`রুট "${center.name}" এখন ${newStatus === 'ACTIVE' ? 'সক্রিয় (Active)' : 'নিষ্ক্রিয় (Inactive)'}`);
    } catch (err: any) {
      alert('স্ট্যাটাস পরিবর্তন ব্যর্থ হয়েছে: ' + (err.message || err));
    }
  }

  // ==========================================
  // DELETE DIALOG & EXECUTION
  // ==========================================

  openDeleteDialog(type: 'branch' | 'route', id: number, name: string) {
    this.deleteItem.set({ type, id, name });
    this.deleteReason = '';
    this.showDeleteModal.set(true);
  }

  async executeDelete() {
    const item = this.deleteItem();
    if (!item) return;

    this.isSubmitting.set(true);
    const currentUser = {
      userId: this.authService.currentUser().userId,
      name: this.authService.currentUser().name,
      role: this.authService.currentUser().role
    };

    try {
      if (item.type === 'branch') {
        await this.kistiService.softDeleteBranch(
          item.id,
          currentUser,
          this.deleteReason || 'শাখা ডিলিট করা হয়েছে'
        );
        this.branches.update(prev => prev.filter(b => b.branchId !== item.id));
        this.showToast(`শাখা "${item.name}" সফলভাবে মুছে ফেলা হয়েছে`);
      } else {
        await this.kistiService.softDeleteCenter(
          item.id,
          currentUser,
          this.deleteReason || 'রুট/সমিতি ডিলিট করা হয়েছে'
        );
        this.centers.update(prev => prev.filter(c => c.centerId !== item.id));
        this.showToast(`রুট/সমিতি "${item.name}" সফলভাবে মুছে ফেলা হয়েছে`);
      }
      this.showDeleteModal.set(false);
    } catch (err: any) {
      alert('মুছে ফেলা ব্যর্থ হয়েছে: ' + (err.message || err));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  private showToast(msg: string) {
    this.successMessage.set(msg);
    setTimeout(() => {
      this.successMessage.set('');
    }, 4500);
  }
}
