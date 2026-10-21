import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { NavbarComponent } from './shared/components/navbar/navbar.component';
import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { AuthStateService } from './core/services/auth-state.service';
import { filter } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, NavbarComponent, SidebarComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  readonly authService = inject(AuthStateService);
  private router = inject(Router);

  readonly isLoginPage = signal<boolean>(
    typeof window !== 'undefined' ? window.location.pathname.includes('/login') : false
  );

  constructor() {
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((event) => {
        const url = event.urlAfterRedirects || event.url;
        this.isLoginPage.set(url.includes('/login'));
      });
  }

  readonly showLayout = computed(() => {
    return this.authService.isAuthenticated() && !this.isLoginPage();
  });
}
