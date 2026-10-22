import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { Loan, Branch, CenterOrSamity } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { HistoryModalComponent } from '../../../shared/components/history-modal/history-modal.component';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';

@Component({
  selector: 'app-loan-list',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, HistoryModalComponent, SkeletonComponent],
  templateUrl: './loan-list.component.html',
  styleUrl: './loan-list.component.scss'
})
export class LoanListComponent implements OnInit {
  private kistiService = inject(KistiDatabaseService);
  readonly authService = inject(AuthStateService);

  readonly loans = signal<Loan[]>([]);
  readonly branches = signal<Branch[]>([]);

  // এরিয়া ম্যানেজারের নির্ধারিত শাখাগুলোর নাম (কমা দিয়ে)
  getAssignedBranchNames(): string {
    const ids = this.authService.accessibleBranchIds() || [];
    const names = this.branches().filter(b => ids.includes(b.branchId)).map(b => b.name);
    return names.length > 0 ? names.join(', ') : 'কোনো শাখা নির্ধারিত নেই';
  }
  readonly centers = signal<CenterOrSamity[]>([]);
  readonly loading = signal<boolean>(true);

  searchQuery: string = '';
  selectedFilter: string = 'ALL'; // ALL, ACTIVE, OVERDUE, CLOSED

  selectedLoanForHistory = signal<Loan | null>(null);

  // Pagination state
  readonly currentPage = signal<number>(1);
  readonly pageSize = signal<number>(10); // 10, 20, 50, 0 (all)

  readonly userScopeInfo = computed(() => {
    const user = this.authService.currentUser();
    if (user.role === 'FIELD_OFFICER') {
      return {
        title: 'দায়িত্বপ্রাপ্ত ফিল্ড ঋণ হিসাব',
        subtitle: `মাঠকর্মী: ${user.name} (শুধুমাত্র বরাদ্দকৃত রুট ও সদস্য ঋণ)`,
        tag: 'ফিল্ড অফিসার রুট',
        icon: 'person_pin_circle',
        cssClass: 'scope-fo'
      };
    } else if (user.role === 'BRANCH_MANAGER' || user.role === 'CASHIER' || user.role === 'BRANCH_STAFF') {
      return {
        title: 'শাখা ঋণ রেজিস্টার',
        subtitle: `শাখা: ${user.branchName} (শাখার সকল সদস্যের ঋণ)`,
        tag: 'শাখা ব্যবস্থাপক ভিউ',
        icon: 'apartment',
        cssClass: 'scope-bm'
      };
    } else if (user.role === 'AREA_MANAGER' || user.role === 'REGIONAL_MANAGER') {
      return {
        title: 'এরিয়া ঋণ পোর্টফোলিও',
        subtitle: `এরিয়াভুক্ত শাখা: ${this.getAssignedBranchNames()} (শাখাগুলোর সকল ঋণ)`,
        tag: 'এরিয়া ম্যানেজার ভিউ',
        icon: 'map',
        cssClass: 'scope-am'
      };
    }
    return {
      title: 'সর্বমোট ঋণ হিসাব (সারাদেশ)',
      subtitle: 'প্রধান কার্যালয় / কেন্দ্রীয় অ্যাডমিন (সকল শাখা, এরিয়া ও রুট এক্সেস)',
      tag: 'সর্বজনীন অ্যাডমিন ভিউ',
      icon: 'admin_panel_settings',
      cssClass: 'scope-admin'
    };
  });

  async ngOnInit() {
    await this.loadLoans();
  }

  async loadLoans() {
    this.loading.set(true);
    try {
      const [loansList, branchesList, centersList] = await Promise.all([
        this.kistiService.getLoans(),
        this.kistiService.getBranches(),
        this.kistiService.getCenters()
      ]);
      this.loans.set(loansList);
      this.branches.set(branchesList);
      this.centers.set(centersList);
    } catch (err) {
      console.error('Error loading loans:', err);
    } finally {
      this.loading.set(false);
    }
  }

