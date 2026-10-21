import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { EditHistoryEntry } from '../../../core/models/database.models';

@Component({
  selector: 'app-history-modal',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './history-modal.component.html',
  styleUrl: './history-modal.component.scss'
})
export class HistoryModalComponent {
  @Input() title: string = 'পরিবর্তন ও এডিট হিস্ট্রি (Audit Log)';
  @Input() historyList: EditHistoryEntry[] = [];
  @Output() close = new EventEmitter<void>();

  onClose() {
    this.close.emit();
  }

  getActionBadgeClass(action: string): string {
    switch (action) {
      case 'CREATE': return 'badge-active';
      case 'UPDATE': return 'badge-warning';
      case 'DELETE': return 'badge-overdue';
      case 'PAYMENT_COLLECTED': return 'badge-paid';
      default: return 'badge-secondary';
    }
  }

  getActionLabelBangla(action: string): string {
    switch (action) {
      case 'CREATE': return 'নতুন তৈরি';
      case 'UPDATE': return 'সংশোধন / এডিট';
      case 'DELETE': return 'বাতিল / ডিলিট';
      case 'PAYMENT_COLLECTED': return 'টাকা জমা / কালেকশন';
      case 'RESTORE': return 'পুনরুদ্ধার';
      default: return action;
    }
  }
}
