import { Injectable, signal } from '@angular/core';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message: string;
  /** ক্লিক করলে যে পেজে যাবে (ঐচ্ছিক) */
  link?: string;
}

const DEFAULT_TITLE: Record<ToastKind, string> = {
  success: 'সফল হয়েছে',
  error: 'ত্রুটি',
  info: 'নতুন বিজ্ঞপ্তি',
  warning: 'সতর্কতা'
};

/** স্ক্রিনের কোণে ছোট বার্তা (টোস্ট) — alert()-এর পরিবর্তে */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private nextId = 1;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  /** বন্ধ হতে বাকি সময় — হোভারে থামলে প্রগ্রেস বারের সাথে মিল রেখে আবার চালু হয় */
  private remaining = new Map<number, { ms: number; startedAt: number }>();

  success(message: string, title?: string, link?: string) { return this.show('success', message, title, link); }
  error(message: string, title?: string) { return this.show('error', message, title, undefined, 8000); }
  info(message: string, title?: string, link?: string) { return this.show('info', message, title, link); }
  warning(message: string, title?: string, link?: string) { return this.show('warning', message, title, link); }

  show(kind: ToastKind, message: string, title?: string, link?: string, durationMs = 5000): number {
    const id = this.nextId++;
    // একসাথে সর্বোচ্চ ৪টি — পুরোনোটি সরে যায়
    this.toasts.update(list => [...list, { id, kind, title: title || DEFAULT_TITLE[kind], message, link }].slice(-4));
    this.schedule(id, durationMs);
    return id;
  }

  dismiss(id: number) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.remaining.delete(id);
    this.toasts.update(list => list.filter(t => t.id !== id));
  }

  /** মাউস রাখলে বন্ধ হওয়া থামে, সরালে আবার চালু হয় */
  pause(id: number) {
    const r = this.remaining.get(id);
    if (!this.timers.has(id) || !r) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    r.ms = Math.max(0, r.ms - (Date.now() - r.startedAt));
  }

  resume(id: number) {
    const r = this.remaining.get(id);
    if (!r || this.timers.has(id)) return;
    this.schedule(id, r.ms);
  }

  private schedule(id: number, ms: number) {
    this.remaining.set(id, { ms, startedAt: Date.now() });
    this.timers.set(id, setTimeout(() => this.dismiss(id), ms));
  }
}
