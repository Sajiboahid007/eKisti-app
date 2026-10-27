import { Injectable, computed, inject, signal } from '@angular/core';
import { doc, getDocFromServer } from '@angular/fire/firestore';
import { FinanceService, PaymentMethod } from './finance.service';
import { Actor, AlreadyPostedError, ConcurrentChangeError, TxRunner } from './tx-runner.service';
import { AuthStateService } from './auth-state.service';
import { todayDhaka } from '../finance/dates';

/**
 * অফলাইন কিস্তি আদায়ের অপেক্ষমাণ সারি (Outbox)।
 *
 * গ্রামে ইন্টারনেট না থাকলে Firestore runTransaction চলে না, তাই মাঠকর্মী আদায়টি এই ডিভাইসের
 * IndexedDB-তে জমা রাখেন। সংযোগ ফিরলে সারিটি FinanceService.collectPayment() দিয়ে একটি একটি করে
 * আসল রসিদে রূপান্তরিত হয় — টাকার হিসাব সবসময় ফাইন্যান্স সার্ভিসের ট্রানজ্যাকশন দিয়েই চলে।
 *
 * - প্রতিটি আদায়ের একটি রেফারেন্স (OFF-…) থাকে: এটিই idempotency key (একই ট্রানজ্যাকশনে
 *   idempotencyKeys/{ref} যাচাই ও লেখা) এবং রসিদের receiptNumberManual। ফলে একাধিক ট্যাব একসাথে সিঙ্ক
 *   করলেও, বা কমিট হয়ে উত্তর হারিয়ে গেলেও, একই আদায় দুবার পোস্ট হয় না।
 * - রসিদের তারিখ = সিঙ্কের দিন (বন্ধ দিনে পেছনের তারিখে পোস্ট করা যায় না); আসল সংগ্রহের সময় কারণে লেখা থাকে।
 * - টাকা মাঠকর্মী ইতিমধ্যে নিয়েছেন, তাই সিঙ্কের সময় অগ্রিম কিস্তি হিসেবে বসার অনুমতি থাকে।
 *   ঋণের মোট বাকির বেশি হলে বা ঋণ বন্ধ হলে এন্ট্রি "ব্যর্থ" হয়ে থাকে — শাখায় হাতে মীমাংসা করতে হবে।
 */
export interface OfflineCollection {
  ref: string;
  status: 'PENDING' | 'FAILED';
  error?: string;
  attempts: number;
  collectedAt: string;          // ISO সময় (ডিভাইস)
  businessDate: string;         // সংগ্রহের দিন (Asia/Dhaka)
  loanId: number;
  loanAccountNo: string;
  customerName: string;
  branchId: number;
  centerId: number;
  loanAmount: number;
  savingsAmount: number;
  paymentMethod: PaymentMethod;
  trxId?: string;
  reason: string;
  actor: Actor;
}

export interface SyncResult {
  synced: number;
  failed: number;
  stoppedOffline: boolean;
}

const DB_NAME = 'ekisti-offline';
const STORE = 'collections';
const SYNC_LOCK = 'ekisti-offline-sync';

/** ক্ষণস্থায়ী (নেটওয়ার্ক / সার্ভার ব্যস্ত) ত্রুটি — এমন হলে এন্ট্রি অপেক্ষমাণই থাকে, পরে আবার চেষ্টা */
const TRANSIENT_CODES = ['unavailable', 'deadline-exceeded', 'aborted', 'resource-exhausted', 'internal', 'cancelled', 'unknown'];

