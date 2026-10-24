import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { Customer, Loan, LoanStatus } from '../../../core/models/database.models';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { LoanLifecycleService } from '../../../core/services/loan-lifecycle.service';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';
import { ToastService } from '../../../core/services/toast.service';

type Stage = 'APPLIED' | 'FIELD_VERIFIED' | 'APPROVED';
type ActionKind = 'VERIFY' | 'APPROVE' | 'REJECT';

/** মাঠ যাচাইয়ের চেকলিস্ট — সব টিক না দিলে যাচাই সম্পন্ন হয় না */
const VERIFICATION_CHECKLIST = [
  'বাড়ি / বসতভিটা সরেজমিনে পরিদর্শন',
  'ব্যবসা / আয়ের উৎস যাচাই',
  'জামিনদারের সাথে সাক্ষাৎ ও সম্মতি',
  'NID ও ছবি মূল কপির সাথে মিলানো',
  'পরিবারের সম্মতি ও ঋণ পরিশোধের সক্ষমতা'
];

@Component({
  selector: 'app-loan-approvals',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterModule, SkeletonComponent],
  templateUrl: './loan-approvals.component.html',
  styleUrl: './loan-approvals.component.scss'
})
export class LoanApprovalsComponent implements OnInit {
  private lifecycle = inject(LoanLifecycleService);
  private router = inject(Router);
  readonly authService = inject(AuthStateService);
  private toast = inject(ToastService);
  private kisti = inject(KistiDatabaseService);

  readonly checklist = VERIFICATION_CHECKLIST;
  readonly loans = signal<Loan[]>([]);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string>('');
  readonly stage = signal<Stage>('APPLIED');

  readonly action = signal<{ kind: ActionKind; loan: Loan } | null>(null);
  readonly notes = signal<string>('');
  readonly checked = signal<Set<number>>(new Set());
  readonly busy = signal<boolean>(false);
  readonly actionError = signal<string>('');

  // গ্রাহকের পরিচয় যাচাই মডাল — বিতরণের আগে ক্যাশিয়ার মূল NID/ছবির সাথে মিলিয়ে নেবেন
  readonly customerLoan = signal<Loan | null>(null);
  readonly customerInfo = signal<Customer | null>(null);
  readonly customerLoading = signal<boolean>(false);
  readonly customerError = signal<string>('');
  readonly zoomImage = signal<{ url: string; title: string } | null>(null);

  readonly stageLoans = computed(() => this.loans().filter(l => l.status === this.stage()));
  /** বর্তমান ধাপের বিবরণ — একটিমাত্র টেক্সট বাইন্ডিং (প্রতি ক্লিকে নতুন টেক্সট নোড তৈরি হয় না) */
  readonly currentStage = computed(() => this.stages.find(s => s.key === this.stage()) || this.stages[0]);
  readonly counts = computed(() => {
    const c: Record<Stage, number> = { APPLIED: 0, FIELD_VERIFIED: 0, APPROVED: 0 };
    this.loans().forEach(l => { if (l.status in c) c[l.status as Stage]++; });
    return c;
  });

  readonly stages: { key: Stage; label: string; icon: string; hint: string }[] = [
    { key: 'APPLIED', label: 'মাঠ যাচাই বাকি', icon: 'edit_note', hint: 'দায়িত্বপ্রাপ্ত মাঠকর্মী সরেজমিনে যাচাই করবেন' },
    { key: 'FIELD_VERIFIED', label: 'অনুমোদন বাকি', icon: 'fact_check', hint: 'শাখা ব্যবস্থাপক অনুমোদন দেবেন (আবেদনকারী নিজে নয়)' },
    { key: 'APPROVED', label: 'বিতরণ বাকি', icon: 'payments', hint: 'ক্যাশিয়ার ভল্ট থেকে টাকা দিয়ে বিতরণ সম্পন্ন করবেন' }
  ];

  async ngOnInit() {
    await this.load();
  }

  async load() {
    this.loading.set(true);
    this.error.set('');
    try {
      this.loans.set(await this.lifecycle.getPipeline(this.authService.accessibleBranchIds()));
    } catch (err: any) {
      this.error.set(err?.message || 'ঋণ আবেদন লোড করা যায়নি');
    } finally {
      this.loading.set(false);
    }
  }

  canAct(kind: ActionKind, loan: Loan): boolean {
    const me = this.authService.currentUser().userId;
    if (kind === 'VERIFY') {
      // মাঠকর্মী শুধু নিজের দায়িত্বের ঋণ যাচাই করবেন
      return this.authService.canVerifyLoan() && (!this.authService.isFieldOfficer() || Number(loan.fieldOfficerUserId) === Number(me));
    }
    if (kind === 'APPROVE') return this.authService.canApproveLoans() && loan.appliedByUserId !== me;
    return this.authService.canApproveLoans();
  }

