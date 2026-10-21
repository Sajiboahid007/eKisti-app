import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule, ActivatedRoute } from '@angular/router';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { StaffRole, UserStaff, Role, Branch, UserCategory } from '../../../core/models/database.models';

@Component({
  selector: 'app-user-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './user-form.component.html',
  styleUrl: './user-form.component.scss'
})
export class UserFormComponent implements OnInit {
  private kistiService = inject(KistiDatabaseService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  submitting = signal<boolean>(false);
  loadingRoles = signal<boolean>(true);
  dynamicRoles = signal<Role[]>([]);
  branches = signal<Branch[]>([]);

  // Form Model with 3-Tier Category Separation
  category: UserCategory = 'BRANCH_STAFF';
  name: string = '';
  email: string = '';
  phone: string = '';
  password: string = '123456';
  role: StaffRole = 'FIELD_OFFICER';
  branchId: number = 1;
  nidNumber: string = '';
  salary: number = 25000;
  status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE';

  async ngOnInit() {
    this.route.queryParams.subscribe(params => {
      if (params['category']) {
        const cat = params['category'] as UserCategory;
        if (['SYSTEM_ADMIN', 'HEAD_OFFICE', 'BRANCH_STAFF'].includes(cat)) {
          this.category = cat;
          if (cat === 'SYSTEM_ADMIN' || cat === 'HEAD_OFFICE') {
            this.branchId = 0;
          }
        }
      }
    });

    await this.loadInitialData();
  }

  async loadInitialData() {
    this.loadingRoles.set(true);
    try {
      const [roles, branches] = await Promise.all([
        this.kistiService.getRoles(),
        this.kistiService.getBranches()
      ]);
      const activeRoles = roles.filter(r => r.status === 'ACTIVE');
      this.dynamicRoles.set(activeRoles);
      this.branches.set(branches);

      this.selectDefaultRoleForCategory();
    } catch (err) {
      console.error('Error loading roles & branches from database:', err);
    } finally {
      this.loadingRoles.set(false);
    }
  }

  onCategoryChange(newCat: UserCategory) {
    this.category = newCat;
    if (newCat === 'SYSTEM_ADMIN' || newCat === 'HEAD_OFFICE') {
      this.branchId = 0;
    } else {
      this.branchId = this.branches().length > 0 ? this.branches()[0].branchId : 1;
    }
    this.selectDefaultRoleForCategory();
  }

  filteredRolesByCategory(): Role[] {
    return this.dynamicRoles().filter(r => {
      if (r.category) {
        return r.category === this.category;
      }
      // Safe fallback inference
      if (this.category === 'SYSTEM_ADMIN') {
        return ['SUPER_ADMIN', 'ADMIN'].includes(r.code);
      } else if (this.category === 'HEAD_OFFICE') {
        return ['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(r.code);
      } else {
        return !['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(r.code);
      }
    });
  }

  selectDefaultRoleForCategory() {
    const list = this.filteredRolesByCategory();
    if (list.length > 0) {
      this.role = list[0].code as StaffRole;
    }
  }

  getBranchName(id: number): string {
    const b = this.branches().find(item => item.branchId === Number(id));
    return b ? b.name : 'মিরপুর শাখা';
  }

  async onSubmit() {
    if (!this.name.trim() || !this.phone.trim() || !this.email.trim()) {
      alert(this.lang.isBangla() ? 'অনুগ্রহ করে নাম, মোবাইল এবং ইমেইল প্রদান করুন' : 'Please provide name, phone and email');
      return;
    }

    if (!this.authService.isSuperAdmin() && !this.authService.isAdmin()) {
      alert(this.lang.isBangla() ? 'শুধুমাত্র সিস্টেম অ্যাডমিন নতুন ইউজার তৈরি করতে পারেন' : 'Admin access only');
      return;
    }

    this.submitting.set(true);
    const currentUser = this.authService.currentUser();
    const now = new Date().toISOString();

    const isSystemOrHO = this.category === 'SYSTEM_ADMIN' || this.category === 'HEAD_OFFICE';
    const branchId = isSystemOrHO ? 0 : Number(this.branchId);
    const branchName = this.category === 'SYSTEM_ADMIN'
      ? 'সিস্টেম প্রশাসন (সর্বজনীন)'
      : (this.category === 'HEAD_OFFICE' ? 'প্রধান কার্যালয় (হেড অফিস)' : this.getBranchName(branchId));

    try {
      // 1. Create Staff directly in database (Firestore) with proper 3-Tier separation
      const newStaffDoc = await this.kistiService.createStaff(
        {
          firebaseAuthUid: '',
          name: this.name.trim(),
          email: this.email.trim(),
          phone: this.phone.trim(),
          category: this.category,
          role: this.role,
          branchId,
          branchName,
          assignedCenterIds: (!isSystemOrHO && this.role === 'FIELD_OFFICER') ? [101] : [],
          nidNumber: this.nidNumber.trim() || `19852692518000${Date.now().toString().slice(-3)}`,
          salary: Number(this.salary) || (this.category === 'SYSTEM_ADMIN' ? 70000 : (this.category === 'HEAD_OFFICE' ? 50000 : 25000)),
          status: this.status,
          joinedDate: now.split('T')[0]
        },
        {
          userId: currentUser.userId,
          name: currentUser.name,
          role: currentUser.role
        },
        `সিস্টেম অ্যাডমিন কর্তৃক নতুন ব্যবহারকারী (${this.name} - ${this.role} [${this.category}]) নিবন্ধন`
      );

      // 2. Synchronize active in-memory user sessions with selected dynamic role
      const matchedRole = this.dynamicRoles().find(r => r.code === this.role);
      this.authService.syncUserFromDb(newStaffDoc, matchedRole);

      alert(
        this.lang.isBangla()
          ? `অভিনন্দন! নতুন ব্যবহারকারী #${newStaffDoc.userId} (${this.name}) সফলভাবে সংরক্ষিত হয়েছে!`
          : `Success! New User #${newStaffDoc.userId} (${this.name}) has been saved to database!`
      );

      const targetTab = this.category === 'SYSTEM_ADMIN' ? 'admins' : (this.category === 'HEAD_OFFICE' ? 'head_office' : 'branch_staff');
      this.router.navigate(['/users'], { queryParams: { tab: targetTab } });
    } catch (err) {
      console.error('Error creating user in database:', err);
      alert('ইউজার তৈরিতে সমস্যা হয়েছে');
    } finally {
      this.submitting.set(false);
    }
  }
}
