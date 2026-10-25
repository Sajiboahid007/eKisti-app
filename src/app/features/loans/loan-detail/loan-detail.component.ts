import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { FollowUp, InstallmentFrequency, InstallmentSchedule, InsuranceClaim, Loan, LoanStatusChange, LoanTransaction, PaymentCollection } from '../../../core/models/database.models';
import { AuthStateService } from '../../../core/services/auth-state.service';
import { FinanceService, PaymentMethod } from '../../../core/services/finance.service';
import { TxRunner } from '../../../core/services/tx-runner.service';
import { KistiDatabaseService } from '../../../core/services/kisti-database.service';
import { HistoryModalComponent } from '../../../shared/components/history-modal/history-modal.component';
import { SkeletonComponent } from '../../../shared/components/skeleton/skeleton.component';
import { amountForInstallments, collectionView, describeAllocation, isSettledStatus, remainingOf } from '../../../core/finance/allocation';
import { classificationRule } from '../../../core/finance/classification';
import { earlySettlementQuote } from '../../../core/finance/settlement';
import { addDaysKey, formatBnDate, todayDhaka, toDhakaDayKey } from '../../../core/finance/dates';

type Tab = 'SCHEDULE' | 'LEDGER' | 'STATUS' | 'FOLLOWUP';

/** কিস্তির একটি রসিদ — এই কিস্তিতে কত গেছে সহ */
export interface InstallmentReceipt {
  receipt: PaymentCollection;
  principal: number;
  profit: number;
  savings: number;
  /** এই কিস্তিতে মোট (আসল + লাভ + সঞ্চয়) */
  total: number;
}
type ModalKind = 'COLLECT' | 'SETTLE' | 'RESCHEDULE' | 'WRITE_OFF' | 'CLAIM' | 'RECOVERY';