  openAction(kind: ActionKind, loan: Loan) {
    this.action.set({ kind, loan });
    this.notes.set('');
    this.checked.set(new Set());
    this.actionError.set('');
  }

  closeAction() {
    if (!this.busy()) this.action.set(null);
  }

  toggleCheck(i: number) {
    const next = new Set(this.checked());
    if (next.has(i)) next.delete(i); else next.add(i);
    this.checked.set(next);
  }

  readonly actionReady = computed(() => {
    const a = this.action();
    if (!a) return false;
    if (a.kind === 'VERIFY') return this.checked().size === this.checklist.length && !!this.notes().trim();
    if (a.kind === 'REJECT') return !!this.notes().trim();
    return true;
  });

  async submitAction() {
    const a = this.action();
    if (!a || !this.actionReady()) return;
    const user = this.authService.currentUser();
    const actor = { userId: user.userId, name: user.name, role: user.role };
    this.busy.set(true);
    this.actionError.set('');
    try {
      if (a.kind === 'VERIFY') {
        const notes = `${this.notes().trim()} [যাচাই: ${this.checklist.join('; ')}]`;
        await this.lifecycle.verify(a.loan.loanId, notes, actor);
        this.toast.success(`${a.loan.loanAccountNo} মাঠ যাচাই সম্পন্ন — এখন অনুমোদনের অপেক্ষায়`);
      } else if (a.kind === 'APPROVE') {
        await this.lifecycle.approve(a.loan.loanId, this.notes(), actor);
        this.toast.success(`${a.loan.loanAccountNo} অনুমোদিত — এখন বিতরণের অপেক্ষায়`);
      } else {
        await this.lifecycle.reject(a.loan.loanId, this.notes(), actor);
        this.toast.success(`${a.loan.loanAccountNo} প্রত্যাখ্যাত`);
      }
      this.action.set(null);
      await this.load();
    } catch (err: any) {
      this.actionError.set(err?.message || 'কাজটি সম্পন্ন করা যায়নি');
    } finally {
      this.busy.set(false);
    }
  }

  async openCustomer(loan: Loan) {
    this.customerLoan.set(loan);
    this.customerInfo.set(null);
    this.customerError.set('');
    this.customerLoading.set(true);
    try {
      const c = await this.kisti.getCustomerById(loan.customerId);
      if (this.customerLoan()?.loanId !== loan.loanId) return;
      if (c) this.customerInfo.set(c);
      else this.customerError.set(`গ্রাহক #${loan.customerId} পাওয়া যায়নি`);
    } catch (err: any) {
      this.customerError.set(err?.message || 'গ্রাহকের তথ্য লোড করা যায়নি');
    } finally {
      this.customerLoading.set(false);
    }
  }

  closeCustomer() {
    this.customerLoan.set(null);
    this.customerInfo.set(null);
    this.zoomImage.set(null);
  }

  ownershipLabel(v: string | undefined): string {
    return ({ OWN: 'নিজস্ব', RENTED: 'ভাড়া', FAMILY: 'পারিবারিক' } as Record<string, string>)[v || ''] || '—';
  }

  genderLabel(v: string | undefined): string {
    return ({ MALE: 'পুরুষ', FEMALE: 'মহিলা', OTHER: 'অন্যান্য' } as Record<string, string>)[v || ''] || '—';
  }

  creditLabel(v: string | undefined): string {
    return ({ GOOD: 'ভালো', AVERAGE: 'মধ্যম', RISKY: 'ঝুঁকিপূর্ণ', BLACKLISTED: 'কালো তালিকাভুক্ত' } as Record<string, string>)[v || 'GOOD'] || String(v);
  }

  /** পুরোনো রেকর্ডে জামিনদার/বন্ধক না-ও থাকতে পারে */
  guarantorsOf(c: Customer) {
    return [c.primaryGuarantor, c.secondaryGuarantor].filter((g): g is NonNullable<typeof g> => !!g && !!g.name);
  }

  collateralOf(c: Customer): Partial<Customer['collateral']> {
    return c.collateral || {};
  }

  houseOwnershipOf(c: Customer): string {
    return this.ownershipLabel((c.presentAddress as Customer['presentAddress'] | undefined)?.houseOwnership);
  }

  address(a: { villageOrStreet?: string; postOffice?: string; thanaOrUpazila?: string; district?: string } | undefined): string {
    if (!a) return '—';
    return [a.villageOrStreet, a.postOffice, a.thanaOrUpazila, a.district].filter(Boolean).join(', ') || '—';
  }

  disburse(loan: Loan) {
    this.router.navigate(['/loans/disburse'], { queryParams: { loanId: loan.loanId } });
  }

  statusLabel(status: LoanStatus): string {
    return ({ APPLIED: 'আবেদনকৃত', FIELD_VERIFIED: 'মাঠ যাচাইকৃত', APPROVED: 'অনুমোদিত' } as Record<string, string>)[status] || status;
  }
}
