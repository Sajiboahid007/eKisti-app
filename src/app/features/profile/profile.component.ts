import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { KistiDatabaseService } from '../../core/services/kisti-database.service';
import { AuthStateService } from '../../core/services/auth-state.service';
import { LanguageService } from '../../core/services/language.service';
import { ToastService } from '../../core/services/toast.service';
import { MIN_PASSWORD_LENGTH, StaffCredentialService } from '../../core/services/staff-credential.service';
import { StaffAddress, StaffEmergencyContact, UserCategory, UserStaff } from '../../core/models/database.models';
import { isValidBdMobile, normalizeBdMobile } from '../../core/finance/validation';
import { formatBnDate, toDhakaDayKey, todayDhaka } from '../../core/finance/dates';
import { SkeletonComponent } from '../../shared/components/skeleton/skeleton.component';

/** কর্মী নিজে যেসব তথ্য বদলাতে পারেন */
interface ProfileForm {
  name: string;
  email: string;
  phone: string;
  phoneSecondary: string;
  fatherName: string;
  motherName: string;
  dateOfBirth: string;
  gender: '' | 'MALE' | 'FEMALE' | 'OTHER';
  bloodGroup: string;
  maritalStatus: '' | 'SINGLE' | 'MARRIED' | 'OTHER';
  educationalQualification: string;
  homeTown: string;
  presentAddress: StaffAddress;
  permanentAddress: StaffAddress;
  emergencyContact: StaffEmergencyContact;
}

type SimpleKey = Exclude<keyof ProfileForm, 'presentAddress' | 'permanentAddress' | 'emergencyContact'>;

const SIMPLE_KEYS: SimpleKey[] = [
  'name', 'email', 'phone', 'phoneSecondary', 'fatherName', 'motherName', 'dateOfBirth',
  'gender', 'bloodGroup', 'maritalStatus', 'educationalQualification', 'homeTown'
];

const SELF_UPDATE_REASON = 'কর্মী নিজে প্রোফাইল হালনাগাদ করেছেন';
const SELF_PASSWORD_REASON = 'কর্মী নিজে পাসওয়ার্ড পরিবর্তন করেছেন';

const emptyAddress = (): StaffAddress => ({ villageOrStreet: '', postOffice: '', thanaOrUpazila: '', district: '' });
const emptyContact = (): StaffEmergencyContact => ({ name: '', relation: '', phone: '' });

function cleanAddress(a: Partial<StaffAddress> | undefined): StaffAddress {
  return {
    villageOrStreet: (a?.villageOrStreet || '').trim(),
    postOffice: (a?.postOffice || '').trim(),
    thanaOrUpazila: (a?.thanaOrUpazila || '').trim(),
    district: (a?.district || '').trim()
  };
}

function cleanContact(c: Partial<StaffEmergencyContact> | undefined): StaffEmergencyContact {
  return {
    name: (c?.name || '').trim(),
    relation: (c?.relation || '').trim(),
    phone: c?.phone ? normalizeBdMobile(c.phone.trim()) : ''
  };
}

function sameObject(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isBlank(o: object): boolean {
  return Object.values(o).every(v => !v);
}

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss'
})
export class ProfileComponent implements OnInit {
  private db = inject(KistiDatabaseService);
  private credentials = inject(StaffCredentialService);
  private toast = inject(ToastService);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  readonly minPasswordLength = MIN_PASSWORD_LENGTH;
  readonly bloodGroups = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
  readonly maxBirthDate = todayDhaka();

  loading = signal(true);
  saving = signal(false);
  /** ডাটাবেজের কর্মী রেকর্ড; ডেমো প্রিসেট ব্যবহারকারীর ক্ষেত্রে null */
  staff = signal<UserStaff | null>(null);
  /** রেকর্ড না পেলে শুধু দেখা যাবে, সংরক্ষণ ও পাসওয়ার্ড বন্ধ */
  readOnly = computed(() => !this.loading() && this.staff() === null);

