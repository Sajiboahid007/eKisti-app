import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule, ActivatedRoute } from '@angular/router';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService, AREA_SCOPED_ROLES } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { StaffRole, UserStaff, Role, Branch, UserCategory, StaffAddress, StaffEmergencyContact } from '../../../core/models/database.models';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';
import { ToastService } from '../../../core/services/toast.service';
import { toDhakaDayKey } from '../../../core/finance/dates';
import { isValidBdMobile } from '../../../core/finance/validation';
import { StaffCredentialService, MIN_PASSWORD_LENGTH } from '../../../core/services/staff-credential.service';

type StaffProfileFields = Pick<UserStaff,
  'fatherName' | 'motherName' | 'dateOfBirth' | 'gender' | 'bloodGroup' | 'maritalStatus' |
  'educationalQualification' | 'phoneSecondary' | 'homeTown' | 'presentAddress' | 'permanentAddress' | 'emergencyContact'>;

const emptyAddress = (): StaffAddress => ({ villageOrStreet: '', postOffice: '', thanaOrUpazila: '', district: '' });

@Component({
  selector: 'app-user-form',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './user-form.component.html',
  styleUrl: './user-form.component.scss'
})
export class UserFormComponent implements OnInit {
  private kistiService = inject(KistiDatabaseService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);
  private toast = inject(ToastService);
  private credentials = inject(StaffCredentialService);

  readonly bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

  submitting = signal<boolean>(false);
  loadingRoles = signal<boolean>(true);
  showPassword = signal<boolean>(false);
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
  assignedBranchIds: number[] = [];   // এরিয়া/রিজিওনাল ম্যানেজারের শাখাসমূহ

  // ব্যক্তিগত তথ্য ও ঠিকানা (সব ঐচ্ছিক)
  fatherName: string = '';
  motherName: string = '';
  dateOfBirth: string = '';
  gender: '' | 'MALE' | 'FEMALE' | 'OTHER' = '';
  bloodGroup: string = '';
  maritalStatus: '' | 'SINGLE' | 'MARRIED' | 'OTHER' = '';
  educationalQualification: string = '';
  phoneSecondary: string = '';
  homeTown: string = '';
  presentAddress: StaffAddress = emptyAddress();
  permanentAddress: StaffAddress = emptyAddress();
  permanentSameAsPresent: boolean = false;
  emergencyContact: StaffEmergencyContact = { name: '', relation: '', phone: '' };

  get isAreaRole(): boolean {
    return AREA_SCOPED_ROLES.includes(this.role);
  }

  togglePasswordVisibility() {
    this.showPassword.update(v => !v);
  }

  toggleAssignedBranch(branchId: number) {
    this.assignedBranchIds = this.assignedBranchIds.includes(branchId)
      ? this.assignedBranchIds.filter(id => id !== branchId)
      : [...this.assignedBranchIds, branchId];
  }

  /** "বর্তমান ঠিকানার মতো" — চেক করলে বর্তমান ঠিকানা স্থায়ী ঠিকানায় কপি হয় */
  onPermanentSameChange(checked: boolean) {
    this.permanentSameAsPresent = checked;
    if (checked) this.permanentAddress = { ...this.presentAddress };
  }

  /** চেকবক্স চালু থাকলে বর্তমান ঠিকানা বদলালে স্থায়ী ঠিকানাও মিলিয়ে রাখা হয় */
  syncPermanentAddress() {
    if (this.permanentSameAsPresent) this.permanentAddress = { ...this.presentAddress };
  }

