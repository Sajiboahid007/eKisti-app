import { Component, inject, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Firestore, collection, getDocs, query, orderBy } from '@angular/fire/firestore';
import { PaymentCollection } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { HistoryModalComponent } from '../../../shared/components/history-modal/history-modal.component';

@Component({
  selector: 'app-receipt-list',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './receipt-list.component.html',
  styleUrl: './receipt-list.component.scss'
})
export class ReceiptListComponent implements OnInit {
  private firestore = inject(Firestore);
  readonly authService = inject(AuthStateService);

  readonly receipts = signal<PaymentCollection[]>([]);
  readonly loading = signal<boolean>(true);
  searchQuery: string = '';

  // Receipt Preview Modal
  selectedReceiptForPrint = signal<PaymentCollection | null>(null);
  selectedReceiptForHistory = signal<PaymentCollection | null>(null);

  async ngOnInit() {
    await this.loadReceipts();
  }

  async loadReceipts() {
    this.loading.set(true);
    try {
      const snap = await getDocs(collection(this.firestore, 'collections'));
      const list: PaymentCollection[] = [];
      snap.forEach(d => list.push(d.data() as PaymentCollection));
      // Sort newest first
      list.sort((a, b) => b.receiptId - a.receiptId);
      this.receipts.set(list);
    } catch (err) {
      console.error('Error loading receipts:', err);
    } finally {
      this.loading.set(false);
    }
  }

  filteredReceipts(): PaymentCollection[] {
    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return this.receipts();

    return this.receipts().filter(r =>
      r.customerName.toLowerCase().includes(q) ||
      r.receiptId.toString().includes(q) ||
      (r.receiptNumberManual && r.receiptNumberManual.toLowerCase().includes(q))
    );
  }

  viewReceipt(r: PaymentCollection) {
    this.selectedReceiptForPrint.set(r);
  }

  closeReceipt() {
    this.selectedReceiptForPrint.set(null);
  }

  printReceipt() {
    window.print();
  }
}