  form: ProfileForm = this.blankForm();
  sameAsPresent = false;

  // পাসওয়ার্ড পরিবর্তন
  hasPassword = signal(false);
  changingPassword = signal(false);
  showPasswords = signal(false);
  currentPassword = '';
  newPassword = '';
  confirmPassword = '';

  readonly session = computed(() => this.authService.currentUser());

  async ngOnInit() {
    const userId = Number(this.session().userId);
    try {
      const [staff, hasPw] = await Promise.all([
        this.db.getStaffById(userId),
        this.credentials.hasPassword(userId).catch(() => false)
      ]);
      this.staff.set(staff);
      this.hasPassword.set(hasPw);
    } catch (e) {
      console.error('Profile load failed', e);
      this.staff.set(null);
      this.toast.error(this.lang.isBangla() ? 'প্রোফাইল লোড করা যায়নি' : 'Could not load profile');
    }
    this.resetForm();
    this.loading.set(false);
  }

  // ---------- প্রদর্শন সহায়ক ----------

  initial(): string {
    return (this.staff()?.name || this.session().name || '?').trim().charAt(0);
  }

  categoryLabel(c: UserCategory | undefined): string {
    const bn = this.lang.isBangla();
    switch (c) {
      case 'SYSTEM_ADMIN': return bn ? 'সিস্টেম প্রশাসন' : 'System Admin';
      case 'HEAD_OFFICE': return bn ? 'প্রধান কার্যালয়' : 'Head Office';
      case 'BRANCH_STAFF': return bn ? 'শাখা কর্মী' : 'Branch Staff';
      default: return '—';
    }
  }

  statusLabel(s: UserStaff['status'] | undefined): string {
    const bn = this.lang.isBangla();
    switch (s) {
      case 'ACTIVE': return bn ? 'সক্রিয়' : 'Active';
      case 'INACTIVE': return bn ? 'নিষ্ক্রিয়' : 'Inactive';
      case 'SUSPENDED': return bn ? 'স্থগিত' : 'Suspended';
      default: return '—';
    }
  }

  statusBadge(s: UserStaff['status'] | undefined): string {
    if (s === 'ACTIVE') return 'badge-success';
    if (s === 'SUSPENDED') return 'badge-danger';
    return 'badge-secondary';
  }

  displayDate(value: string | undefined): string {
    if (!value) return '—';
    const key = /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : toDhakaDayKey(value);
    return this.lang.isBangla() ? formatBnDate(key) : key;
  }

  // ---------- ফর্ম ----------

  private blankForm(): ProfileForm {
    return {
      name: '', email: '', phone: '', phoneSecondary: '', fatherName: '', motherName: '',
      dateOfBirth: '', gender: '', bloodGroup: '', maritalStatus: '', educationalQualification: '',
      homeTown: '', presentAddress: emptyAddress(), permanentAddress: emptyAddress(), emergencyContact: emptyContact()
    };
  }

  /** ডাটাবেজ রেকর্ড (বা সেশন) থেকে ফর্ম পূরণ */
  private resetForm() {
    const s = this.staff();
    const u = this.session();
    this.form = {
      name: s?.name ?? u.name ?? '',
      email: s?.email ?? u.email ?? '',
      phone: s?.phone ?? u.phone ?? '',
      phoneSecondary: s?.phoneSecondary ?? '',
      fatherName: s?.fatherName ?? '',
      motherName: s?.motherName ?? '',
      dateOfBirth: s?.dateOfBirth ?? '',
      gender: s?.gender ?? '',
      bloodGroup: s?.bloodGroup ?? '',
      maritalStatus: s?.maritalStatus ?? '',
      educationalQualification: s?.educationalQualification ?? '',
      homeTown: s?.homeTown ?? '',
      presentAddress: cleanAddress(s?.presentAddress),
      permanentAddress: cleanAddress(s?.permanentAddress),
      emergencyContact: cleanContact(s?.emergencyContact)
    };
    this.sameAsPresent = !isBlank(this.form.presentAddress)
      && sameObject(this.form.presentAddress, this.form.permanentAddress);
  }