@Component({
  selector: 'app-loan-detail',
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, HistoryModalComponent, SkeletonComponent],
  templateUrl: './loan-detail.component.html',
  styleUrl: './loan-detail.component.scss'
})
export class LoanDetailComponent implements OnInit {
  private finance = inject(FinanceService);
  private runner = inject(TxRunner);
  private kisti = inject(KistiDatabaseService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private location = inject(Location);
  readonly authService = inject(AuthStateService);

  loanId = 0;
  readonly loan = signal<Loan | null>(null);
  readonly installments = signal<InstallmentSchedule[]>([]);
  readonly transactions = signal<LoanTransaction[]>([]);
  readonly statusHistory = signal<LoanStatusChange[]>([]);
  readonly followUps = signal<FollowUp[]>([]);
  readonly claims = signal<InsuranceClaim[]>([]);
  readonly receipts = signal<PaymentCollection[]>([]);
  /** শিডিউলের যে কিস্তির রসিদ বিবরণ খোলা */
  readonly receiptInst = signal<InstallmentSchedule | null>(null);
  readonly loading = signal<boolean>(true);
  readonly tab = signal<Tab>('SCHEDULE');
  readonly message = signal<{ kind: 'success' | 'danger'; text: string } | null>(null);
  readonly showHistoryModal = signal<boolean>(false);

  readonly today = todayDhaka();

  // ---------- modal state ----------
  readonly modal = signal<ModalKind | null>(null);
  readonly busy = signal<boolean>(false);
  readonly modalError = signal<string>('');
  readonly amount = signal<number>(0);
  readonly savings = signal<number>(0);
  readonly method = signal<PaymentMethod>('CASH');
  readonly trxId = signal<string>('');
  readonly allowAdvance = signal<boolean>(false);
  readonly reason = signal<string>('');
  readonly rescheduleCount = signal<number>(20);
  readonly rescheduleFrequency = signal<InstallmentFrequency>('WEEKLY');
  readonly rescheduleFirstDate = signal<string>(addDaysKey(todayDhaka(), 7));
  readonly claimType = signal<'DEATH' | 'DISABILITY'>('DEATH');
  readonly claimDate = signal<string>(todayDhaka());

  // follow-up form
  readonly fuPerson = signal<FollowUp['contactedPerson']>('BORROWER');
  readonly fuMethod = signal<FollowUp['method']>('VISIT');
  readonly fuOutcome = signal<string>('');
  readonly fuPromiseDate = signal<string>('');
  readonly fuPromiseAmount = signal<number | null>(null);

  readonly view = computed(() => collectionView(this.installments(), this.today, toDhakaDayKey));
  readonly classification = computed(() => classificationRule(this.loan()?.classification));
  readonly settlementQuote = computed(() => earlySettlementQuote(this.installments(), this.today, 100));
  readonly isActive = computed(() => ['DISBURSED', 'OVERDUE'].includes(this.loan()?.status || ''));
  readonly inPipeline = computed(() => ['APPLIED', 'FIELD_VERIFIED', 'APPROVED'].includes(this.loan()?.status || ''));
  readonly advanceNeeded = computed(() => this.amount() > this.view().dueAmount);

  async ngOnInit() {
    this.loanId = Number(this.route.snapshot.paramMap.get('id')) || 0;
    await this.load();
  }

  async load() {
    this.loading.set(true);
    try {
      const { loan, installments } = await this.runner.loadLoanBundle(this.loanId);
      this.loan.set(loan);
      this.installments.set(installments);
      const [txns, statuses, fus, claims, receipts] = await Promise.all([
        this.finance.getLoanTransactions(this.loanId),
        this.finance.getLoanStatusHistory(this.loanId),
        this.finance.getFollowUps(this.loanId),
        this.finance.getInsuranceClaims(this.loanId),
        this.kisti.getPaymentCollectionsByLoanId(this.loanId).catch(() => [] as PaymentCollection[])
      ]);
      this.receipts.set(receipts);
      this.transactions.set(txns);
      this.statusHistory.set(statuses);
      this.followUps.set(fus);
      this.claims.set(claims);
    } catch (err) {
      console.error('Error loading loan details:', err);
      this.loan.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  /** আগের পেজে (যেখান থেকে এসেছেন) ফেরত; সরাসরি লিংকে খুললে ঋণ তালিকায় */
  goBack() {
    if (this.router.lastSuccessfulNavigation()?.previousNavigation) this.location.back();
    else void this.router.navigate(['/loans']);
  }

  dayLabel(key: string | undefined | null, short = false): string {
    return formatBnDate(key, short);
  }

  remaining(inst: InstallmentSchedule): number {
    return remainingOf(inst).total;
  }

  isOpen(inst: InstallmentSchedule): boolean {
    return !isSettledStatus(inst.status);
  }

  statusBadge(inst: InstallmentSchedule): { cls: string; label: string } {
    const overdue = this.isOpen(inst) && inst.dueDate < this.today;
    switch (inst.status) {
      case 'PAID': return { cls: 'badge-paid', label: 'পরিশোধিত' };
      case 'ADVANCE': return { cls: 'badge-paid', label: 'অগ্রিম পরিশোধিত' };
      case 'PARTIAL': return { cls: overdue ? 'badge-danger' : 'badge-warning', label: overdue ? 'আংশিক (বকেয়া)' : 'আংশিক' };
      case 'RESCHEDULED': return { cls: 'badge-secondary', label: 'পুনঃতফসিলকৃত' };
      case 'WAIVED': return { cls: 'badge-secondary', label: 'মওকুফ' };
      default: return overdue ? { cls: 'badge-danger', label: 'বকেয়া' } : inst.dueDate === this.today ? { cls: 'badge-warning', label: 'আজ দেয়' } : { cls: 'badge-pending', label: 'বাকি' };
    }
  }

  /**
   * কিস্তির রসিদ: রসিদের বণ্টন (allocations) থেকে, পুরাতন রসিদে installmentId / কিস্তির receiptIds থেকে।
   * বাতিল রসিদও দেখানো হয় (চিহ্নসহ), যাতে পুরো ইতিহাস থাকে।
   */
  installmentReceipts(inst: InstallmentSchedule): InstallmentReceipt[] {
    const linked = new Set(inst.receiptIds || (inst.collectionReceiptId ? [inst.collectionReceiptId] : []));
    const out: InstallmentReceipt[] = [];
    for (const r of this.receipts()) {
      const alloc = r.allocations?.find(a => a.installmentId === inst.installmentId);
      if (alloc) {
        out.push({ receipt: r, principal: alloc.principal, profit: alloc.profit, savings: alloc.savings, total: alloc.principal + alloc.profit + alloc.savings });
      } else if (!r.allocations?.length && (linked.has(r.receiptId) || r.installmentId === inst.installmentId)) {
        const principal = r.principalAmountCollected || 0, profit = r.profitAmountCollected || 0, savings = r.savingsAmountCollected || 0;
        out.push({ receipt: r, principal, profit, savings, total: principal + profit + savings });
      }
    }
    return out;
  }

  openReceipts(inst: InstallmentSchedule) {
    if (inst.paidTotalAmount > 0 || this.installmentReceipts(inst).length) this.receiptInst.set(inst);
  }

  methodLabel(m: PaymentCollection['paymentMethod']): string {
    return ({ CASH: 'নগদ', BKASH: 'বিকাশ', NAGAD: 'নগদ (মোবাইল)', BANK: 'ব্যাংক', SAVINGS: 'সঞ্চয় হতে' } as Record<string, string>)[m] || m;
  }

  txnLabel(type: LoanTransaction['type']): string {
    return ({
      DISBURSEMENT: 'বিতরণ', REPAYMENT: 'কিস্তি আদায়', REVERSAL: 'রসিদ বাতিল', ADJUSTMENT_FROM_SAVINGS: 'সঞ্চয় হতে সমন্বয়',
      EARLY_SETTLEMENT: 'আগাম পরিশোধ', REBATE: 'রিবেট (মওকুফ)', RESCHEDULE: 'পুনঃতফসিল', WRITE_OFF: 'অবলোপন',
      WRITE_OFF_RECOVERY: 'অবলোপিত আদায়', INSURANCE_WAIVER: 'বীমা মওকুফ'
    } as Record<string, string>)[type] || type;
  }

  // ---------- modals ----------

  open(kind: ModalKind) {
    this.modal.set(kind);
    this.modalError.set('');
    this.reason.set('');
    this.trxId.set('');
    this.method.set('CASH');
    this.allowAdvance.set(false);
    if (kind === 'COLLECT') {
      // একবারে একটি কিস্তি (পুরাতনতম অপরিশোধিত) দিয়ে শুরু; বেশি নিতে দ্রুত বাটন
      this.pickInstallments(1);
    }
    if (kind === 'RECOVERY') this.amount.set(0);
    if (kind === 'RESCHEDULE') {
      this.rescheduleFrequency.set(this.loan()!.installmentFrequency);
      this.rescheduleCount.set(Math.max(1, this.loan()!.remainingInstallmentsCount || 10));
    }
  }

  close() {
    if (!this.busy()) this.modal.set(null);
  }

  readonly selectedCount = signal<number>(1);

  /** পুরাতন থেকে n টি কিস্তি (0 = আজ পর্যন্ত সব দেয়) */
  pickInstallments(n: number) {
    const count = n === 0 ? this.view().dueInstallments.length : n;
    const pick = amountForInstallments(this.installments(), count);
    this.selectedCount.set(n);
    this.amount.set(pick.amount);
    this.savings.set(pick.savings);
  }

  setAmount(value: number) {
    this.amount.set(value);
    this.selectedCount.set(-1);
  }

  readonly quickPicks = computed(() => {
    const due = this.view().dueInstallments.length;
    const picks: { n: number; label: string; amount: number }[] = [];
    for (const n of [1, 2, 3]) {
      if (n > 1 && n >= due) break;
      const p = amountForInstallments(this.installments(), n);
      if (p.count < n) break;
      picks.push({ n, label: `${n}টি কিস্তি`, amount: p.amount });
    }
    if (due > 1) picks.push({ n: 0, label: `সব দেয় (${due}টি)`, amount: this.view().dueAmount });
    return picks;
  });

  readonly allocationPreview = computed(() =>
    this.modal() === 'COLLECT' ? describeAllocation(this.installments(), Number(this.amount()) || 0, this.today) : []);

  private actor() {
    const u = this.authService.currentUser();
    return { userId: u.userId, name: u.name, role: u.role };
  }

  async submit() {
    const kind = this.modal();
    const loan = this.loan();
    if (!kind || !loan) return;
    this.busy.set(true);
    this.modalError.set('');
    try {
      let text = '';
      switch (kind) {
        case 'COLLECT': {
          const r = await this.finance.collectPayment({
            loanId: loan.loanId, loanAmount: Number(this.amount()) || 0, savingsAmount: Number(this.savings()) || 0,
            paymentMethod: this.method(), trxId: this.trxId(), allowAdvance: this.allowAdvance()
          }, this.actor());
          text = `রসিদ #${r.receiptId}: ৳${r.totalAmountCollected} আদায় হয়েছে (${r.allocations?.map(a => `কিস্তি ${a.installmentNo}`).join(', ')})`;
          break;
        }
        case 'SETTLE': {
          const r = await this.finance.earlySettle({ loanId: loan.loanId, paymentMethod: this.method(), trxId: this.trxId() }, this.actor());
          text = `আগাম পরিশোধ সম্পন্ন — রসিদ #${r.receiptId}, ৳${r.totalAmountCollected}। ঋণ বন্ধ হয়েছে।`;
          break;
        }
        case 'RESCHEDULE':
          await this.finance.rescheduleLoan({ loanId: loan.loanId, count: Number(this.rescheduleCount()), frequency: this.rescheduleFrequency(), firstDueDate: this.rescheduleFirstDate(), reason: this.reason() }, this.actor());
          text = `ঋণ ${this.rescheduleCount()}টি নতুন কিস্তিতে পুনঃতফসিল হয়েছে`;
          break;
        case 'WRITE_OFF':
          await this.finance.writeOffLoan(loan.loanId, this.reason(), this.actor());
          text = 'ঋণ অবলোপন সম্পন্ন — আদায় চলতে পারে';
          break;
        case 'CLAIM': {
          const c = await this.finance.insuranceClaim({ loanId: loan.loanId, claimType: this.claimType(), eventDate: this.claimDate(), notes: this.reason() }, this.actor());
          text = `বীমা দাবি #${c.claimId}: ৳${c.waivedOutstanding} মওকুফ, ঋণ বন্ধ`;
          break;
        }
        case 'RECOVERY': {
          const r = await this.finance.recordWriteOffRecovery({ loanId: loan.loanId, amount: Number(this.amount()) || 0, paymentMethod: this.method(), trxId: this.trxId() }, this.actor());
          text = `অবলোপিত ঋণ আদায় — রসিদ #${r.receiptId}`;
          break;
        }
      }
      this.modal.set(null);
      this.message.set({ kind: 'success', text });
      await this.load();
    } catch (err: any) {
      this.modalError.set(err?.message || 'কাজটি সম্পন্ন করা যায়নি');
    } finally {
      this.busy.set(false);
    }
  }

  async addFollowUp() {
    const loan = this.loan();
    if (!loan) return;
    try {
      await this.finance.addFollowUp({
        loanId: loan.loanId, customerId: loan.customerId, branchId: Number(loan.branchId),
        contactedPerson: this.fuPerson(), method: this.fuMethod(), outcome: this.fuOutcome(),
        promiseDate: this.fuPromiseDate() || undefined, promiseAmount: this.fuPromiseAmount() || undefined
      }, this.actor());
      this.fuOutcome.set('');
      this.fuPromiseDate.set('');
      this.fuPromiseAmount.set(null);
      this.followUps.set(await this.finance.getFollowUps(loan.loanId));
      this.message.set({ kind: 'success', text: 'ফলো-আপ সংরক্ষিত হয়েছে' });
    } catch (err: any) {
      this.message.set({ kind: 'danger', text: err?.message || 'ফলো-আপ সংরক্ষণ করা যায়নি' });
    }
  }

  personLabel(p: FollowUp['contactedPerson']): string {
    return ({ BORROWER: 'ঋণগ্রহীতা', PRIMARY_GUARANTOR: '১ম জামিনদার', SECONDARY_GUARANTOR: '২য় জামিনদার', FAMILY: 'পরিবার', OTHER: 'অন্যান্য' } as Record<string, string>)[p];
  }
}
