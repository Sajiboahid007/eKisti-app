/**
 * এককালীন মাইগ্রেশন: প্রতিটি ডকুমেন্টের ভেতরের history[] অ্যারে কেন্দ্রীয় auditLogs কালেকশনে কপি,
 * তারপর ডকুমেন্টে শুধু সর্বশেষ ৩০টি এন্ট্রি রাখা (Firestore 1 MiB ডকুমেন্ট সীমা থেকে বাঁচাতে)।
 *
 * ডিফল্ট: শুধু রিপোর্ট (কিছু লেখা হয় না)
 *   node scripts/migrate-history-to-auditlogs.js
 * আসলে চালাতে:
 *   node scripts/migrate-history-to-auditlogs.js --apply
 *
 * পুনরায় চালানো নিরাপদ: প্রতিটি লগের ডকুমেন্ট আইডি `mig_<collection>_<docId>_<historyId>`, তাই দ্বিগুণ হয় না।
 */
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, getDocs, doc, writeBatch } = require('firebase/firestore');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const APPLY = process.argv.includes('--apply');
const KEEP_EMBEDDED = 30;
const COLLECTIONS = [
  'customers', 'loans', 'installments', 'collections', 'branches', 'centers',
  'staff', 'roles', 'loanProducts', 'savingsTransactions', 'reconciliations'
];

const db = getFirestore(initializeApp(firebaseConfig));

function changesOf(entry) {
  const changes = {};
  const after = entry.newData || {};
  const before = entry.previousData || {};
  for (const key of Object.keys(after)) {
    if (key === 'history') continue;
    changes[key] = { before: before[key] === undefined ? null : before[key], after: after[key] === undefined ? null : after[key] };
  }
  return JSON.parse(JSON.stringify(changes));
}

async function migrate() {
  console.log(`Project: ${firebaseConfig.projectId} — mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
  let totalLogs = 0, trimmedDocs = 0;

  for (const col of COLLECTIONS) {
    const snap = await getDocs(collection(db, col));
    let colLogs = 0;
    let batch = writeBatch(db);
    let ops = 0;
    const flush = async () => {
      if (APPLY && ops > 0) await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    };

    for (const d of snap.docs) {
      const data = d.data();
      const history = Array.isArray(data.history) ? data.history : [];
      if (history.length === 0) continue;

      for (const entry of history) {
        const logId = `mig_${col}_${d.id}_${entry.historyId}`;
        batch.set(doc(db, 'auditLogs', logId), {
          auditId: logId,
          entityType: col,
          entityId: isNaN(Number(d.id)) ? d.id : Number(d.id),
          action: entry.action || 'UPDATE',
          reason: entry.reason || '',
          changes: changesOf(entry),
          branchId: typeof data.branchId === 'number' ? data.branchId : null,
          timestamp: entry.timestamp || new Date(0).toISOString(),
          actor: { userId: entry.changedByUserId || 0, name: entry.changedByName || '', role: entry.changedByRole || '' },
          migrated: true
        });
        colLogs++;
        if (++ops >= 400) await flush();
      }

      if (history.length > KEEP_EMBEDDED) {
        batch.update(d.ref, { history: history.slice(-KEEP_EMBEDDED) });
        trimmedDocs++;
        if (++ops >= 400) await flush();
      }
    }
    await flush();
    totalLogs += colLogs;
    console.log(`  ${col}: ${snap.size} docs, ${colLogs} history entries`);
  }

  console.log(`\nTotal: ${totalLogs} audit log entries, ${trimmedDocs} documents trimmed to last ${KEEP_EMBEDDED}.`);
  if (!APPLY) console.log('Dry run only — re-run with --apply to write.');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
