import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';

@Component({
  selector: 'app-navbar',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule],
  templateUrl: './navbar.component.html',
  styleUrl: './navbar.component.scss'
})
export class NavbarComponent {
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);

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

  logout() {
    this.authService.logout();
  }
}
