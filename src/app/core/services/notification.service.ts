import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Firestore, Unsubscribe, collection, onSnapshot, query, where } from '@angular/fire/firestore';
import { Loan, PaymentCollection } from '../models/database.models';
import { AuthStateService } from './auth-state.service';
import { ToastService } from './toast.service';

export interface AppNotification {
  key: string;
  icon: string;
  tone: 'warning' | 'info' | 'success';
  title: string;
  detail: string;
  count: number;
  link: string;
}

const PIPELINE_STATUSES = ['APPLIED', 'FIELD_VERIFIED', 'APPROVED'];

/**
 * সাইডবার ব্যাজ ও নোটিফিকেশন বেল — Firestore লাইভ লিসেনার থেকে:
 *  • ঋণ আবেদন: যে ধাপে বর্তমান ব্যবহারকারীর কাজ বাকি (যাচাই / অনুমোদন / বিতরণ)
 *  • ক্যাশিয়ার ক্লোজিং: মাঠকর্মীর হাতে থাকা, এখনো ভল্টে জমা না হওয়া রসিদ
 */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private firestore = inject(Firestore);
  private auth = inject(AuthStateService);
  private toast = inject(ToastService);

  private readonly pipelineLoans = signal<Loan[]>([]);
  private readonly pendingReceipts = signal<PaymentCollection[]>([]);
  private unsubscribers: Unsubscribe[] = [];

  /** ব্যবহারকারীর শাখার ঋণ আবেদন — প্রতিটি ধাপে কতটি তার কাজের অপেক্ষায় */
  readonly loanStages = computed(() => {
    const user = this.auth.currentUser();
    const c = { verify: 0, approve: 0, disburse: 0 };
    for (const l of this.pipelineLoans()) {
      if (!this.auth.canAccessBranch(l.branchId)) continue;
      if (l.status === 'APPLIED' && this.auth.canVerifyLoan()
        && (!this.auth.isFieldOfficer() || Number(l.fieldOfficerUserId) === Number(user.userId))) c.verify++;
      else if (l.status === 'FIELD_VERIFIED' && this.auth.canApproveLoans() && l.appliedByUserId !== user.userId) c.approve++;
      else if (l.status === 'APPROVED' && this.auth.canDisburseLoan()) c.disburse++;
    }
    return c;
  });

  readonly loanApprovalCount = computed(() => {
    const s = this.loanStages();
    return s.verify + s.approve + s.disburse;
  });

  /** ভল্টে জমার অপেক্ষায় রসিদ — শুধু ক্যাশিয়ার/BM/অ্যাডমিন (যাঁরা ক্লোজিং করেন) */
  private readonly visibleReceipts = computed(() => {
    if (!this.auth.canVerifyCash()) return [];
    return this.pendingReceipts().filter(r => this.auth.canAccessBranch(r.branchId));
  });

  readonly cashClosingCount = computed(() => this.visibleReceipts().length);

  readonly items = computed<AppNotification[]>(() => {
    const out: AppNotification[] = [];
    const s = this.loanStages();
    if (s.verify) out.push({
      key: 'verify', icon: 'edit_note', tone: 'info', count: s.verify, link: '/loans/approvals',
      title: 'মাঠ যাচাই বাকি', detail: `${s.verify}টি ঋণ আবেদন সরেজমিনে যাচাইয়ের অপেক্ষায়`
    });
    if (s.approve) out.push({
      key: 'approve', icon: 'fact_check', tone: 'warning', count: s.approve, link: '/loans/approvals',
      title: 'অনুমোদন বাকি', detail: `${s.approve}টি ঋণ আবেদন আপনার অনুমোদনের অপেক্ষায়`
    });
    if (s.disburse) out.push({
      key: 'disburse', icon: 'payments', tone: 'success', count: s.disburse, link: '/loans/approvals',
      title: 'বিতরণ বাকি', detail: `${s.disburse}টি অনুমোদিত ঋণ বিতরণের অপেক্ষায়`
    });
    const receipts = this.visibleReceipts();
    if (receipts.length) {
      const total = receipts.reduce((sum, r) => sum + (r.totalAmountCollected || 0), 0);
      const officers = new Set(receipts.map(r => r.collectedByUserId)).size;
      out.push({
        key: 'cash', icon: 'point_of_sale', tone: 'warning', count: receipts.length, link: '/reconciliation',
        title: 'ক্যাশ ক্লোজিং বাকি',
        detail: `${officers} জন মাঠকর্মীর ${receipts.length}টি রসিদ (৳${total.toLocaleString('en-IN')}) গ্রহণের অপেক্ষায়`
      });
    }
    return out;
  });

  readonly totalCount = computed(() => this.items().reduce((s, i) => s + i.count, 0));

  constructor() {
    effect(() => {
      const active = this.auth.isAuthenticated();
      untracked(() => (active ? this.start() : this.stop()));
    });
    inject(DestroyRef).onDestroy(() => this.stop());

    // নতুন কাজ এলে টোস্ট (প্রথম লোড ও ব্যবহারকারী বদলের সময় নয়)
    let previous: { userId: number; counts: Record<string, number> } | null = null;
    effect(() => {
      const userId = this.auth.currentUser().userId;
      const counts = Object.fromEntries(this.items().map(i => [i.key, i.count]));
      const ready = this.loaded();
      untracked(() => {
        if (ready && previous && previous.userId === userId) {
          for (const item of this.items()) {
            if (item.count > (previous.counts[item.key] || 0)) this.toast.info(item.detail, item.title, item.link);
          }
        }
        previous = ready ? { userId, counts } : null;
      });
    });
  }

  private readonly loaded = signal(false);

  private start() {
    if (this.unsubscribers.length) return;
    let pending = 2;
    const markLoaded = () => { if (--pending === 0) this.loaded.set(true); };

    const loansQuery = query(collection(this.firestore, 'loans'), where('status', 'in', PIPELINE_STATUSES));
    let loansFirst = true;
    this.unsubscribers.push(onSnapshot(loansQuery, snap => {
      this.pipelineLoans.set(snap.docs.map(d => d.data() as Loan).filter(l => !l.isDeleted));
      if (loansFirst) { loansFirst = false; markLoaded(); }
    }, err => console.error('Notification (loans) listener error:', err)));

    const receiptsQuery = query(collection(this.firestore, 'collections'), where('isHandedOverToBranch', '==', false));
    let receiptsFirst = true;
    this.unsubscribers.push(onSnapshot(receiptsQuery, snap => {
      this.pendingReceipts.set(snap.docs.map(d => d.data() as PaymentCollection).filter(r => !r.isDeleted && !r.isReversed));
      if (receiptsFirst) { receiptsFirst = false; markLoaded(); }
    }, err => console.error('Notification (receipts) listener error:', err)));
  }

  private stop() {
    this.unsubscribers.forEach(u => u());
    this.unsubscribers = [];
    this.pipelineLoans.set([]);
    this.pendingReceipts.set([]);
    this.loaded.set(false);
  }
}
