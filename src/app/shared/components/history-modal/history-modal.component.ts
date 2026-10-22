import { Component, Input, Output, EventEmitter, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EditHistoryEntry } from '../../../core/models/database.models';
import { AuditHistoryService } from '../../../core/services/audit-history.service';

/**
 * অডিট হিস্ট্রি। ডকুমেন্টে শুধু সর্বশেষ কয়েকটি এন্ট্রি থাকে; entityType + entityId দিলে
 * কেন্দ্রীয় auditLogs কালেকশন থেকে পূর্ণ ইতিহাস এনে একত্রে দেখায়।
 */
@Component({
  selector: 'app-history-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './history-modal.component.html',
  styleUrl: './history-modal.component.scss'
})
export class HistoryModalComponent implements OnInit {
  private audit = inject(AuditHistoryService);

  @Input() title: string = 'পরিবর্তন ও এডিট হিস্ট্রি (Audit Log)';
  @Input() historyList: EditHistoryEntry[] = [];
  @Input() entityType?: string;
  @Input() entityId?: number | string;
  @Output() close = new EventEmitter<void>();

  readonly entries = signal<EditHistoryEntry[]>([]);
  readonly loadingLogs = signal<boolean>(false);

  async ngOnInit() {
    const embedded = [...(this.historyList || [])];
    this.entries.set(this.sorted(embedded));
    if (!this.entityType || this.entityId === undefined) return;

    this.loadingLogs.set(true);
    try {
      const logs = await this.audit.getAuditLogs(this.entityType, this.entityId);
      const fromLogs: EditHistoryEntry[] = logs.map((log, i) => ({
        historyId: -(i + 1),
        action: log.action,
        timestamp: log.timestamp,
        changedByUserId: log.actor.userId,
        changedByName: log.actor.name,
        changedByRole: log.actor.role,
        reason: log.reason,
        previousData: Object.fromEntries(Object.entries(log.changes || {}).map(([k, v]) => [k, v.before])),
        newData: Object.fromEntries(Object.entries(log.changes || {}).map(([k, v]) => [k, v.after]))
      }));
      // একই সময় ও কারণের এন্ট্রি দুই জায়গায় থাকলে একবার দেখানো
      const seen = new Set(fromLogs.map(e => `${e.timestamp.slice(0, 19)}|${e.reason}`));
      const merged = [...fromLogs, ...embedded.filter(e => !seen.has(`${e.timestamp.slice(0, 19)}|${e.reason}`))];
      this.entries.set(this.sorted(merged));
    } finally {
      this.loadingLogs.set(false);
    }
  }

  private sorted(list: EditHistoryEntry[]): EditHistoryEntry[] {
    return [...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  onClose() {
    this.close.emit();
  }

  getActionBadgeClass(action: string): string {
    switch (action) {
      case 'CREATE': case 'LOAN_APPLIED': return 'badge-active';
      case 'UPDATE': case 'STATUS_CHANGE': case 'LOAN_RESCHEDULED': case 'TRANSFER': return 'badge-warning';
      case 'DELETE': case 'PAYMENT_REVERSED': case 'LOAN_REJECTED': case 'LOAN_WRITTEN_OFF': return 'badge-overdue';
      case 'PAYMENT_COLLECTED': case 'CASH_RECONCILED': case 'LOAN_APPROVED': case 'LOAN_DISBURSED': case 'LOAN_SETTLED': return 'badge-paid';
      default: return 'badge-secondary';
    }
  }

  getActionLabelBangla(action: string): string {
    const labels: Record<string, string> = {
      CREATE: 'নতুন তৈরি', UPDATE: 'সংশোধন / এডিট', DELETE: 'বাতিল / ডিলিট', RESTORE: 'পুনরুদ্ধার',
      STATUS_CHANGE: 'অবস্থা পরিবর্তন', PAYMENT_COLLECTED: 'টাকা জমা / কালেকশন', CASH_RECONCILED: 'ক্যাশ ক্লোজিং',
      PAYMENT_REVERSED: 'রসিদ বাতিল', LOAN_APPLIED: 'ঋণ আবেদন', LOAN_VERIFIED: 'মাঠ যাচাই', LOAN_APPROVED: 'অনুমোদন',
      LOAN_REJECTED: 'প্রত্যাখ্যান', LOAN_DISBURSED: 'বিতরণ', LOAN_SETTLED: 'নিষ্পত্তি', LOAN_RESCHEDULED: 'পুনঃতফসিল',
      LOAN_WRITTEN_OFF: 'অবলোপন', VAULT_TRANSACTION: 'ভল্ট লেনদেন', DAY_CLOSED: 'সমাপনী', DAY_REOPENED: 'পুনরায় খোলা',
      TRANSFER: 'স্থানান্তর'
    };
    return labels[action] || action;
  }
}
