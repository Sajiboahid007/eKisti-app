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
  orderBy
} from '@angular/fire/firestore';
import { CounterService } from './counter.service';
import { AuditHistoryService } from './audit-history.service';
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
  SavingsTransaction
} from '../models/database.models';

@Injectable({
  providedIn: 'root'
})
export class KistiDatabaseService {
  private firestore = inject(Firestore);
  private counterService = inject(CounterService);
  private auditHistoryService = inject(AuditHistoryService);

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
    await setDoc(docRef, newCustomer);

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

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'UPDATE',
      changedByUserId: changedByUser.userId,
      changedByName: changedByUser.name,
      changedByRole: changedByUser.role,
      reason,
      previousData: currentData,
      newData: updatedFields
    });

    const updatedHistory = this.auditHistoryService.appendHistory(currentData.history, historyEntry);

    await updateDoc(docRef, {
      ...updatedFields,
      history: updatedHistory
    });
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

  async disburseLoan(
    loanData: Omit<Loan, 'loanId' | 'loanAccountNo' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history'>,
    createdByUser: { userId: number; name: string; role: string },
    reason: string = 'নতুন ঋণ বিতরণ ও কিস্তি শিডিউল তৈরি',
    customLoanAccountNo?: string
  ): Promise<{ loan: Loan; installments: InstallmentSchedule[] }> {
    const loanId = await this.counterService.getNextIntegerId('loans');
    let loanAccountNo = `LN-${loanId}`;
    if (customLoanAccountNo && customLoanAccountNo.trim()) {
      const trimmed = customLoanAccountNo.trim();
      loanAccountNo = trimmed.toUpperCase().startsWith('LN-') ? trimmed.toUpperCase() : `LN-${trimmed}`;
    }

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'CREATE',
      changedByUserId: createdByUser.userId,
      changedByName: createdByUser.name,
      changedByRole: createdByUser.role,
      reason,
      newData: { loanId, loanAccountNo, ...loanData }
    });

    const newLoan: Loan = {
      ...loanData,
      loanId,
      loanAccountNo,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [historyEntry]
    };

    // Save Loan document
    const loanDocRef = doc(this.firestore, 'loans', loanId.toString());
    await setDoc(loanDocRef, newLoan);

    // Generate Installment Schedules (e.g. 40 installments)
    const installments: InstallmentSchedule[] = [];
    const installmentAmount = loanData.installmentAmount;
    const savingsPerInstallment = loanData.savingsPerInstallment || 0;
    const principalPerInst = Math.round(loanData.principalAmount / loanData.totalInstallments);
    const profitPerInst = installmentAmount - principalPerInst;

    let dueDateCursor = new Date(loanData.firstInstallmentDueDate);

    for (let i = 1; i <= loanData.totalInstallments; i++) {
      const installmentId = await this.counterService.getNextIntegerId('installments');

      const installment: InstallmentSchedule = {
        installmentId,
        loanId,
        customerId: loanData.customerId,
        branchId: loanData.branchId,
        centerId: loanData.centerId,
        fieldOfficerUserId: loanData.fieldOfficerUserId,
        installmentNo: i,
        dueDate: dueDateCursor.toISOString().split('T')[0],
        expectedPrincipal: principalPerInst,
        expectedProfit: profitPerInst,
        expectedSavings: savingsPerInstallment,
        expectedTotalAmount: installmentAmount + savingsPerInstallment,
        paidPrincipal: 0,
        paidProfit: 0,
        paidSavings: 0,
        paidTotalAmount: 0,
        status: 'PENDING',
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
        history: []
      };

      // Advance date depending on frequency
      if (loanData.installmentFrequency === 'DAILY') {
        dueDateCursor.setDate(dueDateCursor.getDate() + 1);
      } else if (loanData.installmentFrequency === 'MONTHLY') {
        dueDateCursor.setMonth(dueDateCursor.getMonth() + 1);
      } else {
        // Default WEEKLY
        dueDateCursor.setDate(dueDateCursor.getDate() + 7);
      }

      const instDocRef = doc(this.firestore, 'installments', installmentId.toString());
      await setDoc(instDocRef, installment);
      installments.push(installment);
    }

    return { loan: newLoan, installments };
  }

  async peekNextLoanId(): Promise<number> {
    return this.counterService.peekNextIntegerId('loans');
  }

  async updateLoanAccountNo(loanId: number, newAccountNo: string): Promise<string> {
    const trimmed = newAccountNo.trim();
    const finalAccountNo = trimmed.toUpperCase().startsWith('LN-') ? trimmed.toUpperCase() : `LN-${trimmed}`;
    const loanDocRef = doc(this.firestore, 'loans', loanId.toString());
    await updateDoc(loanDocRef, { loanAccountNo: finalAccountNo });
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

  // ==========================================
  // 3. COLLECTION / MONEY RECEIPT (মাঠের কিস্তি আদায়)
  // ==========================================

  /**
   * Records a field collection receipt with Integer Receipt ID (e.g. 40001)
   * and updates the corresponding Installment and Loan balance.
   */
  async collectPayment(
    collectionData: Omit<PaymentCollection, 'receiptId' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history' | 'isHandedOverToBranch'>,
    collectedByUser: { userId: number; name: string; role: string },
    reason: string = 'কিস্তি ও সঞ্চয় আদায়'
  ): Promise<PaymentCollection> {
    const receiptId = await this.counterService.getNextIntegerId('receipts');

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'PAYMENT_COLLECTED',
      changedByUserId: collectedByUser.userId,
      changedByName: collectedByUser.name,
      changedByRole: collectedByUser.role,
      reason,
      newData: { receiptId, ...collectionData }
    });

    const receipt: PaymentCollection = {
      ...collectionData,
      receiptId,
      isHandedOverToBranch: false,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [historyEntry]
    };

    // Save Receipt document
    const receiptDocRef = doc(this.firestore, 'collections', receiptId.toString());
    await setDoc(receiptDocRef, receipt);

    // Update Loan balance
    const loanDocRef = doc(this.firestore, 'loans', collectionData.loanId.toString());
    const loanSnap = await getDoc(loanDocRef);

    if (loanSnap.exists()) {
      const loan = loanSnap.data() as Loan;
      const newPaid = loan.totalPaidAmount + collectionData.principalAmountCollected + collectionData.profitAmountCollected;
      const newOutstanding = Math.max(0, loan.totalRepayableAmount - newPaid);
      const newSavings = loan.totalSavingsCollected + collectionData.savingsAmountCollected;
      const newPaidCount = loan.paidInstallmentsCount + 1;
      const newRemainingCount = Math.max(0, loan.totalInstallments - newPaidCount);

      await updateDoc(loanDocRef, {
        totalPaidAmount: newPaid,
        totalSavingsCollected: newSavings,
        outstandingBalance: newOutstanding,
        paidInstallmentsCount: newPaidCount,
        remainingInstallmentsCount: newRemainingCount,
        status: newOutstanding <= 0 ? 'CLOSED' : loan.status
      });
    }

    // Update Customer savings balance and record savings transaction if savings collected
    if (collectionData.savingsAmountCollected && collectionData.savingsAmountCollected > 0) {
      try {
        const custDocRef = doc(this.firestore, 'customers', collectionData.customerId.toString());
        const custSnap = await getDoc(custDocRef);
        if (custSnap.exists()) {
          const cust = custSnap.data() as Customer;
          const prevBal = cust.totalSavingsBalance || 0;
          const newBal = prevBal + collectionData.savingsAmountCollected;

          await updateDoc(custDocRef, {
            totalSavingsBalance: newBal
          });

          await this.recordSavingsTransaction(
            {
              customerId: collectionData.customerId,
              customerName: collectionData.customerName,
              branchId: collectionData.branchId,
              centerId: collectionData.centerId,
              loanId: collectionData.loanId,
              installmentNo: collectionData.installmentNo,
              type: 'KISTI_COLLECTION',
              amount: collectionData.savingsAmountCollected,
              isCredit: true,
              previousBalance: prevBal,
              newBalance: newBal,
              paymentMethod: collectionData.paymentMethod || 'CASH',
              transactionDate: collectionData.collectionDate || new Date().toISOString(),
              performedByUserId: collectedByUser.userId,
              performedByName: collectedByUser.name,
              performedByRole: collectedByUser.role,
              reason: `কিস্তি #${collectionData.installmentNo} এর সাথে বাধ্যতামূলক সঞ্চয় জমা (+৳ ${collectionData.savingsAmountCollected})`,
              receiptNo: `RCP-${receiptId}`
            },
            collectedByUser,
            `কিস্তির সাথে সঞ্চয় জমা (+৳ ${collectionData.savingsAmountCollected})`
          );
        }
      } catch (err) {
        console.error('Error updating customer savings on collection:', err);
      }
    }

    return receipt;
  }

  // ==========================================
  // 4. SAVINGS OPERATIONS (সঞ্চয় জমা, উত্তোলন ও লেনদেন ইতিহাস)
  // ==========================================

  /**
   * Records a savings transaction (Deposit, Withdraw, Adjustment, Closure)
   * and atomically updates the customer's totalSavingsBalance.
   */
  async recordSavingsTransaction(
    data: Omit<SavingsTransaction, 'transactionId' | 'isDeleted' | 'deletedAt' | 'deletedByUserId' | 'deleteReason' | 'history'>,
    performedByUser: { userId: number; name: string; role: string },
    reason: string
  ): Promise<SavingsTransaction> {
    const transactionId = await this.counterService.getNextIntegerId('savings');

    const historyEntry = await this.auditHistoryService.createHistoryEntry({
      action: 'CREATE',
      changedByUserId: performedByUser.userId,
      changedByName: performedByUser.name,
      changedByRole: performedByUser.role,
      reason,
      newData: { transactionId, ...data }
    });

    const transaction: SavingsTransaction = {
      ...data,
      transactionId,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [historyEntry]
    };

    // 1. Save savings transaction document
    const docRef = doc(this.firestore, 'savingsTransactions', transactionId.toString());
    await setDoc(docRef, transaction);

    // 2. Atomically update Customer totalSavingsBalance in Firestore
    const custDocRef = doc(this.firestore, 'customers', data.customerId.toString());
    const custSnap = await getDoc(custDocRef);
    if (custSnap.exists()) {
      await updateDoc(custDocRef, {
        totalSavingsBalance: data.newBalance
      });
    }

    return transaction;
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

    await updateDoc(docRef, {
      ...updatedFields,
      history: updatedHistory
    });
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

    await updateDoc(docRef, {
      isDeleted: true,
      deletedAt: now,
      deletedByUserId: deletedByUser.userId,
      deleteReason: reason,
      history: this.auditHistoryService.appendHistory(currentData['history'], historyEntry)
    });
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

  async getCenters(branchId?: number): Promise<CenterOrSamity[]> {
    try {
      const snap = await getDocs(collection(this.firestore, 'centers'));
      let list: CenterOrSamity[] = [];
      snap.forEach(d => {
        const c = d.data() as CenterOrSamity;
        if (!c.isDeleted) {
          list.push(c);
        }
      });

      

      if (branchId) {
        list = list.filter(c => c.branchId === branchId);
      }

      return list.sort((a, b) => a.centerId - b.centerId);
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
    await this.editRecord('centers', centerId, updatedFields, changedByUser, reason);
  }

  async softDeleteCenter(
    centerId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string = 'রুট/সমিতি মুছে ফেলা'
  ): Promise<void> {
    await this.softDeleteRecord('centers', centerId, deletedByUser, reason);
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

  async updateStaff(
    userId: number,
    updatedFields: Partial<UserStaff>,
    changedByUser: { userId: number; name: string; role: string },
    reason: string = 'কর্মী তথ্য আপডেট'
  ): Promise<void> {
    await this.editRecord('staff', userId, updatedFields, changedByUser, reason);
  }

  async softDeleteStaff(
    userId: number,
    deletedByUser: { userId: number; name: string; role: string },
    reason: string = 'কর্মী মুছে ফেলা'
  ): Promise<void> {
    await this.softDeleteRecord('staff', userId, deletedByUser, reason);
  }
}
