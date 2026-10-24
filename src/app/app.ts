import { Component, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet, Router, NavigationEnd } from '@angular/router';
import { NavbarComponent } from './shared/components/navbar/navbar.component';
import { SidebarComponent } from './shared/components/sidebar/sidebar.component';
import { ToastComponent } from './shared/components/toast/toast.component';
import { AuthStateService } from './core/services/auth-state.service';
import { LanguageService } from './core/services/language.service';
import { DomTranslatorService } from './core/services/dom-translator.service';
import { filter } from 'rxjs/operators';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, NavbarComponent, SidebarComponent, ToastComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App {
  readonly authService = inject(AuthStateService);
  private router = inject(Router);
  private lang = inject(LanguageService);
  private translator = inject(DomTranslatorService);

  readonly isLoginPage = signal<boolean>(
    typeof window !== 'undefined' ? window.location.pathname.includes('/login') : false
  );

  constructor() {
    // ভাষা বদলালে পুরো স্ক্রিন (সব পেজ, বার্তা, ডায়ালগ) সেই ভাষায়
    effect(() => { void this.translator.apply(this.lang.currentLang()); });

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
