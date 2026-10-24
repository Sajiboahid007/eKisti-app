import { Component, DestroyRef, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { NotificationBellComponent } from '../notification-bell/notification-bell.component';
import { SettingsService } from '../../../core/services/settings.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, NotificationBellComponent],
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.scss'
})
export class NavbarComponent {
  /** প্রতিষ্ঠানের নাম/ঠিকানা (সেটিংস → প্রতিষ্ঠান) */
  readonly org = inject(SettingsService).org;
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

  /** ব্রাউজারের সংযোগ অবস্থা — অফলাইনে পড়া ক্যাশ থেকে চলে, কিন্তু আদায়/বিতরণ (ট্রানজ্যাকশন) চলে না */
  readonly isOnline = signal<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);

  constructor() {
    if (typeof window === 'undefined') return;
    const update = () => this.isOnline.set(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    });
  }

  connectivityTooltip(): string {
    if (this.lang.isBangla()) {
      return this.isOnline()
        ? 'অনলাইন — সব লেনদেন সক্রিয়। মনে রাখুন: আদায়/বিতরণ লেনদেনের জন্য ইন্টারনেট প্রয়োজন।'
        : 'অফলাইন — তথ্য দেখা যাবে (লোকাল ক্যাশ), কিন্তু আদায়/বিতরণ লেনদেনের জন্য ইন্টারনেট প্রয়োজন।';
    }
    return this.isOnline()
      ? 'Online — transactions (collection/disbursement) require internet.'
      : 'Offline — viewing cached data only; transactions (collection/disbursement) require internet.';
  }

  onUserSelect(event: Event) {
    const target = event.target as HTMLSelectElement;
    const userId = Number(target.value);
    this.authService.switchUser(userId);
  }

  getCategoryUsers(category: 'SYSTEM_ADMIN' | 'HEAD_OFFICE' | 'BRANCH_STAFF') {
    return this.authService.availableUsers().filter(u => {
      if (u.category) return u.category === category;
      if (category === 'SYSTEM_ADMIN') return ['SUPER_ADMIN', 'ADMIN'].includes(u.role);
      if (category === 'HEAD_OFFICE') return ['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(u.role);
      return !['SUPER_ADMIN', 'ADMIN', 'MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(u.role);
    });
  }
}
