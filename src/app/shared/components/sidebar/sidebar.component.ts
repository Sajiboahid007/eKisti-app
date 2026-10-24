import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterModule } from '@angular/router';
import { filter } from 'rxjs/operators';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LanguageService } from '../../../core/services/language.service';
import { NotificationService } from '../../../core/services/notification.service';
import { InnerPage, innerPageOf, resolveActiveSection } from './active-section';

const SECTION_KEY = 'ekisti_nav_section';

@Component({
  selector: 'app-sidebar',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './sidebar.component.html',
  styleUrl: './sidebar.component.scss'
})
export class SidebarComponent {
  readonly authService = inject(AuthStateService);
  readonly lang = inject(LanguageService);
  readonly notifications = inject(NotificationService);
  private router = inject(Router);

  /** ব্যাজে দেখানোর সংখ্যা — ৯৯-এর বেশি হলে 99+ */
  badgeText(count: number): string {
    return count > 99 ? '99+' : String(count);
  }

  /** ব্যাজের টুলটিপ — যেমন "৩টি কাজ বাকি" */
  badgeTitle(count: number): string {
    if (!this.lang.isBangla()) return `${count} pending`;
    const bn = String(count).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[+d]);
    return `${bn}টি কাজ বাকি`;
  }

  /** যে মেনু সক্রিয় — ভেতরের পেজে যেখান থেকে এসেছেন সেটি থাকে (রিফ্রেশেও মনে থাকে) */
  readonly section = signal<string | null>(null);
  private readonly url = signal<string>(this.router.url);

  /** ব্যবহারকারী নিজে খোলা/বন্ধ করেছেন এমন মেনু (না থাকলে: সক্রিয় মেনু খোলা, বাকিগুলো বন্ধ) */
  private readonly expandOverride = signal<Record<string, boolean>>({});

  /**
   * প্রতিটি মেনুর উপ-মেনু: "ঋণ আবেদন ও অনুমোদন"-এ সবসময় "নতুন ঋণ আবেদন"; আর যে ভেতরের পেজে আছেন
   * (কিস্তি শিডিউল, বিতরণ, গ্রাহক/স্টাফ ফর্ম) সেটি — সক্রিয় মেনুর নিচে।
   */
  readonly subMap = computed<Record<string, (InnerPage & { active: boolean })[]>>(() => {
    const current = innerPageOf(this.url());
    const map: Record<string, InnerPage[]> = {};
    if (this.authService.canApplyLoan()) map['/loans/approvals'] = [innerPageOf('/loans/disburse')!];
    const section = this.section();
    if (section && current) {
      const list = (map[section] ??= []);
      if (!list.some(i => i.path === current.path && !i.queryParams && !current.queryParams)) list.push(current);
    }
    const out: Record<string, (InnerPage & { active: boolean })[]> = {};
    for (const [key, list] of Object.entries(map)) {
      out[key] = list.map(i => ({
        ...i,
        active: !!current && i.path === current.path && i.queryParams?.['loanId'] === current.queryParams?.['loanId']
      }));
    }
    return out;
  });

  hasSub(path: string): boolean {
    return (this.subMap()[path]?.length || 0) > 0;
  }

  isExpanded(path: string): boolean {
    if (!this.hasSub(path)) return false;
    return this.expandOverride()[path] ?? this.isActive(path);
  }

  /** চেভরনে ক্লিক: পেজে না গিয়ে শুধু উপ-মেনু খোলা/বন্ধ */
  toggle(path: string, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    const next = !this.isExpanded(path);
    this.expandOverride.update(o => ({ ...o, [path]: next }));
  }

  constructor() {
    let previous: string | null = null;
    try { previous = sessionStorage.getItem(SECTION_KEY); } catch { /* storage unavailable */ }
    this.setSection(resolveActiveSection(this.router.url, previous));
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), takeUntilDestroyed())
      .subscribe(e => {
        this.url.set(e.urlAfterRedirects);
        this.setSection(resolveActiveSection(e.urlAfterRedirects, this.section()));
      });
  }

  isActive(path: string): boolean {
    return this.section() === path;
  }

  private setSection(path: string | null) {
    // নতুন সক্রিয় মেনু আবার নিজে থেকেই খোলা দেখাবে
    if (path && path !== this.section()) this.expandOverride.update(o => { const { [path]: _, ...rest } = o; return rest; });
    this.section.set(path);
    try { if (path) sessionStorage.setItem(SECTION_KEY, path); } catch { /* storage unavailable */ }
  }

  logout() {
    this.authService.logout();
  }
}