  // Permitted loans based on user role and hierarchy
  getPermittedLoans(): Loan[] {
    const all = this.loans();
    const user = this.authService.currentUser();

    if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN' || user.role === 'MANAGING_DIRECTOR' || user.role === 'CENTRAL_AUDITOR') {
      // Super Admin and Admin can visible every loan nationwide
      return all;
    } else if (this.authService.isAreaScoped()) {
      // Area manager sees loans of their assigned branches only
      return all.filter(l => this.authService.canAccessBranch(l.branchId));
    } else if (user.role === 'BRANCH_MANAGER' || user.role === 'CASHIER' || user.role === 'BRANCH_STAFF') {
      // Branch manager can visible loans in their branch
      return all.filter(l => l.branchId === user.branchId);
    } else if (user.role === 'FIELD_OFFICER') {
      // FO can visible their assigned route / center loans
      const foCenterIds = this.centers()
        .filter(c => c.fieldOfficerUserId === user.userId)
        .map(c => c.centerId);

      return all.filter(l =>
        l.fieldOfficerUserId === user.userId ||
        (user.assignedCenterIds && user.assignedCenterIds.includes(l.centerId)) ||
        foCenterIds.includes(l.centerId)
      );
    }

    // Default fallback
    if (user.branchId && user.branchId > 0) {
      return all.filter(l => l.branchId === user.branchId);
    }
    return all;
  }

  filteredLoans(): Loan[] {
    let list = this.getPermittedLoans();

    if (this.selectedFilter === 'ACTIVE') {
      list = list.filter(l => l.status === 'DISBURSED');
    } else if (this.selectedFilter === 'OVERDUE') {
      list = list.filter(l => (l.overdueAmount || 0) > 0);
    } else if (this.selectedFilter === 'CLOSED') {
      list = list.filter(l => l.status === 'CLOSED');
    }

    const q = this.searchQuery.trim().toLowerCase();
    if (!q) return list;

    return list.filter(l =>
      l.customerName.toLowerCase().includes(q) ||
      l.loanAccountNo.toLowerCase().includes(q) ||
      l.loanId.toString().includes(q)
    );
  }

  getPermittedCount(status?: string): number {
    const list = this.getPermittedLoans();
    if (!status || status === 'ALL') return list.length;
    if (status === 'ACTIVE') return list.filter(l => l.status === 'DISBURSED').length;
    if (status === 'OVERDUE') return list.filter(l => (l.overdueAmount || 0) > 0).length;
    if (status === 'CLOSED') return list.filter(l => l.status === 'CLOSED').length;
    return list.length;
  }

  getBranchName(branchId: number): string {
    const b = this.branches().find(item => item.branchId === branchId);
    return b ? b.name : `শাখা #${branchId}`;
  }

  getCenterName(centerId: number): string {
    const c = this.centers().find(item => item.centerId === centerId);
    return c ? c.name : `সমিতি #${centerId}`;
  }

  setFilter(filter: string) {
    this.selectedFilter = filter;
    this.currentPage.set(1);
  }

  paginatedLoans(): Loan[] {
    const list = this.filteredLoans();
    const size = this.pageSize();
    if (size <= 0 || list.length <= size) {
      return list;
    }
    const total = this.totalPages();
    const current = Math.min(Math.max(1, this.currentPage()), total);
    const start = (current - 1) * size;
    return list.slice(start, start + size);
  }

  totalPages(): number {
    const size = this.pageSize();
    if (size <= 0) return 1;
    const count = this.filteredLoans().length;
    return Math.max(1, Math.ceil(count / size));
  }

  setPage(page: number) {
    if (page >= 1 && page <= this.totalPages()) {
      this.currentPage.set(page);
    }
  }

  onPageSizeChange(newSize: number | string) {
    this.pageSize.set(Number(newSize));
    this.currentPage.set(1);
  }

  getVisiblePages(): number[] {
    const total = this.totalPages();
    const current = this.currentPage();
    if (total <= 5) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    let start = Math.max(1, current - 2);
    let end = Math.min(total, start + 4);
    if (end - start < 4) {
      start = Math.max(1, end - 4);
    }
    const pages: number[] = [];
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    return pages;
  }

  openHistory(loan: Loan) {
    this.selectedLoanForHistory.set(loan);
  }

  closeHistory() {
    this.selectedLoanForHistory.set(null);
  }
}