  onSameAsPresentChange(checked: boolean) {
    this.sameAsPresent = checked;
    if (checked) this.form.permanentAddress = { ...this.form.presentAddress };
  }

  /** বর্তমান ঠিকানা বদলালে "একই" চেক করা থাকলে স্থায়ী ঠিকানাও বদলায় */
  syncPermanent() {
    if (this.sameAsPresent) this.form.permanentAddress = { ...this.form.presentAddress };
  }

  /** শুধু পরিবর্তিত ঘরগুলো */
  private changedFields(): Partial<UserStaff> {
    const s = this.staff();
    if (!s) return {};
    const f = this.form;
    const next: Record<SimpleKey, string> = {
      name: f.name.trim(),
      email: f.email.trim(),
      phone: normalizeBdMobile(f.phone.trim()),
      phoneSecondary: f.phoneSecondary.trim() ? normalizeBdMobile(f.phoneSecondary.trim()) : '',
      fatherName: f.fatherName.trim(),
      motherName: f.motherName.trim(),
      dateOfBirth: f.dateOfBirth,
      gender: f.gender,
      bloodGroup: f.bloodGroup,
      maritalStatus: f.maritalStatus,
      educationalQualification: f.educationalQualification.trim(),
      homeTown: f.homeTown.trim()
    };

    const changes: Record<string, unknown> = {};
    for (const key of SIMPLE_KEYS) {
      const before = (s[key] as string | undefined) ?? '';
      if (next[key] !== before) changes[key] = next[key];
    }

    const present = cleanAddress(f.presentAddress);
    const permanent = this.sameAsPresent ? { ...present } : cleanAddress(f.permanentAddress);
    const contact = cleanContact(f.emergencyContact);
    const nested: [keyof UserStaff, object, object | undefined][] = [
      ['presentAddress', present, s.presentAddress && cleanAddress(s.presentAddress)],
      ['permanentAddress', permanent, s.permanentAddress && cleanAddress(s.permanentAddress)],
      ['emergencyContact', contact, s.emergencyContact && cleanContact(s.emergencyContact)]
    ];
    for (const [key, value, before] of nested) {
      if (before === undefined ? !isBlank(value) : !sameObject(value, before)) changes[key] = value;
    }
    return changes as Partial<UserStaff>;
  }

  /** ত্রুটি থাকলে বাংলা বার্তা, না থাকলে null */
  private validate(): string | null {
    const bn = this.lang.isBangla();
    const f = this.form;
    const me = Number(this.session().userId);

    if (!f.name.trim()) return bn ? 'নাম আবশ্যক' : 'Name is required';

    const email = f.email.trim().toLowerCase();
    if (!email) return bn ? 'ইমেইল আবশ্যক' : 'Email is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bn ? 'ইমেইল ঠিকানা সঠিক নয়' : 'Invalid email address';

    if (!isValidBdMobile(f.phone)) return bn ? 'মোবাইল নম্বর সঠিক নয় (যেমন: 017XXXXXXXX)' : 'Invalid mobile number (e.g. 017XXXXXXXX)';
    const phone = normalizeBdMobile(f.phone.trim());

    const others = this.authService.availableUsers().filter(u => Number(u.userId) !== me);
    if (others.some(u => (u.email || '').trim().toLowerCase() === email)) {
      return bn ? 'এই ইমেইল অন্য একজন কর্মী ব্যবহার করছেন' : 'This email is already used by another staff member';
    }
    if (others.some(u => u.phone && normalizeBdMobile(u.phone) === phone)) {
      return bn ? 'এই মোবাইল নম্বর অন্য একজন কর্মী ব্যবহার করছেন' : 'This mobile number is already used by another staff member';
    }

    if (f.phoneSecondary.trim() && !isValidBdMobile(f.phoneSecondary)) {
      return bn ? 'বিকল্প মোবাইল নম্বর সঠিক নয়' : 'Invalid secondary mobile number';
    }
    if (f.dateOfBirth && f.dateOfBirth > this.maxBirthDate) {
      return bn ? 'জন্ম তারিখ ভবিষ্যতের হতে পারে না' : 'Date of birth cannot be in the future';
    }
    if (f.emergencyContact.phone.trim() && !isValidBdMobile(f.emergencyContact.phone)) {
      return bn ? 'জরুরি যোগাযোগের মোবাইল নম্বর সঠিক নয়' : 'Invalid emergency contact mobile number';
    }
    return null;
  }

