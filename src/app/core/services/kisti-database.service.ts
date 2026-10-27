import { Injectable, inject } from '@angular/core';
import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  runTransaction,
  writeBatch,
  increment
} from '@angular/fire/firestore';
import { CounterService } from './counter.service';
import { AuditHistoryService, diffFields } from './audit-history.service';
import { CashService } from './cash.service';
import { FinanceService } from './finance.service';
import { LoanLifecycleService } from './loan-lifecycle.service';
import { MemberService } from './member.service';
import { normalizeNid } from '../finance/validation';
import { toDhakaDayKey } from '../finance/dates';
import {
  Customer,
  Loan,
  InstallmentSchedule,
  PaymentCollection,
  Branch,
  CenterOrSamity,
  EditHistoryEntry,
  UserStaff,
  Role,
  LoanProduct,
  SavingsTransaction,
  DailyReconciliation
} from '../models/database.models';

@Injectable({
  providedIn: 'root'
})
export class KistiDatabaseService {
  private firestore = inject(Firestore);
  private counterService = inject(CounterService);
  private auditHistoryService = inject(AuditHistoryService);
  private cashService = inject(CashService);
  private financeService = inject(FinanceService);
  private loanLifecycle = inject(LoanLifecycleService);
  private memberService = inject(MemberService);

  // ==========================================
  // 1. CUSTOMER OPERATIONS (গ্রাহক নিবন্ধন ও এডিট)
  // ==========================================

  /**
   * Registers a new customer with an auto-incrementing Integer ID (e.g. 10001)
   */
  async createCustomer(
    customerData: Omit<Customer, 'customerId' | 'customerCode' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history' | 'createdAt'>,
    createdByUser: { userId: number; name: string; role: string },
    reason: string = 'নতুন গ্রাহক নিবন্ধন'
  ): Promise<Customer> {
    // NID: বাংলা অংক/স্পেস বাদ দিয়ে একরূপ করা ও ডুপ্লিকেট সদস্য আটকানো
    if (customerData.nidNumber) {
      customerData = { ...customerData, nidNumber: normalizeNid(customerData.nidNumber) };
      const duplicates = await this.memberService.findByNid(customerData.nidNumber);
      if (duplicates.length > 0) {
        throw new Error(`এই NID দিয়ে ইতোমধ্যে সদস্য নিবন্ধিত আছে: ${duplicates.map(d => `${d.fullName} (#${d.customerId})`).join(', ')}`);
      }
    }
    const openingSavings = Number(customerData.totalSavingsBalance) || 0;

    const customerId = await this.counterService.getNextIntegerId('customers');
    const customerCode = `CUST-${customerId}`;
    const now = new Date().toISOString();

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'CREATE',
      changedByUserId: createdByUser.userId,
      changedByName: createdByUser.name,
      changedByRole: createdByUser.role,
      reason,
      newData: { customerId, customerCode, ...customerData }
    });

    const newCustomer: Customer = {
      ...customerData,
      // সঞ্চয় স্থিতি শুধু সঞ্চয় খতিয়ানের মাধ্যমে বাড়ে (নিচে প্রারম্ভিক জমা)
      totalSavingsBalance: 0,
      totalLoansTaken: 0,
      activeLoansCount: 0,
      customerId,
      customerCode,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdAt: now,
      history: [historyEntry]
    };

    // Store with Integer ID as doc key
    const docRef = doc(this.firestore, 'customers', customerId.toString());
    const batch = writeBatch(this.firestore);
    batch.set(docRef, JSON.parse(JSON.stringify(newCustomer)));
    this.auditHistoryService.writeAuditLog(batch, {
      entityType: 'customers', entityId: customerId, action: 'CREATE', reason,
      changes: diffFields(undefined, { fullName: newCustomer.fullName, nidNumber: newCustomer.nidNumber, branchId: newCustomer.branchId, centerId: newCustomer.centerId }),
      branchId: Number(newCustomer.branchId), actor: this.auditHistoryService.actorStamp(createdByUser)
    });
    await batch.commit();

    // প্রারম্ভিক সঞ্চয় থাকলে পাসবুকে প্রথম জমা (DEPOSIT) এন্ট্রি — ভল্ট ও জার্নালসহ
    if (openingSavings > 0) {
      await this.cashService.recordSavings({
        customerId, type: 'DEPOSIT', amount: openingSavings, isCredit: true, paymentMethod: 'CASH',
        reason: `সদস্য ভর্তির সময় প্রারম্ভিক সঞ্চয় জমা (+৳ ${openingSavings})`
      }, createdByUser);
      newCustomer.totalSavingsBalance = openingSavings;
    }

    return newCustomer;
  }

