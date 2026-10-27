import { Component, ElementRef, HostListener, ViewChild, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ActiveUserSession, AuthStateService } from '../../../core/services/auth-state.service';
import { StaffCredentialService } from '../../../core/services/staff-credential.service';
import { normalizeBdMobile } from '../../../core/finance/validation';
import { LanguageService } from '../../../core/services/language.service';
import { StaffRole } from '../../../core/models/database.models';
import { SettingsService } from '../../../core/services/settings.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  /** প্রতিষ্ঠানের নাম/ঠিকানা (সেটিংস → প্রতিষ্ঠান) */
  readonly org = inject(SettingsService).org;
  private router = inject(Router);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);
  private credentials = inject(StaffCredentialService);

  emailOrPhone: string = 'admin@ekisti.com';
  password: string = '123456';
  errorMessage = signal<string>('');
  loading = signal<boolean>(false);

  readonly demoRoles = [
    {
      role: 'SUPER_ADMIN' as StaffRole,
      titleBn: 'সুপার অ্যাডমিন / এমডি',
      titleEn: 'Super Admin / MD',
      descBn: 'ইউজার তৈরি, সম্পূর্ণ নিয়ন্ত্রণ ও রিপোর্ট',
      descEn: 'User creation, full control & reports',
      email: 'admin@ekisti.com',
      icon: 'admin_panel_settings',
      badgeClass: 'badge-admin'
    },
    {
      role: 'BRANCH_MANAGER' as StaffRole,
      titleBn: 'শাখা ব্যবস্থাপক (BM)',
      titleEn: 'Branch Manager (BM)',
      descBn: 'শাখা পরিচালনা, ঋণ অনুমোদন ও ভল্ট',
      descEn: 'Branch ops, loan approvals & vault',
      email: 'kamrul.bm@ekisti.com',
      icon: 'manage_accounts',
      badgeClass: 'badge-bm'
    },
    {
      role: 'FIELD_OFFICER' as StaffRole,
      titleBn: 'মাঠকর্মী (FO)',
      titleEn: 'Field Officer (FO)',
      descBn: 'মাঠে কিস্তি আদায় ও রসিদ তৈরি',
      descEn: 'Field collections & money receipts',
      email: 'rafiqul.fo@ekisti.com',
      icon: 'directions_walk',
      badgeClass: 'badge-fo'
    },
    {
      role: 'CASHIER' as StaffRole,
      titleBn: 'হিসাবরক্ষক / ক্যাশিয়ার',
      titleEn: 'Cashier / Accountant',
      descBn: 'মাঠের ক্যাশ গ্রহণ ও ভল্ট ক্লোজিং',
      descEn: 'Field cash verification & closing',
      email: 'nasrin.cashier@ekisti.com',
      icon: 'point_of_sale',
      badgeClass: 'badge-cashier'
    }
  ];

  onSubmit() {
    this.errorMessage.set('');
    if (!this.emailOrPhone.trim()) {
      this.errorMessage.set(this.lang.isBangla() ? 'অনুগ্রহ করে ইমেইল বা ফোন নম্বর দিন' : 'Please enter email or phone');
      return;
    }

    this.loading.set(true);
    setTimeout(async () => {
      const ok = await this.authService.login(this.emailOrPhone, this.password);
      this.loading.set(false);
      if (ok) {
        this.router.navigate(['/dashboard']);
      } else {
        this.errorMessage.set(this.lang.isBangla() ? 'ব্যবহারকারীর তথ্য মেলেনি' : 'Invalid credentials');
      }
    }, 300);
  }

  quickLogin(role: StaffRole) {
    this.authService.loginAsRole(role);
  }

  // ===== পাসওয়ার্ড ভুলে গেছেন =====
  @ViewChild('forgotInput') private forgotInput?: ElementRef<HTMLInputElement>;

  forgotOpen = signal<boolean>(false);
  forgotIdentifier = signal<string>('');
  forgotSending = signal<boolean>(false);
  forgotSent = signal<boolean>(false);
  forgotError = signal<string>('');

  openForgot() {
    this.forgotIdentifier.set(this.emailOrPhone.trim());
    this.forgotSent.set(false);
    this.forgotError.set('');
    this.forgotOpen.set(true);
    setTimeout(() => this.forgotInput?.nativeElement.focus());
  }

  closeForgot() {
    if (this.forgotSending()) return;
    this.forgotOpen.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.forgotOpen()) this.closeForgot();
  }

  async sendForgot() {
    const identifier = this.forgotIdentifier().trim();
    this.forgotError.set('');
    if (!identifier) {
      this.forgotError.set(this.lang.isBangla() ? 'অনুগ্রহ করে ইমেইল বা মোবাইল নম্বর দিন' : 'Please enter email or mobile number');
      return;
    }

    this.forgotSending.set(true);
    try {
      // কর্মী তালিকা Firestore থেকে তখনো লোড না হলে আবার এনে খোঁজা
      let staff = this.findStaff(identifier);
      if (!staff) {
        await this.authService.loadUsersFromFirestore();
        staff = this.findStaff(identifier);
      }
      // গোপনীয়তা: একাউন্ট আছে কি না তা প্রকাশ করা হয় না — মিল থাকুক বা না থাকুক, একই বার্তা
      if (staff) {
        await this.credentials.requestReset({
          userId: staff.userId, name: staff.name, email: staff.email,
          phone: staff.phone, branchId: staff.branchId
        });
      }
      this.forgotSent.set(true);
    } catch {
      this.forgotError.set(this.lang.isBangla()
        ? 'অনুরোধ পাঠানো যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করে আবার চেষ্টা করুন।'
        : 'Could not send the request. Check your internet connection and try again.');
    } finally {
      this.forgotSending.set(false);
    }
  }

  /** ইমেইল (case-insensitive) বা মোবাইল নম্বর দিয়ে কর্মী খোঁজা — নাম দিয়ে নয় */
  private findStaff(identifier: string): ActiveUserSession | undefined {
    const email = identifier.toLowerCase();
    const normalized = normalizeBdMobile(identifier);
    const mobile = /^\d{6,}$/.test(normalized) ? normalized : '';
    return this.authService.availableUsers().find(u =>
      (!!u.email && u.email.trim().toLowerCase() === email) ||
      (!!u.phone && !!mobile && normalizeBdMobile(u.phone) === mobile)
    );
  }
}