  /** শুধু পূরণকৃত ঘর রাখে; সব ফাঁকা হলে undefined (Firestore undefined গ্রহণ করে না, তাই পুরো অবজেক্ট বাদ যায়) */
  private compact<T extends object>(obj: T): T | undefined {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      const v = String(value ?? '').trim();
      if (v) out[key] = v;
    }
    return Object.keys(out).length > 0 ? (out as unknown as T) : undefined;
  }

  private buildProfileFields(): StaffProfileFields {
    const fields: StaffProfileFields = {};
    const set = <K extends keyof StaffProfileFields>(key: K, value: StaffProfileFields[K] | undefined) => {
      if (value !== undefined && value !== '') fields[key] = value;
    };
    set('fatherName', this.fatherName.trim());
    set('motherName', this.motherName.trim());
    set('dateOfBirth', this.dateOfBirth.trim());
    set('gender', this.gender || undefined);
    set('bloodGroup', this.bloodGroup);
    set('maritalStatus', this.maritalStatus || undefined);
    set('educationalQualification', this.educationalQualification.trim());
    set('phoneSecondary', this.phoneSecondary.trim());
    set('homeTown', this.homeTown.trim());
    set('presentAddress', this.compact(this.presentAddress));
    set('permanentAddress', this.compact(this.permanentSameAsPresent ? this.presentAddress : this.permanentAddress));
    set('emergencyContact', this.compact(this.emergencyContact));
    return fields;
  }

  selectAllBranches() {
    this.assignedBranchIds = this.branches().map(b => b.branchId);
  }

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
      this.toast.warning(this.lang.isBangla() ? 'অনুগ্রহ করে নাম, মোবাইল এবং ইমেইল প্রদান করুন' : 'Please provide name, phone and email');
      return;
    }

    if (!this.authService.isSuperAdmin() && !this.authService.isAdmin()) {
      this.toast.error(this.lang.isBangla() ? 'শুধুমাত্র সিস্টেম অ্যাডমিন নতুন ইউজার তৈরি করতে পারেন' : 'Admin access only');
      return;
    }

    if (this.isAreaRole && this.assignedBranchIds.length === 0) {
      this.toast.warning(this.lang.isBangla() ? 'এরিয়া ম্যানেজারের জন্য অন্তত একটি শাখা নির্বাচন করুন' : 'Select at least one branch for the area manager');
      return;
    }

    if (this.password.length < MIN_PASSWORD_LENGTH) {
      this.toast.warning(this.lang.isBangla()
        ? `পাসওয়ার্ড কমপক্ষে ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে`
        : `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }

    if (this.phoneSecondary.trim() && !isValidBdMobile(this.phoneSecondary)) {
      this.toast.warning(this.lang.isBangla() ? 'বিকল্প মোবাইল নম্বরটি সঠিক নয় (যেমন: 017XXXXXXXX)' : 'Secondary mobile number is invalid (e.g. 017XXXXXXXX)');
      return;
    }

    if (this.emergencyContact.phone.trim() && !isValidBdMobile(this.emergencyContact.phone)) {
      this.toast.warning(this.lang.isBangla() ? 'জরুরি যোগাযোগের মোবাইল নম্বরটি সঠিক নয় (যেমন: 017XXXXXXXX)' : 'Emergency contact phone is invalid (e.g. 017XXXXXXXX)');
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
          // সমিতি পরে কর্মী এডিট বা "শাখা ও রুট/সমিতি" পাতা থেকে দেওয়া হয় (আগে সব নতুন মাঠকর্মী ভুলভাবে ১০১ পেতেন)
          assignedCenterIds: [],
          assignedBranchIds: this.isAreaRole ? [...this.assignedBranchIds] : [],
          nidNumber: this.nidNumber.trim() || `19852692518000${Date.now().toString().slice(-3)}`,
          salary: Number(this.salary) || (this.category === 'SYSTEM_ADMIN' ? 70000 : (this.category === 'HEAD_OFFICE' ? 50000 : 25000)),
          status: this.status,
          joinedDate: toDhakaDayKey(now),
          ...this.buildProfileFields()
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

      // 3. প্রাথমিক পাসওয়ার্ড (PBKDF2 হ্যাশ) সংরক্ষণ — ব্যর্থ হলেও কর্মী তৈরি থেকে যায়
      try {
        await this.credentials.setPassword(
          newStaffDoc.userId,
          this.password,
          { userId: currentUser.userId, name: currentUser.name, role: currentUser.role },
          'নতুন কর্মীর প্রাথমিক পাসওয়ার্ড নির্ধারণ'
        );
      } catch (pwErr) {
        console.error('Error saving initial password:', pwErr);
        this.toast.warning(
          this.lang.isBangla()
            ? `ইউজার #${newStaffDoc.userId} তৈরি হয়েছে, কিন্তু পাসওয়ার্ড সংরক্ষণ হয়নি — পরে পাসওয়ার্ড নির্ধারণ করুন`
            : `User #${newStaffDoc.userId} was created, but the password was not saved — please set it later`
        );
      }

      this.toast.success(
        this.lang.isBangla()
          ? `অভিনন্দন! নতুন ব্যবহারকারী #${newStaffDoc.userId} (${this.name}) সফলভাবে সংরক্ষিত হয়েছে!`
          : `Success! New User #${newStaffDoc.userId} (${this.name}) has been saved to database!`
      );

      const targetTab = this.category === 'SYSTEM_ADMIN' ? 'admins' : (this.category === 'HEAD_OFFICE' ? 'head_office' : 'branch_staff');
      this.router.navigate(['/users'], { queryParams: { tab: targetTab } });
    } catch (err) {
      console.error('Error creating user in database:', err);
      this.toast.error('ইউজার তৈরিতে সমস্যা হয়েছে');
    } finally {
      this.submitting.set(false);
    }
  }
}