export function isTransientError(err: any): boolean {
  if (err instanceof ConcurrentChangeError) return true;
  const code = String(err?.code || '').replace(/^firestore\//, '');
  return TRANSIENT_CODES.includes(code) || /offline|network|failed to fetch/i.test(String(err?.message || ''));
}

/** IDBRequest সফল + লেনদেন সম্পন্ন (ডিস্কে লেখা নিশ্চিত) হলে resolve */
function inTx<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const r = op(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error || r.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

@Injectable({ providedIn: 'root' })
export class OfflineCollectionQueueService {
  private finance = inject(FinanceService);
  private runner = inject(TxRunner);
  private auth = inject(AuthStateService);

  readonly online = signal<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);
  readonly entries = signal<OfflineCollection[]>([]);
  readonly syncing = signal<boolean>(false);
  /** শেষ সফল সিঙ্কের ফল — স্বয়ংক্রিয় সিঙ্কের পর পাতা রিফ্রেশ করতে */
  readonly lastSync = signal<(SyncResult & { at: number }) | null>(null);

  /** বর্তমান ব্যবহারকারীর এন্ট্রি — অন্যের হাতের টাকা তার নামেই পোস্ট হওয়া উচিত */
  readonly mine = computed(() => {
    const userId = this.auth.currentUser().userId;
    return this.entries().filter(e => e.actor.userId === userId);
  });
  readonly pending = computed(() => this.mine().filter(e => e.status === 'PENDING'));
  readonly failed = computed(() => this.mine().filter(e => e.status === 'FAILED'));
  readonly pendingCount = computed(() => this.pending().length);
  readonly failedCount = computed(() => this.failed().length);
  readonly pendingTotal = computed(() => this.pending().reduce((s, e) => s + e.loanAmount + e.savingsAmount, 0));
  readonly failedTotal = computed(() => this.failed().reduce((s, e) => s + e.loanAmount + e.savingsAmount, 0));
  /** ঋণভিত্তিক সিঙ্ক না হওয়া টাকা (অপেক্ষমাণ + ব্যর্থ) — মাঠ শিটের সারিতে দেখানোর জন্য */
  readonly unsyncedByLoan = computed(() => {
    const map = new Map<number, number>();
    for (const e of this.mine()) map.set(e.loanId, (map.get(e.loanId) || 0) + e.loanAmount + e.savingsAmount);
    return map;
  });

  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', () => {
      this.online.set(true);
      void this.sync();
    });
    window.addEventListener('offline', () => this.online.set(false));
    void this.reload().then(() => { if (this.online()) void this.sync(); });
  }

  /** নতুন রেফারেন্স — অনলাইন চেষ্টাতেও এটি idempotency key হিসেবে যায়, যাতে ব্যর্থ হলে একই রেফে সারিতে রাখা যায় */
  newRef(userId: number): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const rand = Math.floor(Math.random() * 36 ** 4).toString(36).toUpperCase().padStart(4, '0');
    return `OFF-${userId}-${stamp}${rand}`;
  }

  /** অফলাইনে আদায় সারিতে রাখা — রেফারেন্স ফেরত দেয় (গ্রাহককে হাতে লেখা রসিদে দিন) */
  async enqueue(input: Omit<OfflineCollection, 'ref' | 'status' | 'attempts' | 'collectedAt' | 'businessDate'> & { ref?: string }): Promise<OfflineCollection> {
    if (!(input.loanAmount >= 0) || !(input.savingsAmount >= 0) || input.loanAmount + input.savingsAmount <= 0) {
      throw new Error('আদায়ের সঠিক পরিমাণ দিন');
    }
    if (input.paymentMethod !== 'CASH' && !input.trxId?.trim()) {
      throw new Error('বিকাশ/নগদ/ব্যাংক আদায়ে TrxID বা রেফারেন্স নম্বর বাধ্যতামূলক');
    }
    const entry: OfflineCollection = {
      ...input,
      ref: input.ref || this.newRef(input.actor.userId),
      status: 'PENDING',
      attempts: 0,
      collectedAt: new Date().toISOString(),
      businessDate: todayDhaka()
    };
    await this.put(entry);
    await this.reload();
    return entry;
  }

  /**
   * বর্তমান ব্যবহারকারীর অপেক্ষমাণ আদায়গুলো সার্ভারে পাঠানো।
   * একাধিক ট্যাব থাকলে Web Locks দিয়ে একবারে একটিই সিঙ্ক করে (সঠিকতা অবশ্য idempotency key-ই নিশ্চিত করে)।
   */
  async sync(includeFailed = false): Promise<SyncResult> {
    if (this.syncing() || !this.online()) return { synced: 0, failed: 0, stoppedOffline: !this.online() };
    this.syncing.set(true);
    try {
      const locks = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
      const result: SyncResult = locks?.request
        ? await locks.request(SYNC_LOCK, () => this.drain(includeFailed))
        : await this.drain(includeFailed);
      if (result.synced || result.failed) this.lastSync.set({ ...result, at: Date.now() });
      return result;
    } finally {
      this.syncing.set(false);
    }
  }

  /** ব্যর্থ এন্ট্রি মুছে ফেলা — টাকাটি শাখায় হাতে মীমাংসা করার পর */
  async discard(ref: string): Promise<void> {
    await this.remove(ref);
    await this.reload();
  }

  private async drain(includeFailed: boolean): Promise<SyncResult> {
    const result: SyncResult = { synced: 0, failed: 0, stoppedOffline: false };
    await this.reload(); // অন্য ট্যাব ইতিমধ্যে পাঠিয়ে থাকলে
    const queue = this.mine()
      .filter(e => e.status === 'PENDING' || (includeFailed && e.status === 'FAILED'))
      .sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
    if (!queue.length) return result;

    // navigator.onLine "সংযুক্ত" বললেও আসল সংযোগ না থাকতে পারে — তখন ক্যাশের পুরাতন ডেটায় ভুলভাবে "ব্যর্থ" না হয়
    if (!(await this.serverReachable())) return { ...result, stoppedOffline: true };

    for (const entry of queue) {
      try {
        await this.finance.collectPayment({
          loanId: entry.loanId,
          loanAmount: entry.loanAmount,
          savingsAmount: entry.savingsAmount,
          paymentMethod: entry.paymentMethod,
          trxId: entry.trxId,
          receiptNumberManual: entry.ref,
          idempotencyKey: entry.ref,
          allowAdvance: true,
          reason: `${entry.reason} — অফলাইন আদায় ${entry.ref} (সংগ্রহ: ${entry.businessDate} ${this.timeOf(entry.collectedAt)})`
        }, entry.actor);
        await this.remove(entry.ref);
        result.synced++;
      } catch (err: any) {
        if (err instanceof AlreadyPostedError) {
          await this.remove(entry.ref); // আগেই রসিদ হয়েছে (অন্য ট্যাব / হারানো উত্তর)
          result.synced++;
          continue;
        }
        if (isTransientError(err)) {
          result.stoppedOffline = true;
          break;
        }
        await this.put({ ...entry, status: 'FAILED', error: err?.message || String(err), attempts: entry.attempts + 1 });
        result.failed++;
      }
    }
    await this.reload();
    return result;
  }

  private async serverReachable(): Promise<boolean> {
    try {
      await getDocFromServer(doc(this.runner.firestore, 'settings', 'general'));
      return true;
    } catch (err) {
      return !isTransientError(err); // অনুমতি-ত্রুটি ইত্যাদি মানে সার্ভারে পৌঁছানো গেছে
    }
  }

  // ---------- IndexedDB ----------

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'ref' });
        };
        open.onsuccess = () => {
          const db = open.result;
          // ভবিষ্যৎ সংস্করণ অন্য ট্যাবে খুললে এই সংযোগ ছেড়ে দেওয়া, পরের ব্যবহারে আবার খোলা হবে
          db.onversionchange = () => { db.close(); this.dbPromise = null; };
          resolve(db);
        };
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('অফলাইন ডেটাবেস অন্য ট্যাবে আটকে আছে — অন্য ট্যাবগুলো বন্ধ করে আবার চেষ্টা করুন'));
      }).catch(err => {
        this.dbPromise = null; // পরের বার আবার চেষ্টা
        throw err;
      });
    }
    return this.dbPromise;
  }

  private async put(entry: OfflineCollection): Promise<void> {
    await inTx(await this.db(), 'readwrite', store => store.put(entry));
  }

  private async remove(ref: string): Promise<void> {
    await inTx(await this.db(), 'readwrite', store => store.delete(ref));
  }

  private async reload(): Promise<void> {
    try {
      const all = await inTx(await this.db(), 'readonly', store => store.getAll()) as OfflineCollection[];
      this.entries.set(all.sort((a, b) => a.collectedAt.localeCompare(b.collectedAt)));
    } catch (err) {
      console.error('Offline queue unavailable:', err);
    }
  }

  private timeOf(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' });
  }
}
