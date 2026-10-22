const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, deleteDoc } = require('firebase/firestore');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

console.log('Connecting to Firebase Firestore for project:', firebaseConfig.projectId);

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

async function seedDatabase() {
  try {
    const timestamp = new Date().toISOString();

    // নিরাপত্তা: ডেটাবেজে আগে থেকেই ডেটা থাকলে সিড চালালে কাউন্টার রিসেট হয়ে
    // নতুন গ্রাহক/ঋণ পুরাতন রেকর্ডের ওপর লেখা হয়ে যেত। --force ছাড়া বন্ধ।
    const existing = await getDoc(doc(db, 'counters', 'customers'));
    if (existing.exists() && !process.argv.includes('--force')) {
      console.error('\n✗ এই ডেটাবেজে ইতোমধ্যে ডেটা আছে (counters/customers পাওয়া গেছে)।');
      console.error('  সিড চালালে বিদ্যমান গ্রাহক, ঋণ ও কিস্তি ওভাররাইট হতে পারে।');
      console.error('  শুধু নতুন / ডেমো ডেটাবেজে চালাতে চাইলে: npm run db:seed -- --force\n');
      process.exit(1);
    }

    console.log('\n--- 1. Pushing System Counters (অটো-ইনক্রিমেন্ট কাউন্টার) ---');
    const counters = [
      { id: 'branches', currentSequenceId: 1, entityName: 'branches' },
      { id: 'centers', currentSequenceId: 101, entityName: 'centers' },
      { id: 'staff', currentSequenceId: 503, entityName: 'staff' },
      { id: 'loanProducts', currentSequenceId: 2, entityName: 'loanProducts' },
      { id: 'customers', currentSequenceId: 10001, entityName: 'customers' },
      { id: 'loans', currentSequenceId: 20001, entityName: 'loans' },
      { id: 'installments', currentSequenceId: 30040, entityName: 'installments' },
      { id: 'receipts', currentSequenceId: 40001, entityName: 'receipts' },
      { id: 'reconciliations', currentSequenceId: 50001, entityName: 'reconciliations' },
      { id: 'history', currentSequenceId: 1, entityName: 'history' }
    ];

    for (const c of counters) {
      await setDoc(doc(db, 'counters', c.id), { ...c, updatedAt: timestamp });
      console.log(`  ✓ Counter initialized: ${c.id} -> ${c.currentSequenceId}`);
    }

    console.log('\n--- 2. Pushing Branches (শাখা) ---');
    const branch1 = {
      branchId: 1,
      branchCode: 'BR-01',
      name: 'মিরপুর শাখা (Mirpur Branch)',
      address: 'বাড়ি নং ১২, রোড ৪, সেকশন ১০, মিরপুর, ঢাকা',
      phone: '01711000001',
      regionName: 'ঢাকা উত্তর (Dhaka North)',
      areaName: 'মিরপুর জোন (Mirpur Zone)',
      managerUserId: 501,
      cashierUserId: 503,
      currentVaultCash: 150000,
      createdAt: timestamp,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [
        {
          historyId: 1,
          action: 'CREATE',
          timestamp,
          changedByUserId: 501,
          changedByName: 'সিস্টেম অ্যাডমিন',
          changedByRole: 'SUPER_ADMIN',
          reason: 'প্রাথমিক শাখা তৈরি',
          newData: { branchId: 1, name: 'মিরপুর শাখা' }
        }
      ]
    };
    await setDoc(doc(db, 'branches', '1'), branch1);
    console.log('  ✓ Branch 1 pushed: মিরপুর শাখা');

    console.log('\n--- 3. Pushing Staff (কর্মকর্তা ও মাঠকর্মী) ---');
    const staffMembers = [
      {
        userId: 501,
        firebaseAuthUid: '',
        name: 'মোঃ কামরুল ইসলাম',
        phone: '01712345678',
        email: 'kamrul.bm@ekisti.com',
        role: 'BRANCH_MANAGER',
        branchId: 1,
        assignedCenterIds: [101],
        nidNumber: '19852692518000101',
        salary: 45000,
        status: 'ACTIVE',
        joinedDate: '2024-01-01',
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
        history: []
      },
      {
        userId: 502,
        firebaseAuthUid: '',
        name: 'মোঃ রফিকুল ইসলাম',
        phone: '01812345678',
        email: 'rafiqul.fo@ekisti.com',
        role: 'FIELD_OFFICER',
        branchId: 1,
        assignedCenterIds: [101],
        nidNumber: '19922692518000202',
        salary: 25000,
        status: 'ACTIVE',
        joinedDate: '2024-06-01',
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
        history: []
      },
      {
        userId: 503,
        firebaseAuthUid: '',
        name: 'নাসরিন আক্তার',
        phone: '01912345678',
        email: 'nasrin.cashier@ekisti.com',
        role: 'CASHIER',
        branchId: 1,
        assignedCenterIds: [],
        nidNumber: '19942692518000303',
        salary: 30000,
        status: 'ACTIVE',
        joinedDate: '2024-03-15',
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
        history: []
      }
    ];

    for (const s of staffMembers) {
      await setDoc(doc(db, 'staff', s.userId.toString()), s);
      console.log(`  ✓ Staff ${s.userId} pushed: ${s.name} (${s.role})`);
    }

    console.log('\n--- 4. Pushing Centers/Samity (সমিতি ও রুট) ---');
    const center101 = {
      centerId: 101,
      centerCode: 'CEN-101',
      name: 'শাপলা মহিলা সমিতি',
      branchId: 1,
      fieldOfficerUserId: 502,
      meetingDay: 'Monday',
      meetingTime: '10:00 AM',
      location: 'পল্লবী বাজার মোড়, মিরপুর',
      totalMembers: 25,
      activeLoansCount: 18,
      createdAt: timestamp,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(doc(db, 'centers', '101'), center101);
    console.log('  ✓ Center 101 pushed: শাপলা মহিলা সমিতি');

    console.log('\n--- 5. Pushing Loan Products (ঋণের স্কিম ও পলিসি) ---');
    const product1 = {
      productId: 1,
      productName: 'জাগরণ সাধারণ ক্ষুদ্রঋণ (সাপ্তাহিক কিস্তি)',
      frequency: 'WEEKLY',
      defaultInstallmentsCount: 40,
      interestOrServiceChargeRate: 10.0,
      mandatorySavingsPerInstallment: 50,
      formAndProcessingFee: 200,
      insuranceFee: 100,
      minAmount: 10000,
      maxAmount: 100000,
      isActive: true,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    const product2 = {
      productId: 2,
      productName: 'দৈনিক ক্ষুদ্র ব্যবসায়ী কিস্তি (ডেইলি লোন)',
      frequency: 'DAILY',
      defaultInstallmentsCount: 100,
      interestOrServiceChargeRate: 12.0,
      mandatorySavingsPerInstallment: 20,
      formAndProcessingFee: 100,
      insuranceFee: 50,
      minAmount: 5000,
      maxAmount: 50000,
      isActive: true,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: []
    };
    await setDoc(doc(db, 'loanProducts', '1'), product1);
    await setDoc(doc(db, 'loanProducts', '2'), product2);
    console.log('  ✓ Loan Products 1 & 2 pushed: সাপ্তাহিক ও দৈনিক কিস্তি');

    console.log('\n--- 6. Pushing Customer (গ্রাহক প্রোফাইল - সম্পূর্ণ দেশীয় KYC) ---');
    const customer10001 = {
      customerId: 10001,
      customerCode: 'CUST-10001',
      branchId: 1,
      centerId: 101,
      assignedFieldOfficerId: 502,
      fullName: 'রহিমা বেগম',
      fatherName: 'মোঃ আব্দুল লতিফ',
      motherName: 'মোসাঃ রোকেয়া বেগম',
      spouseName: 'মোঃ রফিকুল ইসলাম',
      dateOfBirth: '1990-05-12',
      gender: 'FEMALE',
      phonePrimary: '01912345678',
      phoneSecondary: '01712345679',
      nidNumber: '19902692518000452',
      birthCertificateNo: '',
      presentAddress: {
        villageOrStreet: 'বাড়ি নং ১৪, লেন ২, ব্লক সি, পল্লবী',
        postOffice: 'মিরপুর',
        thanaOrUpazila: 'পল্লবী',
        district: 'ঢাকা',
        houseOwnership: 'RENTED'
      },
      permanentAddress: {
        villageOrStreet: 'গ্রাম: চরভদ্রাসন',
        postOffice: 'চরভদ্রাসন',
        thanaOrUpazila: 'চরভদ্রাসন',
        district: 'ফরিদপুর'
      },
      occupation: 'ক্ষুদ্র ব্যবসা (মুদি দোকান)',
      businessName: 'রহিমা ভ্যারাইটিজ স্টোর',
      monthlyIncome: 28000,
      primaryGuarantor: {
        name: 'মোঃ রফিকুল ইসলাম (স্বামী)',
        relation: 'স্বামী',
        phone: '01788888888',
        nidNumber: '19882692518000789',
        address: 'একই ঠিকানা',
        occupation: 'সিএনজি চালক'
      },
      secondaryGuarantor: {
        name: 'মোঃ আনিসুর রহমান',
        relation: 'প্রতিবেশী ব্যবসায়ী',
        phone: '01677777777',
        nidNumber: '19822692518000555',
        address: 'দোকান নং ৫, পল্লবী বাজার',
        occupation: 'দোকানদার'
      },
      collateral: {
        hasBankCheque: true,
        bankName: 'ইসলামী ব্যাংক বাংলাদেশ পিএলসি',
        bankBranch: 'পল্লবী শাখা',
        accountNumber: '2050114020098765',
        chequeNumber: 'IBBL-CHQ-889922',
        hasStamp: true,
        stampNumber: 'ST-300-884129',
        otherMortgageDetails: 'দোকানের মালামালের জিম্মাদারী'
      },
      totalSavingsBalance: 500,
      totalLoansTaken: 1,
      activeLoansCount: 1,
      creditScore: 'GOOD',
      createdAt: timestamp,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [
        {
          historyId: 1,
          action: 'CREATE',
          timestamp,
          changedByUserId: 502,
          changedByName: 'মোঃ রফিকুল ইসলাম (FO)',
          changedByRole: 'FIELD_OFFICER',
          reason: 'নতুন সদস্য ভর্তি ও KYC সম্পন্ন',
          newData: { customerId: 10001, fullName: 'রহিমা বেগম' }
        }
      ]
    };
    await setDoc(doc(db, 'customers', '10001'), customer10001);
    console.log('  ✓ Customer 10001 pushed: রহিমা বেগম');

    console.log('\n--- 7. Pushing Loan (ঋণ হিসাব) ---');
    const loan20001 = {
      loanId: 20001,
      loanAccountNo: 'LN-20001',
      customerId: 10001,
      customerName: 'রহিমা বেগম',
      branchId: 1,
      centerId: 101,
      fieldOfficerUserId: 502,
      productId: 1,
      principalAmount: 20000,
      interestOrServiceCharge: 4000,
      totalRepayableAmount: 24000,
      installmentFrequency: 'WEEKLY',
      totalInstallments: 40,
      installmentAmount: 600,
      savingsPerInstallment: 50,
      formFeePaid: 200,
      insuranceFeePaid: 100,
      totalPaidAmount: 600,
      totalPrincipalPaid: 500,
      totalProfitPaid: 100,
      totalSavingsCollected: 50,
      outstandingBalance: 23400,
      paidInstallmentsCount: 1,
      remainingInstallmentsCount: 39,
      overdueAmount: 0,
      missedInstallmentsCount: 0,
      applicationDate: '2026-03-01',
      approvedDate: '2026-03-03',
      approvedByUserId: 501,
      disbursementDate: '2026-03-05',
      firstInstallmentDueDate: '2026-03-12',
      expectedClosingDate: '2026-12-10',
      purposeOfLoan: 'মুদি দোকানের মালামাল ক্রয়',
      status: 'DISBURSED',
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [
        {
          historyId: 2,
          action: 'CREATE',
          timestamp,
          changedByUserId: 501,
          changedByName: 'মোঃ কামরুল ইসলাম (BM)',
          changedByRole: 'BRANCH_MANAGER',
          reason: 'ঋণ অনুমোদন ও বিতরণ সম্পন্ন (২০,০০০ টাকা)',
          newData: { loanId: 20001, principalAmount: 20000, totalRepayableAmount: 24000 }
        }
      ]
    };
    await setDoc(doc(db, 'loans', '20001'), loan20001);
    console.log('  ✓ Loan 20001 pushed: ২০,০০০ টাকার ঋণ (মোট পরিশোধ ২৪,০০০)');

    console.log('\n--- 8. Pushing Installment Schedules (৪০টি কিস্তির শিডিউল) ---');
    let cursorDate = new Date('2026-03-12');
    for (let i = 1; i <= 40; i++) {
      const installmentId = 30000 + i;
      const isFirst = (i === 1);
      const inst = {
        installmentId,
        loanId: 20001,
        customerId: 10001,
        branchId: 1,
        centerId: 101,
        fieldOfficerUserId: 502,
        installmentNo: i,
        dueDate: cursorDate.toISOString().split('T')[0],
        expectedPrincipal: 500,
        expectedProfit: 100,
        expectedSavings: 50,
        expectedTotalAmount: 650,
        paidPrincipal: isFirst ? 500 : 0,
        paidProfit: isFirst ? 100 : 0,
        paidSavings: isFirst ? 50 : 0,
        paidTotalAmount: isFirst ? 650 : 0,
        status: isFirst ? 'PAID' : 'PENDING',
        paidDate: isFirst ? '2026-03-12T10:30:00Z' : null,
        collectionReceiptId: isFirst ? 40001 : null,
        isDeleted: false,
        deletedAt: null,
        deletedByUserId: null,
        deleteReason: null,
        history: []
      };

      await setDoc(doc(db, 'installments', installmentId.toString()), inst);
      cursorDate.setDate(cursorDate.getDate() + 7);
    }
    console.log('  ✓ Installments 30001 to 30040 pushed: মোট ৪০টি কিস্তি শিডিউল সফলভাবে তৈরি');

    console.log('\n--- 9. Pushing Collection Receipt (১ম কিস্তির মানি রসিদ) ---');
    const receipt40001 = {
      receiptId: 40001,
      receiptNumberManual: 'MR-01-0042',
      loanId: 20001,
      customerId: 10001,
      customerName: 'রহিমা বেগম',
      installmentId: 30001,
      installmentNo: 1,
      branchId: 1,
      centerId: 101,
      collectedByUserId: 502,
      collectedByName: 'মোঃ রফিকুল ইসলাম (FO)',
      principalAmountCollected: 500,
      profitAmountCollected: 100,
      savingsAmountCollected: 50,
      fineAmountCollected: 0,
      totalAmountCollected: 650,
      paymentMethod: 'CASH',
      collectionDate: '2026-03-12T10:30:00Z',
      isHandedOverToBranch: true,
      reconciliationId: 50001,
      reconciledAt: '2026-03-12T16:00:00Z',
      reconciledByUserId: 503,
      isDeleted: false,
      deletedAt: null,
      deletedByUserId: null,
      deleteReason: null,
      history: [
        {
          historyId: 3,
          action: 'PAYMENT_COLLECTED',
          timestamp: '2026-03-12T10:30:00Z',
          changedByUserId: 502,
          changedByName: 'মোঃ রফিকুল ইসলাম (FO)',
          changedByRole: 'FIELD_OFFICER',
          reason: '১ম কিস্তি ও সঞ্চয় আদায়',
          newData: { receiptId: 40001, totalAmountCollected: 650 }
        }
      ]
    };
    await setDoc(doc(db, 'collections', '40001'), receipt40001);
    console.log('  ✓ Collection 40001 pushed: ১ম কিস্তির রসিদ (৬৫০ টাকা)');

    // Clean up connection test doc
    try {
      await deleteDoc(doc(db, '_connection_test', 'status'));
    } catch (_) {}

    console.log('\n======================================================');
    console.log('🎉 ALL COLLECTIONS PUSHED TO FIREBASE DATABASE SUCCESSFULLY!');
    console.log('======================================================');
    process.exit(0);
  } catch (error) {
    console.error('Error seeding database:', error);
    process.exit(1);
  }
}

seedDatabase();
