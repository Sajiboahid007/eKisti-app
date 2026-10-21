import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { StaffRole } from '../../../core/models/database.models';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent {
  private router = inject(Router);
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

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
    setTimeout(() => {
      const ok = this.authService.login(this.emailOrPhone, this.password);
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
}
