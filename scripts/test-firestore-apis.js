const { initializeApp } = require('firebase/app');
const { 
  getFirestore, 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  runTransaction, 
  query, 
  where, 
  orderBy 
} = require('firebase/firestore');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const clean = (val) => {
  if (!val) return '';
  return val.trim().replace(/^["']|["',;]+$/g, '').trim();
};

const firebaseConfig = {
  apiKey: clean(process.env.FIREBASE_API_KEY),
  authDomain: clean(process.env.FIREBASE_AUTH_DOMAIN),
  projectId: clean(process.env.FIREBASE_PROJECT_ID),
  storageBucket: clean(process.env.FIREBASE_STORAGE_BUCKET),
  messagingSenderId: clean(process.env.FIREBASE_MESSAGING_SENDER_ID),
  appId: clean(process.env.FIREBASE_APP_ID),
  measurementId: clean(process.env.FIREBASE_MEASUREMENT_ID)
};

console.log('=== eKisti API & Firestore Verification Test Runner ===');
console.log('Connecting to Firebase Project:', firebaseConfig.projectId);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const results = [];

function recordResult(category, apiName, status, details = '', error = null) {
  results.push({ category, apiName, status, details, error: error ? error.message : null });
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : '❌';
  console.log(`${icon} [${category}] ${apiName}: ${status} ${details ? '- ' + details : ''}`);
  if (error) {
    console.error(`   Error details:`, error.message);
  }
}

// Emulate CounterService
const STARTING_SEQUENCES = {
  branches: 1,
  centers: 101,
  staff: 501,
  roles: 10,
  customers: 10001,
  loans: 20001,
  installments: 30001,
  receipts: 40001,
  reconciliations: 50001,
  history: 1,
  savings: 60001
};

async function getNextIntegerId(entity) {
  const counterDocRef = doc(db, 'counters', entity);
  return await runTransaction(db, async (transaction) => {
    const counterDoc = await transaction.get(counterDocRef);
    let currentId = STARTING_SEQUENCES[entity];
    if (counterDoc.exists()) {
      const data = counterDoc.data();
      currentId = data['currentSequenceId'] || currentId;
      currentId += 1;
    }
    transaction.set(counterDocRef, {
      entityName: entity,
      currentSequenceId: currentId,
      updatedAt: new Date().toISOString()
    });
    return currentId;
  });
}

async function peekNextIntegerId(entity) {
  const counterDocRef = doc(db, 'counters', entity);
  const snap = await getDoc(counterDocRef);
  if (snap.exists()) {
    const data = snap.data();
    return (data['currentSequenceId'] || STARTING_SEQUENCES[entity]) + 1;
  }
  return STARTING_SEQUENCES[entity];
}

async function testCounters() {
  console.log('\n--- 1. Testing Counter Service APIs ---');
  const sequences = Object.keys(STARTING_SEQUENCES);
  for (const seq of sequences) {
    try {
      const peekVal = await peekNextIntegerId(seq);
      const nextVal = await getNextIntegerId(seq);
      recordResult('CounterService', `getNextIntegerId('${seq}')`, 'PASS', `Peek: ${peekVal}, Next: ${nextVal}`);
    } catch (err) {
      recordResult('CounterService', `getNextIntegerId('${seq}')`, 'FAIL', '', err);
    }
  }
}

async function testCustomerAPIs() {
  console.log('\n--- 2. Testing Customer APIs ---');
  let testCustId = null;
  try {
    // 1. getCustomers
    const snap = await getDocs(collection(db, 'customers'));
    recordResult('CustomerAPI', 'getCustomers()', 'PASS', `Found ${snap.size} customers in database`);

    // 2. createCustomer
    testCustId = await getNextIntegerId('customers');
    const custDocRef = doc(db, 'customers', testCustId.toString());
    const now = new Date().toISOString();
    const newCust = {
      customerId: testCustId,
      customerCode: `CUST-${testCustId}`,
      fullName: 'টেস্ট গ্রাহক (API Test Member)',
      fatherName: 'টেস্ট পিতা',
      motherName: 'টেস্ট মাতা',
      spouseName: '',
      dateOfBirth: '1990-01-01',
      gender: 'MALE',
      phonePrimary: '01799999999',
      phoneSecondary: '',
      nidNumber: '9999999999',
      birthCertificateNo: '',
      presentAddress: { villageOrStreet: 'মিরপুর ১০', thanaOrUpazila: 'মিরপুর', district: 'ঢাকা', houseOwnership: 'RENTED' },
      permanentAddress: { villageOrStreet: 'মিরপুর ১০', thanaOrUpazila: 'মিরপুর', district: 'ঢাকা' },
      occupation: 'ক্ষুদ্র ব্যবসা',
      businessName: 'টেস্ট স্টোর',
      monthlyIncome: 25000,
      branchId: 1,
      centerId: 101,
      assignedFieldOfficerId: 502,
      admissionDate: now.split('T')[0],
      admissionFee: 100,
      initialSavingsDeposit: 500,
      totalSavingsBalance: 500,
      totalLoansTaken: 0,
      activeLoansCount: 0,
      creditScore: 'GOOD',
      status: 'ACTIVE',
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdAt: now,
      history: [
        {
          historyId: 1,
          action: 'CREATE',
          timestamp: now,
          changedByUserId: 1,
          changedByName: 'Admin',
          changedByRole: 'SUPER_ADMIN',
          reason: 'API Test Customer Creation'
        }
      ]
    };
    await setDoc(custDocRef, newCust);
    recordResult('CustomerAPI', 'createCustomer()', 'PASS', `Created customer ID: ${testCustId}`);

    // 3. updateCustomer
    await updateDoc(custDocRef, {
      fullName: 'টেস্ট গ্রাহক (Updated Name)',
      totalSavingsBalance: 600
    });
    recordResult('CustomerAPI', 'updateCustomer()', 'PASS', `Updated customer ID: ${testCustId}`);

    // 4. softDeleteCustomer
    await updateDoc(custDocRef, {
      isDeleted: true,
      deletedAt: new Date().toISOString(),
      deletedByUserId: 1,
      deleteReason: 'API Test Cleanup'
    });
    recordResult('CustomerAPI', 'softDeleteCustomer()', 'PASS', `Soft-deleted customer ID: ${testCustId}`);

    // Cleanup doc
    await deleteDoc(custDocRef);
    console.log(`   (Cleaned up test customer document ${testCustId})`);
  } catch (err) {
    recordResult('CustomerAPI', 'Customer Operations', 'FAIL', '', err);
  }
}

async function testBranchAPIs() {
  console.log('\n--- 3. Testing Branch APIs ---');
  let testBranchId = null;
  try {
    // 1. getBranches
    const snap = await getDocs(collection(db, 'branches'));
    recordResult('BranchAPI', 'getBranches()', 'PASS', `Found ${snap.size} branches`);

    // 2. createBranch
    testBranchId = await getNextIntegerId('branches');
    const docRef = doc(db, 'branches', testBranchId.toString());
    const now = new Date().toISOString();
    const branch = {
      branchId: testBranchId,
      branchCode: `BR-${testBranchId}`,
      name: 'টেস্ট শাখা (Test Branch)',
      address: 'টেস্ট রোড, টেস্ট এলাকা',
      phone: '01700000099',
      regionName: 'ঢাকা উত্তর',
      areaName: 'মিরপুর জোন',
      managerUserId: 501,
      cashierUserId: 503,
      currentVaultCash: 50000,
      createdAt: now,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(docRef, branch);
    recordResult('BranchAPI', 'createBranch()', 'PASS', `Created branch ID: ${testBranchId}`);

    // 3. updateBranch
    await updateDoc(docRef, { name: 'টেস্ট শাখা (Updated)' });
    recordResult('BranchAPI', 'updateBranch()', 'PASS', `Updated branch ID: ${testBranchId}`);

    // 4. softDeleteBranch
    await updateDoc(docRef, { isDeleted: true, deletedAt: new Date().toISOString() });
    recordResult('BranchAPI', 'softDeleteBranch()', 'PASS', `Soft-deleted branch ID: ${testBranchId}`);

    // Cleanup
    await deleteDoc(docRef);
  } catch (err) {
    recordResult('BranchAPI', 'Branch Operations', 'FAIL', '', err);
  }
}

async function testCenterAPIs() {
  console.log('\n--- 4. Testing Center / Samity APIs ---');
  let testCenterId = null;
  try {
    // 1. getCenters
    const snap = await getDocs(collection(db, 'centers'));
    recordResult('CenterAPI', 'getCenters()', 'PASS', `Found ${snap.size} centers`);

    // 2. createCenter
    testCenterId = await getNextIntegerId('centers');
    const docRef = doc(db, 'centers', testCenterId.toString());
    const now = new Date().toISOString();
    const center = {
      centerId: testCenterId,
      centerCode: `CEN-${testCenterId}`,
      name: 'টেস্ট সমিতি (Test Samity)',
      branchId: 1,
      fieldOfficerUserId: 502,
      meetingDay: 'Monday',
      meetingTime: '10:00 AM',
      location: 'টেস্ট পাড়া',
      totalMembers: 20,
      activeLoansCount: 0,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdAt: now,
      history: []
    };
    await setDoc(docRef, center);
    recordResult('CenterAPI', 'createCenterOrRoute()', 'PASS', `Created center ID: ${testCenterId}`);

    // 3. updateCenter
    await updateDoc(docRef, { name: 'টেস্ট সমিতি (Updated)' });
    recordResult('CenterAPI', 'updateCenter()', 'PASS', `Updated center ID: ${testCenterId}`);

    // 4. softDeleteCenter
    await updateDoc(docRef, { isDeleted: true, deletedAt: new Date().toISOString() });
    recordResult('CenterAPI', 'softDeleteCenter()', 'PASS', `Soft-deleted center ID: ${testCenterId}`);

    // Cleanup
    await deleteDoc(docRef);
  } catch (err) {
    recordResult('CenterAPI', 'Center Operations', 'FAIL', '', err);
  }
}

async function testRoleAPIs() {
  console.log('\n--- 5. Testing Role APIs ---');
  let testRoleId = null;
  try {
    // 1. getRoles
    const snap = await getDocs(collection(db, 'roles'));
    recordResult('RoleAPI', 'getRoles()', 'PASS', `Found ${snap.size} roles`);

    // 2. createRole
    testRoleId = await getNextIntegerId('roles');
    const docRef = doc(db, 'roles', testRoleId.toString());
    const now = new Date().toISOString();
    const role = {
      roleId: testRoleId,
      code: 'TEST_OFFICER',
      nameBangla: 'টেস্ট কর্মকর্তা',
      nameEnglish: 'Test Officer',
      category: 'BRANCH_STAFF',
      isSystem: false,
      permissions: ['canCollectKisti'],
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      createdAt: now,
      history: []
    };
    await setDoc(docRef, role);
    recordResult('RoleAPI', 'createRole()', 'PASS', `Created role ID: ${testRoleId}`);

    // 3. updateRole
    await updateDoc(docRef, { nameBangla: 'টেস্ট কর্মকর্তা (আপডেট)' });
    recordResult('RoleAPI', 'updateRole()', 'PASS', `Updated role ID: ${testRoleId}`);

    // 4. softDeleteRole
    await updateDoc(docRef, { isDeleted: true, deletedAt: new Date().toISOString() });
    recordResult('RoleAPI', 'softDeleteRole()', 'PASS', `Soft-deleted role ID: ${testRoleId}`);

    // Cleanup
    await deleteDoc(docRef);
  } catch (err) {
    recordResult('RoleAPI', 'Role Operations', 'FAIL', '', err);
  }
}

async function testStaffAPIs() {
  console.log('\n--- 6. Testing Staff APIs ---');
  let testStaffId = null;
  try {
    // 1. getStaff
    const snap = await getDocs(collection(db, 'staff'));
    recordResult('StaffAPI', 'getStaff()', 'PASS', `Found ${snap.size} staff members`);

    // 2. createStaff
    testStaffId = await getNextIntegerId('staff');
    const docRef = doc(db, 'staff', testStaffId.toString());
    const now = new Date().toISOString();
    const staff = {
      userId: testStaffId,
      name: 'টেস্ট কর্মী (Test Staff)',
      email: `test${testStaffId}@ekisti.com`,
      phone: '01711999888',
      nidNumber: '8888888888',
      role: 'FIELD_OFFICER',
      category: 'BRANCH_STAFF',
      branchId: 1,
      branchName: 'মিরপুর শাখা',
      assignedCenterIds: [101],
      salary: 20000,
      status: 'ACTIVE',
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(docRef, staff);
    recordResult('StaffAPI', 'createStaff()', 'PASS', `Created staff ID: ${testStaffId}`);

    // 3. updateStaff
    await updateDoc(docRef, { name: 'টেস্ট কর্মী (আপডেট)' });
    recordResult('StaffAPI', 'updateStaff()', 'PASS', `Updated staff ID: ${testStaffId}`);

    // 4. softDeleteStaff
    await updateDoc(docRef, { isDeleted: true, deletedAt: new Date().toISOString() });
    recordResult('StaffAPI', 'softDeleteStaff()', 'PASS', `Soft-deleted staff ID: ${testStaffId}`);

    // Cleanup
    await deleteDoc(docRef);
  } catch (err) {
    recordResult('StaffAPI', 'Staff Operations', 'FAIL', '', err);
  }
}

async function testLoanProductAPIs() {
  console.log('\n--- 7. Testing Loan Product APIs ---');
  try {
    const snap = await getDocs(collection(db, 'loanProducts'));
    recordResult('LoanProductAPI', 'getLoanProducts()', 'PASS', `Found ${snap.size} loan products`);
  } catch (err) {
    recordResult('LoanProductAPI', 'getLoanProducts()', 'FAIL', '', err);
  }
}

async function testLoanAndInstallmentAPIs() {
  console.log('\n--- 8. Testing Loan & Installment Operations ---');
  let testLoanId = null;
  const createdInstIds = [];
  try {
    // 1. getLoans
    const snap = await getDocs(collection(db, 'loans'));
    recordResult('LoanAPI', 'getLoans()', 'PASS', `Found ${snap.size} loans`);

    // 2. disburseLoan
    testLoanId = await getNextIntegerId('loans');
    const loanDocRef = doc(db, 'loans', testLoanId.toString());
    const now = new Date().toISOString();
    const loanData = {
      loanId: testLoanId,
      loanAccountNo: `LN-${testLoanId}`,
      customerId: 10001,
      customerName: 'মোছাঃ রহিমা বেগম',
      branchId: 1,
      centerId: 101,
      fieldOfficerUserId: 502,
      productId: 1,
      principalAmount: 20000,
      interestOrServiceCharge: 4000,
      totalRepayableAmount: 24000,
      installmentFrequency: 'WEEKLY',
      totalInstallments: 4,
      installmentAmount: 6000,
      savingsPerInstallment: 50,
      formFeePaid: 200,
      insuranceFeePaid: 100,
      totalPaidAmount: 0,
      totalPrincipalPaid: 0,
      totalProfitPaid: 0,
      totalSavingsCollected: 0,
      outstandingBalance: 24000,
      paidInstallmentsCount: 0,
      remainingInstallmentsCount: 4,
      overdueAmount: 0,
      missedInstallmentsCount: 0,
      applicationDate: now.split('T')[0],
      approvedDate: now.split('T')[0],
      approvedByUserId: 1,
      disbursementDate: now.split('T')[0],
      firstInstallmentDueDate: now.split('T')[0],
      expectedClosingDate: now.split('T')[0],
      purposeOfLoan: 'API Test Disburse',
      status: 'DISBURSED',
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(loanDocRef, loanData);

    // Create 4 installments
    for (let i = 1; i <= 4; i++) {
      const instId = await getNextIntegerId('installments');
      createdInstIds.push(instId);
      const instDocRef = doc(db, 'installments', instId.toString());
      const inst = {
        installmentId: instId,
        loanId: testLoanId,
        customerId: 10001,
        branchId: 1,
        centerId: 101,
        fieldOfficerUserId: 502,
        installmentNo: i,
        dueDate: now.split('T')[0],
        expectedPrincipal: 5000,
        expectedProfit: 1000,
        expectedSavings: 50,
        expectedTotalAmount: 6050,
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
      await setDoc(instDocRef, inst);
    }
    recordResult('LoanAPI', 'disburseLoan()', 'PASS', `Created Loan ${testLoanId} with ${createdInstIds.length} installments`);

    // 3. updateLoanAccountNo
    await updateDoc(loanDocRef, { loanAccountNo: `LN-${testLoanId}-CUSTOM` });
    recordResult('LoanAPI', 'updateLoanAccountNo()', 'PASS', `Updated account no`);

    // 4. Query installments by loanId
    const instQuery = query(collection(db, 'installments'), where('loanId', '==', testLoanId));
    const instSnap = await getDocs(instQuery);
    recordResult('InstallmentAPI', "query(installments, where('loanId', '==', ...))", 'PASS', `Found ${instSnap.size} installments`);

    // Cleanup
    await deleteDoc(loanDocRef);
    for (const instId of createdInstIds) {
      await deleteDoc(doc(db, 'installments', instId.toString()));
    }
    console.log(`   (Cleaned up test loan ${testLoanId} and ${createdInstIds.length} installments)`);
  } catch (err) {
    recordResult('LoanAPI', 'Loan & Installment Operations', 'FAIL', '', err);
  }
}

async function testCollectionAndSavingsAPIs() {
  console.log('\n--- 9. Testing Collections & Savings APIs ---');
  let testReceiptId = null;
  let testSavingsId = null;
  try {
    // 1. getPaymentCollections
    const snap = await getDocs(collection(db, 'collections'));
    recordResult('CollectionAPI', 'getPaymentCollections()', 'PASS', `Found ${snap.size} receipts`);

    // 2. collectPayment
    testReceiptId = await getNextIntegerId('receipts');
    const now = new Date().toISOString();
    const receiptRef = doc(db, 'collections', testReceiptId.toString());
    const receipt = {
      receiptId: testReceiptId,
      loanId: 20001,
      customerId: 10001,
      customerName: 'মোছাঃ রহিমা বেগম',
      installmentId: 30001,
      installmentNo: 1,
      branchId: 1,
      centerId: 101,
      collectedByUserId: 502,
      collectedByName: 'আব্দুল কাদের',
      principalAmountCollected: 500,
      profitAmountCollected: 100,
      savingsAmountCollected: 50,
      fineAmountCollected: 0,
      totalAmountCollected: 650,
      paymentMethod: 'CASH',
      collectionDate: now,
      isHandedOverToBranch: false,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(receiptRef, receipt);
    recordResult('CollectionAPI', 'collectPayment()', 'PASS', `Created receipt ID: ${testReceiptId}`);

    // 3. recordSavingsTransaction
    testSavingsId = await getNextIntegerId('savings');
    const savingsRef = doc(db, 'savingsTransactions', testSavingsId.toString());
    const savingsTrx = {
      transactionId: testSavingsId,
      customerId: 10001,
      customerName: 'মোছাঃ রহিমা বেগম',
      branchId: 1,
      centerId: 101,
      loanId: 20001,
      installmentNo: 1,
      type: 'KISTI_COLLECTION',
      amount: 50,
      isCredit: true,
      previousBalance: 500,
      newBalance: 550,
      paymentMethod: 'CASH',
      transactionDate: now,
      performedByUserId: 502,
      performedByName: 'আব্দুল কাদের',
      performedByRole: 'FIELD_OFFICER',
      reason: 'কিস্তির সাথে সঞ্চয় জমা (+৳ 50)',
      receiptNo: `RCP-${testReceiptId}`,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(savingsRef, savingsTrx);
    recordResult('SavingsAPI', 'recordSavingsTransaction()', 'PASS', `Created savings transaction ID: ${testSavingsId}`);

    // 4. getSavingsTransactionsByCustomerId
    const savQuery = query(collection(db, 'savingsTransactions'), where('customerId', '==', 10001));
    const savSnap = await getDocs(savQuery);
    recordResult('SavingsAPI', 'getSavingsTransactionsByCustomerId()', 'PASS', `Found ${savSnap.size} savings transactions for customer 10001`);

    // Cleanup
    await deleteDoc(receiptRef);
    await deleteDoc(savingsRef);
    console.log(`   (Cleaned up test receipt ${testReceiptId} and savings ${testSavingsId})`);
  } catch (err) {
    recordResult('CollectionAPI', 'Collection & Savings Operations', 'FAIL', '', err);
  }
}

async function testDashboardQueries() {
  console.log('\n--- 10. Testing Dashboard Firestore Query Patterns ---');
  try {
    const today = new Date().toISOString().split('T')[0];
    const windowStart = new Date();
    windowStart.setDate(windowStart.getDate() - 7);

    // 1. installments dueDate == today
    const q1 = query(collection(db, 'installments'), where('dueDate', '==', today));
    const s1 = await getDocs(q1);
    recordResult('DashboardQuery', "query(installments, where('dueDate', '==', today))", 'PASS', `Docs returned: ${s1.size}`);

    // 2. collections collectionDate >= windowStart
    const q2 = query(collection(db, 'collections'), where('collectionDate', '>=', windowStart.toISOString()));
    const s2 = await getDocs(q2);
    recordResult('DashboardQuery', "query(collections, where('collectionDate', '>=', windowStart))", 'PASS', `Docs returned: ${s2.size}`);

    // 3. collections isHandedOverToBranch == false
    const q3 = query(collection(db, 'collections'), where('isHandedOverToBranch', '==', false));
    const s3 = await getDocs(q3);
    recordResult('DashboardQuery', "query(collections, where('isHandedOverToBranch', '==', false))", 'PASS', `Docs returned: ${s3.size}`);

    // 4. loans branchId in [1, 2]
    const q4 = query(collection(db, 'loans'), where('branchId', 'in', [1, 2]));
    const s4 = await getDocs(q4);
    recordResult('DashboardQuery', "query(loans, where('branchId', 'in', [1, 2]))", 'PASS', `Docs returned: ${s4.size}`);
  } catch (err) {
    recordResult('DashboardQuery', 'Dashboard Queries', 'FAIL', '', err);
  }
}

async function testReconciliationAndVaultAPIs() {
  console.log('\n--- 11. Testing Reconciliation & Vault APIs ---');
  let testRecId = null;
  try {
    // Check if reconciliations collection exists
    testRecId = await getNextIntegerId('reconciliations');
    const recRef = doc(db, 'reconciliations', testRecId.toString());
    const now = new Date().toISOString();
    const recData = {
      reconciliationId: testRecId,
      date: now.split('T')[0],
      branchId: 1,
      fieldOfficerUserId: 502,
      fieldOfficerName: 'আব্দুল কাদের',
      targetCollectionAmount: 10000,
      actualCashCollected: 10000,
      shortageOrDeficitAmount: 0,
      cashHandedOverAmount: 10000,
      cashierUserId: 503,
      cashierStatus: 'ACCEPTED',
      cashierNotes: 'API Test Reconciliation',
      receiptIds: [],
      createdAt: now,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(recRef, recData);
    recordResult('ReconciliationAPI', 'DailyReconciliation Write', 'PASS', `Created reconciliation ${testRecId}`);

    // Check branch vault cash read and update
    const branchDocRef = doc(db, 'branches', '1');
    const bSnap = await getDoc(branchDocRef);
    if (bSnap.exists()) {
      const bData = bSnap.data();
      recordResult('VaultAPI', 'Branch Vault Read', 'PASS', `Branch 1 Current Vault Cash: ৳${bData.currentVaultCash || 0}`);
    } else {
      recordResult('VaultAPI', 'Branch Vault Read', 'WARN', 'Branch 1 not found in Firestore');
    }

    // Cleanup
    await deleteDoc(recRef);
    console.log(`   (Cleaned up test reconciliation ${testRecId})`);
  } catch (err) {
    recordResult('ReconciliationAPI', 'Reconciliation & Vault Operations', 'FAIL', '', err);
  }
}

async function runAll() {
  try {
    await testCounters();
    await testCustomerAPIs();
    await testBranchAPIs();
    await testCenterAPIs();
    await testRoleAPIs();
    await testStaffAPIs();
    await testLoanProductAPIs();
    await testLoanAndInstallmentAPIs();
    await testCollectionAndSavingsAPIs();
    await testDashboardQueries();
    await testReconciliationAndVaultAPIs();

    console.log('\n====================================');
    console.log('SUMMARY OF TEST RESULTS:');
    const total = results.length;
    const passes = results.filter(r => r.status === 'PASS').length;
    const warns = results.filter(r => r.status === 'WARN').length;
    const fails = results.filter(r => r.status === 'FAIL').length;
    console.log(`Total APIs & Queries Checked: ${total}`);
    console.log(`Passed: ${passes}`);
    console.log(`Warnings: ${warns}`);
    console.log(`Failed: ${fails}`);
    console.log('====================================');
    process.exit(fails > 0 ? 1 : 0);
  } catch (e) {
    console.error('Test Runner encountered catastrophic error:', e);
    process.exit(1);
  }
}

runAll();
