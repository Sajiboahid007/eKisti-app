import { Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Branch, CenterOrSamity } from '../../../core/models/database.models';

// সদস্য ভর্তি আবেদন ফরম (ফাঁকা) — গ্রাহক হাতে পূরণ করে শাখা অফিসে জমা দেবেন।
// ফিল্ডগুলো CustomerFormComponent / Customer মডেলের সাথে মিল রেখে সাজানো।
@Component({
  selector: 'app-customer-application-form',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './customer-application-form.component.html',
  styleUrl: './customer-application-form.component.scss'
})
export class CustomerApplicationFormComponent {
  readonly branches = input<Branch[]>([]);
  readonly centers = input<CenterOrSamity[]>([]);
  readonly closed = output<void>();

  // ঐচ্ছিক: শাখা ও সমিতির নাম আগে থেকে ছাপিয়ে দেওয়া (0 = ফাঁকা লাইন)
  readonly selectedBranchId = signal<number>(0);
  readonly selectedCenterId = signal<number>(0);

  readonly availableCenters = computed(() =>
    this.centers().filter(c => c.branchId === this.selectedBranchId())
  );
  readonly branchName = computed(() =>
    this.branches().find(b => b.branchId === this.selectedBranchId())?.name || ''
  );
  readonly centerName = computed(() =>
    this.centers().find(c => c.centerId === this.selectedCenterId())?.name || ''
  );

  // ঘর (box) সংখ্যা: NID ১৭ ডিজিট, মোবাইল ১১ ডিজিট
  readonly nidBoxes = Array.from({ length: 17 });
  readonly phoneBoxes = Array.from({ length: 11 });

  onBranchChange(branchId: number) {
    this.selectedBranchId.set(Number(branchId));
    this.selectedCenterId.set(0);
  }

  print() {
    document.body.classList.add('print-application-form');
    const cleanup = () => {
      document.body.classList.remove('print-application-form');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    setTimeout(() => window.print(), 100);
  }

  close() {
    this.closed.emit();
  }
}
