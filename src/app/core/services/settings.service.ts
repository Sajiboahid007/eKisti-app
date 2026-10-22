import { Injectable, inject, signal } from '@angular/core';
import { Firestore, collection, doc, getDoc, getDocs, writeBatch } from '@angular/fire/firestore';
import { GeneralSettings, Holiday, LoanProduct } from '../models/database.models';
import { WorkingCalendar } from '../finance/schedule';
import { AuditHistoryService, diffFields, stripUndefined } from './audit-history.service';
import { CounterService } from './counter.service';

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  weeklyOffDays: [5],             // শুক্রবার
  defaultAdmissionFee: 50,
  defaultPassbookFee: 20,
  savingsInterestAnnualPercent: 0, // ⚖️ প্রতিষ্ঠানের নীতি অনুযায়ী সেট করুন
  lockSavingsWithdrawalWithActiveLoan: true,
  foCashInHandLimit: 50000
};

type Actor = { userId: number; name: string; role: string };

/**
 * সাধারণ নীতি, ছুটির ক্যালেন্ডার ও ঋণ প্রোডাক্ট সেটিংস।
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private firestore = inject(Firestore);
  private audit = inject(AuditHistoryService);
  private counters = inject(CounterService);

  readonly general = signal<GeneralSettings>(DEFAULT_GENERAL_SETTINGS);
  private holidaysCache: Holiday[] | null = null;

  async getGeneralSettings(force = false): Promise<GeneralSettings> {
    if (!force && this.general() !== DEFAULT_GENERAL_SETTINGS) return this.general();
    try {
      const snap = await getDoc(doc(this.firestore, 'settings', 'general'));
      const value = { ...DEFAULT_GENERAL_SETTINGS, ...(snap.exists() ? (snap.data() as GeneralSettings) : {}) };
      this.general.set(value);
      return value;
    } catch (err) {
      console.error('Error loading settings:', err);
      return this.general();
    }
  }

  async saveGeneralSettings(next: GeneralSettings, actor: Actor): Promise<void> {
    const prev = await this.getGeneralSettings(true);
    const value: GeneralSettings = { ...next, updatedAt: new Date().toISOString() };
    const batch = writeBatch(this.firestore);
    batch.set(doc(this.firestore, 'settings', 'general'), value);
    this.audit.writeAuditLog(batch, {
      entityType: 'settings',
      entityId: 'general',
      action: 'UPDATE',
      reason: 'সাধারণ সেটিংস পরিবর্তন',
      changes: diffFields(prev as any, value as any),
      actor: this.audit.actorStamp(actor)
    });
    await batch.commit();
    this.general.set(value);
  }

  // ---------- ছুটির ক্যালেন্ডার ----------

  async getHolidays(force = false): Promise<Holiday[]> {
    if (this.holidaysCache && !force) return this.holidaysCache;
    try {
      const snap = await getDocs(collection(this.firestore, 'holidays'));
      const list: Holiday[] = [];
      snap.forEach(d => list.push(d.data() as Holiday));
      this.holidaysCache = list.sort((a, b) => a.date.localeCompare(b.date));
      return this.holidaysCache;
    } catch (err) {
      console.error('Error loading holidays:', err);
      return [];
    }
  }

  async addHoliday(date: string, name: string, branchIds: number[] | null, actor: Actor): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('সঠিক তারিখ দিন');
    if (!name.trim()) throw new Error('ছুটির নাম লিখুন');
    const holiday: Holiday = {
      date,
      name: name.trim(),
      branchIds: branchIds && branchIds.length > 0 ? branchIds : null,
      createdAt: new Date().toISOString(),
      createdBy: this.audit.actorStamp(actor)
    };
    const batch = writeBatch(this.firestore);
    batch.set(doc(this.firestore, 'holidays', date), holiday);
    this.audit.writeAuditLog(batch, {
      entityType: 'holidays', entityId: date, action: 'CREATE', reason: `ছুটি যোগ: ${holiday.name}`,
      changes: diffFields(undefined, holiday as any), actor: this.audit.actorStamp(actor)
    });
    await batch.commit();
    this.holidaysCache = null;
  }

  async removeHoliday(date: string, actor: Actor): Promise<void> {
    const batch = writeBatch(this.firestore);
    batch.delete(doc(this.firestore, 'holidays', date));
    this.audit.writeAuditLog(batch, {
      entityType: 'holidays', entityId: date, action: 'DELETE', reason: 'ছুটি বাতিল',
      changes: {}, actor: this.audit.actorStamp(actor)
    });
    await batch.commit();
    this.holidaysCache = null;
  }

  /** শাখার জন্য কর্মদিবস ক্যালেন্ডার (সাপ্তাহিক ছুটি + সরকারি/শাখা ছুটি) */
  async getCalendar(branchId: number): Promise<WorkingCalendar> {
    const [general, holidays] = await Promise.all([this.getGeneralSettings(), this.getHolidays()]);
    return {
      weeklyOffDays: general.weeklyOffDays || [],
      holidays: new Set(holidays.filter(h => !h.branchIds || h.branchIds.includes(Number(branchId))).map(h => h.date))
    };
  }

  // ---------- ঋণ প্রোডাক্ট ----------

  async saveLoanProduct(product: LoanProduct, actor: Actor): Promise<LoanProduct> {
    const isNew = !product.productId;
    const productId = isNew ? await this.counters.getNextIntegerId('loanProducts') : product.productId;
    const ref = doc(this.firestore, 'loanProducts', productId.toString());
    const prevSnap = isNew ? null : await getDoc(ref);
    const prev = prevSnap?.exists() ? (prevSnap.data() as LoanProduct) : undefined;

    if (product.minAmount > product.maxAmount) throw new Error('সর্বনিম্ন সীমা সর্বোচ্চ সীমার বেশি হতে পারে না');
    if (product.defaultInstallmentsCount < 1) throw new Error('কিস্তির সংখ্যা সঠিক নয়');

    const entry = this.audit.buildHistoryEntry({
      action: isNew ? 'CREATE' : 'UPDATE',
      changedByUserId: actor.userId, changedByName: actor.name, changedByRole: actor.role,
      reason: isNew ? 'নতুন ঋণ প্রোডাক্ট' : 'ঋণ প্রোডাক্ট নীতি পরিবর্তন',
      previousData: prev as any, newData: product as any
    });
    const value: LoanProduct = stripUndefined({
      ...product,
      productId,
      isDeleted: product.isDeleted ?? false,
      deletedAt: product.deletedAt ?? null,
      deletedByUserId: product.deletedByUserId ?? null,
      deleteReason: product.deleteReason ?? null,
      history: this.audit.appendHistory(prev?.history, entry)
    });

    const batch = writeBatch(this.firestore);
    batch.set(ref, value);
    this.audit.writeAuditLog(batch, {
      entityType: 'loanProducts', entityId: productId, action: isNew ? 'CREATE' : 'UPDATE',
      reason: entry.reason, changes: diffFields(prev as any, value as any), actor: this.audit.actorStamp(actor)
    });
    await batch.commit();
    return value;
  }
}
