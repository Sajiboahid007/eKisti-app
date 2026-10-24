import { Component, ElementRef, HostListener, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AppNotification, NotificationService } from '../../../core/services/notification.service';

/** নেভবারের নোটিফিকেশন বেল — বাকি কাজের তালিকা (ঋণ যাচাই/অনুমোদন/বিতরণ, ক্যাশ ক্লোজিং) */
@Component({
  selector: 'app-notification-bell',
  standalone: true,
  templateUrl: './notification-bell.component.html',
  styleUrl: './notification-bell.component.scss'
})
export class NotificationBellComponent {
  readonly notifications = inject(NotificationService);
  private router = inject(Router);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly open = signal(false);

  toggle() {
    this.open.update(v => !v);
  }

  close() {
    this.open.set(false);
  }

  go(item: AppNotification) {
    this.close();
    this.router.navigateByUrl(item.link);
  }

  countText(count: number): string {
    return count > 99 ? '99+' : String(count);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent) {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.close();
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.open()) this.close();
  }
}