  async saveProfile() {
    const staff = this.staff();
    if (!staff || this.saving()) return;

    const error = this.validate();
    if (error) {
      this.toast.warning(error);
      return;
    }

    const changes = this.changedFields();
    if (Object.keys(changes).length === 0) {
      this.toast.warning(this.lang.isBangla() ? 'কোনো পরিবর্তন করা হয়নি' : 'No changes to save');
      return;
    }

    this.saving.set(true);
    try {
      const u = this.session();
      await this.db.updateStaff(staff.userId, changes, { userId: u.userId, name: u.name, role: u.role }, SELF_UPDATE_REASON);
      const merged: UserStaff = { ...staff, ...changes };
      this.staff.set(merged);

      const roles = await this.db.getRoles().catch(() => []);
      this.authService.syncUserFromDb(merged, roles.find(r => r.code === merged.role));

      this.resetForm();
      this.toast.success(this.lang.isBangla() ? 'প্রোফাইল সফলভাবে হালনাগাদ হয়েছে' : 'Profile updated successfully');
    } catch (e) {
      console.error('Profile save failed', e);
      this.toast.error(e instanceof Error && e.message ? e.message
        : (this.lang.isBangla() ? 'প্রোফাইল সংরক্ষণ করা যায়নি' : 'Could not save profile'));
    } finally {
      this.saving.set(false);
    }
  }

  discardChanges() {
    this.resetForm();
  }

  // ---------- পাসওয়ার্ড ----------

  async changePassword() {
    const staff = this.staff();
    if (!staff || this.changingPassword()) return;
    const bn = this.lang.isBangla();

    if (this.hasPassword() && !this.currentPassword) {
      this.toast.warning(bn ? 'বর্তমান পাসওয়ার্ড দিন' : 'Enter your current password');
      return;
    }
    if (this.newPassword.length < MIN_PASSWORD_LENGTH) {
      this.toast.warning(bn ? `নতুন পাসওয়ার্ড কমপক্ষে ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে`
        : `New password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    if (this.newPassword !== this.confirmPassword) {
      this.toast.warning(bn ? 'নতুন পাসওয়ার্ড ও নিশ্চিতকরণ মিলছে না' : 'New password and confirmation do not match');
      return;
    }
    if (this.hasPassword() && this.currentPassword === this.newPassword) {
      this.toast.warning(bn ? 'নতুন পাসওয়ার্ড বর্তমান পাসওয়ার্ডের মতো হতে পারবে না' : 'New password must differ from the current one');
      return;
    }

    this.changingPassword.set(true);
    try {
      const u = this.session();
      await this.credentials.setPassword(
        staff.userId,
        this.newPassword,
        { userId: u.userId, name: u.name, role: u.role },
        SELF_PASSWORD_REASON,
        this.hasPassword() ? this.currentPassword : undefined
      );
      this.hasPassword.set(true);
      this.authService.setMustChangePassword(false);
      this.currentPassword = '';
      this.newPassword = '';
      this.confirmPassword = '';
      this.showPasswords.set(false);
      this.toast.success(bn ? 'পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে' : 'Password changed successfully');
    } catch (e) {
      console.error('Password change failed', e);
      this.toast.error(e instanceof Error && e.message ? e.message
        : (bn ? 'পাসওয়ার্ড পরিবর্তন করা যায়নি' : 'Could not change password'));
    } finally {
      this.changingPassword.set(false);
    }
  }
}
