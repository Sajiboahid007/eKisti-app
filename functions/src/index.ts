import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import type { Customer, InstallmentSchedule, Loan } from '../../src/app/core/models/database.models';
import { nextCreditScore, overdueMarkerId, planOverdueRun } from '../../src/app/core/finance/overdue';
import { todayDhaka } from '../../src/app/core/finance/dates';

initializeApp();

/** সার্ভারের রান — অডিটে এই নামে দেখা যাবে */
const SYSTEM_ACTOR = { userId: 0, name: 'সিস্টেম (দৈনিক বকেয়া ইঞ্জিন)', role: 'SYSTEM' };

/**
 * দৈনিক বকেয়া ইঞ্জিন — প্রতিদিন রাত ১২:০৫ (Asia/Dhaka), সব শাখা।
 * ব্রাউজারের OverdueEngineService-এর মতো একই হিসাব (core/finance/overdue.ts) ও একই লেখা:
 * কিস্তি OVERDUE, ঋণের বকেয়া/দিন/MRA শ্রেণী, loanStatusHistory, গ্রাহকের ক্রেডিট স্কোর + creditScoreHistory।
 * শেষে systemJobs/overdue_ALL মার্কার — সেটি আজকের হলে ড্যাশবোর্ড আর নিজে চালায় না।
 */
export const dailyOverdueEngine = onSchedule(
  {
    schedule: '5 0 * * *',
    timeZone: 'Asia/Dhaka',
    region: 'asia-south1',
    memory: '512MiB',
    timeoutSeconds: 540,
    retryCount: 2
  },
  async () => {
    const db = getFirestore();
    const today = todayDhaka();
    const now = new Date().toISOString();

    const loanSnap = await db.collection('loans').where('status', 'in', ['DISBURSED', 'OVERDUE']).get();
    const loans = loanSnap.docs.map(d => d.data() as Loan).filter(l => !l.isDeleted);
    const instSnap = await db.collection('installments').where('status', 'in', ['PENDING', 'PARTIAL', 'OVERDUE']).get();
    const byLoan = new Map<number, InstallmentSchedule[]>();
    for (const d of instSnap.docs) {
      const inst = d.data() as InstallmentSchedule;
      if (inst.isDeleted) continue;
      const list = byLoan.get(inst.loanId) || [];
      list.push(inst);
      byLoan.set(inst.loanId, list);
    }

    const plan = planOverdueRun(loans, byLoan, today);
    const writer = db.bulkWriter();
    // BulkWriter নিজে ক্ষণস্থায়ী ত্রুটিতে পুনরায় চেষ্টা করে; শেষ পর্যন্ত ব্যর্থ লেখা গুনে রাখা হয়
    let failedWrites = 0;
    const track = (p: Promise<unknown>) => { p.catch(err => { failedWrites++; logger.error('Overdue write failed', err); }); };

    for (const installmentId of plan.installmentIdsToMark) {
      track(writer.update(db.collection('installments').doc(String(installmentId)), { status: 'OVERDUE' }));
    }

    for (const u of plan.loanUpdates) {
      track(writer.update(db.collection('loans').doc(String(u.loanId)), {
        status: u.status,
        overdueAmount: u.overdueAmount,
        missedInstallmentsCount: u.missedInstallmentsCount,
        daysPastDue: u.daysPastDue,
        classification: u.classification,
        classifiedAt: now
      }));
      if (u.statusChanged) {
        track(writer.create(db.collection('loanStatusHistory').doc(), {
          loanId: u.loanId, fromStatus: u.fromStatus, toStatus: u.status,
          reason: u.reason, branchId: u.branchId, timestamp: now, actor: SYSTEM_ACTOR
        }));
      }
    }

    // ক্রেডিট স্কোর — গ্রাহক ডকুমেন্ট একসাথে পড়া
    let creditScoresChanged = 0;
    const customerIds = [...plan.maxDpdByCustomer.keys()];
    const customerRefs = customerIds.map(id => db.collection('customers').doc(String(id)));
    const customerSnaps = customerRefs.length ? await db.getAll(...customerRefs) : [];
    for (const snap of customerSnaps) {
      if (!snap.exists) continue;
      const customer = snap.data() as Customer;
      const dpd = plan.maxDpdByCustomer.get(Number(snap.id)) ?? 0;
      const target = nextCreditScore(customer.creditScore, dpd);
      if (!target) continue;
      creditScoresChanged++;
      track(writer.update(snap.ref, { creditScore: target, creditScoreUpdatedAt: now }));
      track(writer.create(db.collection('creditScoreHistory').doc(), {
        customerId: Number(snap.id), from: customer.creditScore, to: target,
        reason: `বকেয়া ইঞ্জিন: সর্বোচ্চ বকেয়া ${dpd} দিন`, timestamp: now, actor: SYSTEM_ACTOR
      }));
    }

    await writer.close();
    if (failedWrites > 0) {
      // মার্কার লেখা হয় না — Cloud Scheduler পুনরায় চালাবে (idempotent), না হলে ড্যাশবোর্ড ব্যাকআপ রান চলবে
      throw new Error(`Overdue engine: ${failedWrites} write(s) failed; marker not written`);
    }

    const result = {
      date: today,
      loansChecked: plan.loansChecked,
      loansUpdated: plan.loanUpdates.length,
      installmentsMarked: plan.installmentIdsToMark.length,
      creditScoresChanged,
      skipped: false
    };
    await db.collection('systemJobs').doc(overdueMarkerId(null)).set({ ...result, ranAt: now, by: SYSTEM_ACTOR, source: 'CLOUD_SCHEDULER' });
    logger.info('Overdue engine finished', result);
  }
);