  /**
   * Fetches all non-deleted customers from Firestore, seeding initial realistic customers if empty
   */
  async getCustomers(): Promise<Customer[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'customers'));
      const list: Customer[] = [];
      snap.forEach(d => {
        const c = d.data() as Customer;
        if (!c.isDeleted) {
          list.push(c);
        }
      });

      return list.sort((a, b) => a.customerId - b.customerId);
    } catch (err) {
      console.error('Error fetching customers:', err);
      return [];
    }
  }

  /** একটি গ্রাহক (মুছে ফেলা হলে null) */
  async getCustomerById(customerId: number): Promise<Customer | null> {
    const snap = await getDoc(doc(this.firestore, 'customers', String(customerId)));
    if (!snap.exists()) return null;
    const c = snap.data() as Customer;
    return c.isDeleted ? null : c;
  }

  /**
   * Updates an existing customer with full edit history
   */
  async updateCustomer(
    customerId: number,
    updatedFields: Partial<Customer>,
    changedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<void> {
    const docRef = doc(this.firestore, 'customers', customerId.toString());
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`গ্রাহক আইডি ${customerId} খুঁজে পাওয়া যায়নি`);
    }

    const currentData = docSnap.data() as Customer;

    // সঞ্চয় স্থিতি ও ঋণ কাউন্টার শুধু খতিয়ান/ঋণ অপারেশন বদলায় — ফর্ম থেকে পুরাতন মান লিখে ফেলা ঠেকাতে বাদ
    const fields: Partial<Customer> = { ...updatedFields };
    delete fields.totalSavingsBalance;
    delete fields.totalLoansTaken;
    delete fields.activeLoansCount;
    delete (fields as any).history;
    if (fields.nidNumber !== undefined) {
      fields.nidNumber = normalizeNid(fields.nidNumber);
      if (fields.nidNumber && fields.nidNumber !== normalizeNid(currentData.nidNumber || '')) {
        const duplicates = await this.memberService.findByNid(fields.nidNumber, customerId);
        if (duplicates.length > 0) {
          throw new Error(`এই NID দিয়ে অন্য সদস্য নিবন্ধিত আছে: ${duplicates.map(d => `${d.fullName} (#${d.customerId})`).join(', ')}`);
        }
      }
    }

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'UPDATE',
      changedByUserId: changedByUser.userId,
      changedByName: changedByUser.name,
      changedByRole: changedByUser.role,
      reason,
      previousData: currentData,
      newData: fields
    });

    const updatedHistory = this.auditHistoryService.appendHistory(currentData.history, historyEntry);

    const batch = writeBatch(this.firestore);
    batch.update(docRef, JSON.parse(JSON.stringify({ ...fields, history: updatedHistory })));
    this.auditHistoryService.writeAuditLog(batch, {
      entityType: 'customers', entityId: customerId, action: 'UPDATE', reason,
      changes: diffFields(currentData as any, fields as any), branchId: Number(currentData.branchId),
      actor: this.auditHistoryService.actorStamp(changedByUser)
    });
    await batch.commit();
  }

  /**
   * Soft deletes a customer while retaining full audit history
   */
  async softDeleteCustomer(
    customerId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<void> {
    const docRef = doc(this.firestore, 'customers', customerId.toString());
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`গ্রাহক আইডি ${customerId} পাওয়া যায়নি`);
    }

    const currentData = docSnap.data() as Customer;
    const now = new Date().toISOString();

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'DELETE',
      changedByUserId: deletedByUser.userId,
      changedByName: deletedByUser.name,
      changedByRole: deletedByUser.role,
      reason,
      previousData: currentData
    });

    await updateDoc(docRef, {
      isDeleted: true,
      deletedAt: now,
      deletedByUserId: deletedByUser.userId,
      deleteReason: reason,
      history: this.auditHistoryService.appendHistory(currentData.history, historyEntry)
    });
  }

  // ==========================================
  // 2. LOAN & INSTALLMENT OPERATIONS (ঋণ ও কিস্তি তৈরি)
  // ==========================================

  /**
   * Creates a new Loan with Integer Loan ID (e.g. 20001) and generates all Installment Schedules
   */
  
  /**
   * Fetches all active loan products from Firestore
   */
  async getLoanProducts(): Promise<LoanProduct[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'loanProducts'));
      const list: LoanProduct[] = [];
      snap.forEach(d => {
        const p = d.data() as LoanProduct;
        if (!p.isDeleted) {
          list.push(p);
        }
      });
      return list.sort((a, b) => a.productId - b.productId);
    } catch (err) {
      console.error('Error fetching loan products:', err);
      return [];
    }
  }

  // ঋণ বিতরণ এখন অনুমোদন প্রবাহের মাধ্যমে: LoanLifecycleService.createApplication → verify → approve → disburse

  async peekNextLoanId(): Promise<number> {
    return this.counterService.peekNextIntegerId('loans');
  }

  async updateLoanAccountNo(loanId: number, newAccountNo: string, changedByUser: { userId: number; name: string; role: string }): Promise<string> {
    const finalAccountNo = await this.loanLifecycle.resolveAccountNo(loanId, newAccountNo);
    await this.editRecord('loans', loanId, { loanAccountNo: finalAccountNo }, changedByUser, 'ঋণ হিসাব নম্বর পরিবর্তন');
    return finalAccountNo;
  }

  /**
   * Fetches all non-deleted loans, seeding sample microfinance loan history if empty
   */
  async getLoans(): Promise<Loan[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'loans'));
      const list: Loan[] = [];
      snap.forEach(d => {
        const l = d.data() as Loan;
        if (!l.isDeleted) {
          list.push(l);
        }
      });

      return list.sort((a, b) => b.loanId - a.loanId);
    } catch (err) {
      console.error('Error fetching loans:', err);
      return [];
    }
  }

  async getLoansByCustomerId(customerId: number): Promise<Loan[]> {
    const allLoans = await this.getLoans();
    return allLoans.filter(l => l.customerId === customerId);
  }

  /** একটি ঋণের কিস্তি শিডিউল (কিস্তি নং অনুযায়ী) */
  async getInstallmentsByLoanId(loanId: number): Promise<InstallmentSchedule[]> {
    return this.getInstallmentsByLoanIds([loanId]);
  }

  /**
   * একাধিক ঋণের কিস্তি একসাথে — Firestore 'in' কুয়েরি ৩০টি করে ভাগে (N+1 কুয়েরি এড়াতে)
   */
  async getInstallmentsByLoanIds(loanIds: number[]): Promise<InstallmentSchedule[]> {
    const ids = [...new Set(loanIds)];
    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += 30) {
      chunks.push(ids.slice(i, i + 30));
    }

    const snaps = await Promise.all(chunks.map(chunk =>
      getDocs(query(collection(this.firestore, 'installments'), where('loanId', 'in', chunk)))
    ));

    const list: InstallmentSchedule[] = [];
    snaps.forEach(snap => snap.forEach(d => {
      const inst = d.data() as InstallmentSchedule;
      if (!inst.isDeleted) {
        list.push(inst);
      }
    }));
    return list.sort((a, b) => a.loanId - b.loanId || a.installmentNo - b.installmentNo);
  }

  /** সদস্যপদ সমাপ্তিতে সঞ্চয় থেকে বকেয়া ঋণ সমন্বয় — FinanceService-এ একটি ট্রানজ্যাকশনে */
  async settleLoansFromSavings(
    customerId: number,
    performedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<{ adjustedAmount: number; closedLoanIds: number[]; newSavingsBalance: number }> {
    return this.financeService.settleLoansFromSavings(customerId, performedByUser, reason);
  }

  // ==========================================
  // 3. COLLECTION / MONEY RECEIPT (মাঠের কিস্তি আদায়)
  // ==========================================

  // কিস্তি আদায় এখন FinanceService.collectPayment — রসিদ, কিস্তি, ঋণ, সঞ্চয়, খতিয়ান ও জার্নাল একটি ট্রানজ্যাকশনে

  // ==========================================
  // 4. SAVINGS OPERATIONS (সঞ্চয় জমা, উত্তোলন ও লেনদেন ইতিহাস)
  // ==========================================

  /**
   * Records a savings transaction (Deposit, Withdraw, Adjustment, Closure).
   * স্থিতি ট্রানজ্যাকশনের ভেতরে নতুন করে পড়ে হিসাব হয় (previousBalance/newBalance কলারের মান উপেক্ষিত),
   * নগদ জমা/উত্তোলনে ভল্ট খতিয়ান ও জার্নাল লেখা হয়।
   */
  async recordSavingsTransaction(
    data: Omit<SavingsTransaction, 'transactionId' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history'>,
    performedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<SavingsTransaction> {
    return this.cashService.recordSavings({
      customerId: data.customerId,
      type: data.type,
      amount: data.amount,
      isCredit: data.isCredit,
      paymentMethod: data.paymentMethod,
      reason: data.reason || reason,
      receiptNo: data.receiptNo
    }, performedByUser);
  }

  /**
   * Fetches all savings transactions for a specific customer, sorted descending by date
   */
  async getSavingsTransactionsByCustomerId(customerId: number): Promise<SavingsTransaction[]> {
    try {
      const q = query(
        collection(this.firestore, 'savingsTransactions'),
        where('customerId', '==', customerId)
      );
      const snap = await getDocs(q);
      const list: SavingsTransaction[] = [];
      snap.forEach(d => {
        const t = d.data() as SavingsTransaction;
        if (!t.isDeleted) {
          list.push(t);
        }
      });
      return list.sort((a, b) => new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime());
    } catch (err) {
      console.error('Error fetching savings transactions:', err);
      return [];
    }
  }

  // সকল কিস্তি আদায় রসিদ (নতুন থেকে পুরাতন) — মুছে ফেলা রসিদ বাদে
  async getPaymentCollections(): Promise<PaymentCollection[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'collections'));
      const list: PaymentCollection[] = [];
      snap.forEach(d => {
        const r = d.data() as PaymentCollection;
        if (!r.isDeleted) {
          list.push(r);
        }
      });
      return list.sort((a, b) => b.receiptId - a.receiptId);
    } catch (err) {
      console.error('Error fetching payment collections:', err);
      throw err;
    }
  }

  // একটি ঋণের সকল আদায় রসিদ (পুরাতন থেকে নতুন) — কিস্তি শিডিউলে কে, কখন টাকা নিয়েছেন দেখাতে
  async getPaymentCollectionsByLoanId(loanId: number): Promise<PaymentCollection[]> {
    const snap = await getDocs(query(collection(this.firestore, 'collections'), where('loanId', '==', Number(loanId))));
    return snap.docs
      .map(d => d.data() as PaymentCollection)
      .filter(r => !r.isDeleted)
      .sort((a, b) => a.collectionDate.localeCompare(b.collectionDate) || a.receiptId - b.receiptId);
  }

  // সদস্যের সকল কিস্তি আদায় রসিদ (নতুন থেকে পুরাতন)
  async getPaymentCollectionsByCustomerId(customerId: number): Promise<PaymentCollection[]> {
    try {
      const q = query(
        collection(this.firestore, 'collections'),
        where('customerId', '==', customerId)
      );
      const snap = await getDocs(q);
      const list: PaymentCollection[] = [];
      snap.forEach(d => {
        const r = d.data() as PaymentCollection;
        if (!r.isDeleted) {
          list.push(r);
        }
      });
      return list.sort((a, b) => new Date(b.collectionDate).getTime() - new Date(a.collectionDate).getTime());
    } catch (err) {
      console.error('Error fetching payment collections:', err);
      return [];
    }
  }

  // ==========================================
  // 4b. CASH CLOSING / RECONCILIATION (মাঠকর্মীর ক্যাশ ক্লোজিং ও ভল্টে জমা)
  // ==========================================

  /** ক্যাশ ক্লোজিং রেজিস্টার (নতুন থেকে পুরাতন), branchIds = null হলে সকল শাখা */
  async getReconciliations(branchIds: number[] | null = null): Promise<DailyReconciliation[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'reconciliations'));
      const list: DailyReconciliation[] = [];
      snap.forEach(d => {
        const r = d.data() as DailyReconciliation;
        if (!r.isDeleted && (branchIds === null || branchIds.includes(Number(r.branchId)))) {
          list.push(r);
        }
      });
      return list.sort((a, b) => b.reconciliationId - a.reconciliationId);
    } catch (err) {
      console.error('Error fetching reconciliations:', err);
      throw err;
    }
  }

  /** মাঠকর্মীর হাতের টাকা ক্যাশিয়ার কর্তৃক গ্রহণ — CashService (ভল্ট খতিয়ান ও জার্নালসহ) */
  async reconcileFieldOfficerCash(params: {
    branchId: number;
    fieldOfficerUserId: number;
    fieldOfficerName: string;
    receiptIds: number[];
    countedCashAmount: number;
    denominations?: Record<string, number>;
    notes?: string;
    cashier: { userId: number; name: string; role: string };
  }): Promise<DailyReconciliation> {
    return this.cashService.reconcileFieldOfficerCash(params);
  }

  // ==========================================
  // 5. GENERAL EDIT WITH AUDIT HISTORY (যেকোনো টেবিল এডিট)
  // ==========================================

  /**
   * Generic edit function to update any record in any collection while preserving history
   */
  async editRecord(
    collectionName: string,
    integerId: number,
    updatedFields: Record<string, any>,
    changedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<void> {
    const docRef = doc(this.firestore, collectionName, integerId.toString());
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`${collectionName} রেকর্ডে আইডি ${integerId} পাওয়া যায়নি`);
    }

    const currentData = docSnap.data();

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'UPDATE',
      changedByUserId: changedByUser.userId,
      changedByName: changedByUser.name,
      changedByRole: changedByUser.role,
      reason,
      previousData: currentData,
      newData: updatedFields
    });

    const updatedHistory = this.auditHistoryService.appendHistory(currentData['history'], historyEntry);

    const batch = writeBatch(this.firestore);
    batch.update(docRef, { ...updatedFields, history: updatedHistory });
    this.auditHistoryService.writeAuditLog(batch, {
      entityType: collectionName, entityId: integerId, action: 'UPDATE', reason,
      changes: diffFields(currentData, updatedFields),
      branchId: typeof currentData['branchId'] === 'number' ? currentData['branchId'] : undefined,
      actor: this.auditHistoryService.actorStamp(changedByUser)
    });
    await batch.commit();
  }

  /**
   * প্রত্যাখ্যাত / বাতিল ঋণ আবেদন মুছে ফেলা (সফট ডিলিট, অডিটসহ)।
   * এগুলো কখনো বিতরণ হয়নি — কোনো টাকার লেনদেন নেই, তাই খতিয়ানে প্রভাব নেই।
   */
  async softDeleteRejectedLoan(
    loanId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<void> {
    if (!reason.trim()) throw new Error('মুছে ফেলার কারণ লিখুন');
    const snap = await getDoc(doc(this.firestore, 'loans', loanId.toString()));
    if (!snap.exists()) throw new Error('ঋণ পাওয়া যায়নি');
    const loan = snap.data() as Loan;
    if (loan.status !== 'REJECTED' && loan.status !== 'CANCELLED') {
      throw new Error('শুধু প্রত্যাখ্যাত বা বাতিল ঋণ আবেদন মুছে ফেলা যায়');
    }
    if ((loan.totalPaidAmount || 0) > 0 || loan.disbursementDate) {
      throw new Error('এই ঋণে লেনদেন আছে — মুছে ফেলা যাবে না');
    }
    await this.softDeleteRecord('loans', loanId, deletedByUser, reason.trim());
  }

  /**
   * Generic soft delete function
   */
  async softDeleteRecord(
    collectionName: string,
    integerId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<void> {
    const docRef = doc(this.firestore, collectionName, integerId.toString());
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      throw new Error(`${collectionName} রেকর্ডে আইডি ${integerId} পাওয়া যায়নি`);
    }

    const currentData = docSnap.data();
    const now = new Date().toISOString();

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'DELETE',
      changedByUserId: deletedByUser.userId,
      changedByName: deletedByUser.name,
      changedByRole: deletedByUser.role,
      reason,
      previousData: currentData
    });

    const batch = writeBatch(this.firestore);
    batch.update(docRef, {
      isDeleted: true,
      deletedAt: now,
      deletedByUserId: deletedByUser.userId,
      deleteReason: reason,
      history: this.auditHistoryService.appendHistory(currentData['history'], historyEntry)
    });
    this.auditHistoryService.writeAuditLog(batch, {
      entityType: collectionName, entityId: integerId, action: 'DELETE', reason,
      changes: { isDeleted: { before: false, after: true } },
      branchId: typeof currentData['branchId'] === 'number' ? currentData['branchId'] : undefined,
      actor: this.auditHistoryService.actorStamp(deletedByUser)
    });
    await batch.commit();
  }

  // ==========================================
  // 5. BRANCH OPERATIONS (শাখা তৈরি ও পরিচালনা)
  // ==========================================

  async getBranches(): Promise<Branch[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'branches'));
      const list: Branch[] = [];
      snap.forEach(d => {
        const b = d.data() as Branch;
        if (!b.isDeleted) {
          list.push(b);
        }
      });

      

      return list.sort((a, b) => a.branchId - b.branchId);
    } catch (err) {
      console.error('Error fetching branches:', err);
      return [];
    }
  }

  async createBranch(
    branchData: Omit<Branch, 'branchId' | 'branchCode' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history' | 'createdAt'> & { branchCode?: string },
    createdByUser: { userId: number; name: string; role: string },
    reason: string = 'নতুন শাখা তৈরি'
  ): Promise<Branch> {
    const branchId = await this.counterService.getNextIntegerId('branches');
    const branchCode = branchData.branchCode?.trim() || `BR-${branchId.toString().padStart(2, '0')}`;
    const now = new Date().toISOString();

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'CREATE',
      changedByUserId: createdByUser.userId,
      changedByName: createdByUser.name,
      changedByRole: createdByUser.role,
      reason,
      newData: { branchId, branchCode, ...branchData }
    });

    const newBranch: Branch = {
      ...branchData,
      branchId,
      branchCode,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdAt: now,
      history: [historyEntry]
    };

    const docRef = doc(this.firestore, 'branches', branchId.toString());
    await setDoc(docRef, newBranch);
    return newBranch;
  }

  // ==========================================
  // 6. ROUTE / VILLAGE / SAMITY OPERATIONS (রুট, গ্রাম ও সমিতি তৈরি ও পরিচালনা)
  // ==========================================

  /**
   * সমিতির তালিকা প্রায় সব পেজে লাগে কিন্তু কদাচিৎ বদলায় — মেমরিতে ২ মিনিট রাখা হয়,
   * প্রতিটি পেজ বদলে আবার সার্ভারে যেতে হয় না (ধীর নেটওয়ার্কে প্রতি রাউন্ড-ট্রিপ ~০.৫–১ সেকেন্ড)।
   * এই সার্ভিস দিয়ে সমিতি তৈরি/সম্পাদনা/মুছলে ক্যাশ সাথে সাথে বাতিল হয়।
   */
  private centersCache: { at: number; promise: Promise<CenterOrSamity[]> } | null = null;
  private static readonly CENTERS_TTL_MS = 2 * 60 * 1000;

  private invalidateCenters() {
    this.centersCache = null;
  }

  async getCenters(branchId?: number): Promise<CenterOrSamity[]> {
    const fresh = this.centersCache && Date.now() - this.centersCache.at < KistiDatabaseService.CENTERS_TTL_MS;
    if (!fresh) {
      const promise = getDocs(collection(this.firestore, 'centers')).then(snap =>
        snap.docs.map(d => d.data() as CenterOrSamity).filter(c => !c.isDeleted).sort((a, b) => a.centerId - b.centerId));
      this.centersCache = { at: Date.now(), promise };
      // ব্যর্থ হলে ক্যাশে রাখা হবে না — পরের বার আবার চেষ্টা
      promise.catch(() => { if (this.centersCache?.promise === promise) this.centersCache = null; });
    }
    try {
      const list = await this.centersCache!.promise;
      return branchId ? list.filter(c => c.branchId === branchId) : [...list];
    } catch (err) {
      console.error('Error fetching centers:', err);
      return [];
    }
  }

  async createCenterOrRoute(
    centerData: Omit<CenterOrSamity, 'centerId' | 'centerCode' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history' | 'createdAt'> & { centerCode?: string },
    createdByUser: { userId: number; name: string; role: string },
    reason: string = 'নতুন সমিতি/রুট ও গ্রাম তৈরি'
  ): Promise<CenterOrSamity> {
    const centerId = await this.counterService.getNextIntegerId('centers');
    const centerCode = centerData.centerCode?.trim() || `CEN-${centerId}`;
    const now = new Date().toISOString();

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'CREATE',
      changedByUserId: createdByUser.userId,
      changedByName: createdByUser.name,
      changedByRole: createdByUser.role,
      reason,
      newData: { centerId, centerCode, ...centerData }
    });

    const newCenter: CenterOrSamity = {
      ...centerData,
      centerId,
      centerCode,
      totalMembers: centerData.totalMembers || 0,
      activeLoansCount: centerData.activeLoansCount || 0,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdAt: now,
      history: [historyEntry]
    };

    const docRef = doc(this.firestore, 'centers', centerId.toString());
    await setDoc(docRef, newCenter);
    this.invalidateCenters();
    return newCenter;
  }

  async updateBranch(
    branchId: number,
    updatedFields: Partial<Branch>,
    changedByUser: { userId: number; name: string; role: string },
    reason: string = 'শাখা তথ্য আপডেট'
  ): Promise<void> {
    await this.editRecord('branches', branchId, updatedFields, changedByUser, reason);
  }

  async softDeleteBranch(
    branchId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string = 'শাখা মুছে ফেলা'
  ): Promise<void> {
    await this.softDeleteRecord('branches', branchId, deletedByUser, reason);
  }

  async updateCenter(
    centerId: number,
    updatedFields: Partial<CenterOrSamity>,
    changedByUser: { userId: number; name: string; role: string },
    reason: string = 'রুট/সমিতি তথ্য আপডেট'
  ): Promise<void> {
    const before = (await getDoc(doc(this.firestore, 'centers', centerId.toString()))).data() as CenterOrSamity | undefined;
    await this.editRecord('centers', centerId, updatedFields, changedByUser, reason);
    this.invalidateCenters();
    // কোন মাঠকর্মী কোন সমিতির দায়িত্বে কবে থেকে — পুরাতন আদায়/ঘাটতি সঠিক ব্যক্তির নামে রাখতে
    if (before && updatedFields.fieldOfficerUserId !== undefined && Number(updatedFields.fieldOfficerUserId) !== Number(before.fieldOfficerUserId)) {
      await this.recordStaffAssignment({
        kind: 'CENTER_FIELD_OFFICER', centerId, staffUserId: Number(updatedFields.fieldOfficerUserId),
        previousStaffUserId: Number(before.fieldOfficerUserId), branchId: Number(before.branchId)
      }, changedByUser);
    }
  }

  private async recordStaffAssignment(
    data: { kind: 'CENTER_FIELD_OFFICER' | 'STAFF_BRANCH'; centerId?: number; staffUserId: number; previousStaffUserId?: number; branchId: number; previousBranchId?: number },
    changedByUser: { userId: number; name: string; role: string }
  ): Promise<void> {
    const now = new Date().toISOString();
    await setDoc(doc(collection(this.firestore, 'staffAssignments')), JSON.parse(JSON.stringify({
      ...data, effectiveFrom: toDhakaDayKey(now), timestamp: now, actor: this.auditHistoryService.actorStamp(changedByUser)
    })));
  }

  async softDeleteCenter(
    centerId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string = 'রুট/সমিতি মুছে ফেলা'
  ): Promise<void> {
    await this.softDeleteRecord('centers', centerId, deletedByUser, reason);
    this.invalidateCenters();
  }

  // ==========================================
  // 7. ROLE OPERATIONS (পদবী ও রোল ব্যবস্থাপনা - ডায়নামিক ও ম্যানেজেবল)
  // ==========================================

  async getRoles(): Promise<Role[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'roles'));
      const list: Role[] = [];
      snap.forEach(d => {
        const r = d.data() as Role;
        if (!r.isDeleted) {
          if (!r.category) {
            if (['SUPER_ADMIN', 'ADMIN'].includes(r.code)) {
              r.category = 'SYSTEM_ADMIN';
            } else if (['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(r.code)) {
              r.category = 'HEAD_OFFICE';
            } else {
              r.category = 'BRANCH_STAFF';
            }
          }
          list.push(r);
        }
      });

      

      return list.sort((a, b) => a.roleId - b.roleId);
    } catch (err) {
      console.error('Error fetching roles from Firestore:', err);
      return [];
    }
  }

  async createRole(
    roleData: Omit<Role, 'roleId' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history' | 'createdAt'>,
    createdByUser: { userId: number; name: string; role: string },
    reason: string = 'নতুন পদবী/রোল তৈরি'
  ): Promise<Role> {
    const roleId = await this.counterService.getNextIntegerId('roles');
    const now = new Date().toISOString();

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'CREATE',
      changedByUserId: createdByUser.userId,
      changedByName: createdByUser.name,
      changedByRole: createdByUser.role,
      reason,
      newData: { roleId, ...roleData }
    });

    const newRole: Role = {
      ...roleData,
      roleId,
      code: roleData.code.trim().toUpperCase().replace(/\s+/g, '_'),
      category: roleData.category || 'BRANCH_STAFF',
      isSystem: false,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdAt: now,
      history: [historyEntry]
    };

    const docRef = doc(this.firestore, 'roles', roleId.toString());
    await setDoc(docRef, newRole);
    return newRole;
  }

  async updateRole(
    roleId: number,
    updatedFields: Partial<Role>,
    changedByUser: { userId: number; name: string; role: string },
    reason: string = 'পদবী/রোল তথ্য আপডেট'
  ): Promise<void> {
    await this.editRecord('roles', roleId, updatedFields, changedByUser, reason);
  }

  async softDeleteRole(
    roleId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string = 'পদবী/রোল মুছে ফেলা'
  ): Promise<void> {
    const docRef = doc(this.firestore, 'roles', roleId.toString());
    const snap = await getDoc(docRef);
    if (snap.exists() && (snap.data() as Role).isSystem) {
      throw new Error('সিস্টেমের মূল পদবী ডিলিট করা সম্ভব নয়।');
    }
    await this.softDeleteRecord('roles', roleId, deletedByUser, reason);
  }

  // ==========================================
  // 8. STAFF OPERATIONS (কর্মী ব্যবস্থাপনা ও ডাটাবেজ সংরক্ষণ)
  // ==========================================

  async getStaff(): Promise<UserStaff[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'staff'));
      const list: UserStaff[] = [];
      snap.forEach(d => {
        const u = d.data() as UserStaff;
        if (!u.isDeleted) {
          // Normalize category and branch for complete 3-tier separation
          if (!u.category) {
            if (u.role === 'SUPER_ADMIN' || u.role === 'ADMIN') {
              u.category = 'SYSTEM_ADMIN';
              u.branchId = 0;
              u.branchName = 'সিস্টেম প্রশাসন (সর্বজনীন)';
            } else if (['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(u.role)) {
              u.category = 'HEAD_OFFICE';
              u.branchId = 0;
              u.branchName = 'প্রধান কার্যালয় (হেড অফিস)';
            } else {
              u.category = 'BRANCH_STAFF';
              u.branchName = u.branchName || 'মিরপুর শাখা';
            }
          }
          list.push(u);
        }
      });

      

      return list.sort((a, b) => a.userId - b.userId);
    } catch (err) {
      console.error('Error fetching staff from Firestore:', err);
      return [];
    }
  }

  async createStaff(
    staffData: Omit<UserStaff, 'userId' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history'>,
    createdByUser: { userId: number; name: string; role: string },
    reason: string = 'নতুন কর্মী নিবন্ধন'
  ): Promise<UserStaff> {
    const userId = await this.counterService.getNextIntegerId('staff');

    // Ensure tier consistency
    let category = staffData.category;
    if (!category) {
      if (staffData.role === 'SUPER_ADMIN' || staffData.role === 'ADMIN') {
        category = 'SYSTEM_ADMIN';
      } else if (['MANAGING_DIRECTOR', 'AREA_MANAGER', 'REGIONAL_MANAGER', 'CENTRAL_AUDITOR', 'AUDITOR'].includes(staffData.role)) {
        category = 'HEAD_OFFICE';
      } else {
        category = 'BRANCH_STAFF';
      }
    }

    const branchId = category === 'BRANCH_STAFF' ? (staffData.branchId || 1) : 0;
    const branchName = staffData.branchName || (
      category === 'SYSTEM_ADMIN'
        ? 'সিস্টেম প্রশাসন (সর্বজনীন)'
        : (category === 'HEAD_OFFICE' ? 'প্রধান কার্যালয় (হেড অফিস)' : 'মিরপুর শাখা')
    );

    const sanitizedData = {
      ...staffData,
      category,
      branchId,
      branchName,
      assignedCenterIds: category === 'BRANCH_STAFF' ? (staffData.assignedCenterIds || []) : []
    };

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'CREATE',
      changedByUserId: createdByUser.userId,
      changedByName: createdByUser.name,
      changedByRole: createdByUser.role,
      reason,
      newData: { userId, ...sanitizedData }
    });

    const newStaff: UserStaff = {
      ...sanitizedData,
      userId,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [historyEntry]
    };

    const docRef = doc(this.firestore, 'staff', userId.toString());
    await setDoc(docRef, newStaff);
    return newStaff;
  }

  async getStaffById(userId: number): Promise<UserStaff | null> {
    const snap = await getDoc(doc(this.firestore, 'staff', userId.toString()));
    const staff = snap.exists() ? (snap.data() as UserStaff) : null;
    return staff && !staff.isDeleted ? staff : null;
  }

  async updateStaff(
    userId: number,
    updatedFields: Partial<UserStaff>,
    changedByUser: { userId: number; name: string; role: string },
    reason: string = 'কর্মী তথ্য আপডেট'
  ): Promise<void> {
    const before = (await getDoc(doc(this.firestore, 'staff', userId.toString()))).data() as UserStaff | undefined;
    await this.editRecord('staff', userId, updatedFields, changedByUser, reason);
    if (before && updatedFields.branchId !== undefined && Number(updatedFields.branchId) !== Number(before.branchId)) {
      await this.recordStaffAssignment({
        kind: 'STAFF_BRANCH', staffUserId: userId, branchId: Number(updatedFields.branchId), previousBranchId: Number(before.branchId)
      }, changedByUser);
    }
  }

  async softDeleteStaff(
    userId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string = 'কর্মী মুছে ফেলা'
  ): Promise<void> {
    await this.softDeleteRecord('staff', userId, deletedByUser, reason);
  }
}
