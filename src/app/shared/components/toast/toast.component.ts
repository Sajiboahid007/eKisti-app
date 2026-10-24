import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { Toast, ToastKind, ToastService } from '../../../core/services/toast.service';

const ICONS: Record<ToastKind, string> = {
  success: 'check_circle',
  error: 'error',
  info: 'notifications_active',
  warning: 'warning'
};

/** স্ক্রিনের উপরের-ডান কোণে টোস্ট বার্তার স্তূপ */
@Component({
  selector: 'app-toast',
  standalone: true,
  templateUrl: './toast.component.html',
  styleUrl: './toast.component.scss'
})
export class ToastComponent {
  readonly toast = inject(ToastService);
  private router = inject(Router);

  icon(kind: ToastKind): string {
    return ICONS[kind];
  }

  open(t: Toast) {
    if (!t.link) return;
    this.toast.dismiss(t.id);
    void this.router.navigateByUrl(t.link);
  }

  close(t: Toast, event: Event) {
    event.stopPropagation();
    this.toast.dismiss(t.id);
  }
}
