import { Injectable, inject } from '@angular/core';
import { collection, doc, getDoc, getDocs, query, setDoc, where, writeBatch } from '@angular/fire/firestore';
import { Storage, getDownloadURL, ref, uploadBytes } from '@angular/fire/storage';
import {
  CreditScoreChange,
  Customer,
  DocumentVersion,
  InstallmentSchedule,
  Loan,
  MeetingAttendance,
  MemberTransfer,
  PaymentCollection
} from '../models/database.models';
import { isSettledStatus } from '../finance/allocation';
import { todayDhaka } from '../finance/dates';
import { normalizeNid } from '../finance/validation';
import { diffFields } from './audit-history.service';
import { CounterService } from './counter.service';
import { Actor, TxRunner } from './tx-runner.service';

const DOC_FIELD: Record<DocumentVersion['docType'], keyof Customer> = {
  PHOTO: 'photoUrl',
  NID_FRONT: 'nidFrontPhotoUrl',
  NID_BACK: 'nidBackPhotoUrl',
  SIGNATURE: 'signaturePhotoUrl'
};

/**
 * সদস্য সংক্রান্ত কাজ: NID যাচাই, স্থানান্তর, কালো তালিকা, মিটিং হাজিরা ও KYC ডকুমেন্ট।
 */
@Injectable({ providedIn: 'root' })
export class MemberService {
  private runner = inject(TxRunner);
  private counters = inject(CounterService);
  private storage = inject(Storage);
  private firestore = this.runner.firestore;

  /** একই NID দিয়ে অন্য সদস্য (ডুপ্লিকেট নিবন্ধন ঠেকাতে) */
  async findByNid(nid: string, excludeCustomerId?: number): Promise<Customer[]> {
    const normalized = normalizeNid(nid);
    if (!normalized) return [];
    const variants = [...new Set([normalized, nid.trim()])];
    const snaps = await Promise.all(variants.map(v => getDocs(query(collection(this.firestore, 'customers'), where('nidNumber', '==', v)))));
    const map = new Map<number, Customer>();
    snaps.forEach(snap => snap.forEach(d => {
      const c = d.data() as Customer;
      if (!c.isDeleted && c.customerId !== excludeCustomerId) map.set(c.customerId, c);
    }));
    return [...map.values()];
  }

  /**
   * সদস্য স্থানান্তর (সমিতি / শাখা / মাঠকর্মী) — চলমান ঋণ ও অপরিশোধিত কিস্তিও সাথে যায়।
   * মাঠকর্মীর হাতে এই সদস্যের জমা-না-হওয়া টাকা থাকলে আগে ক্যাশ ক্লোজিং করতে হবে।
   */
  async transferMember(params: { customerId: number; toBranchId: number; toCenterId: number; toFieldOfficerId: number; reason: string }, actor: Actor): Promise<MemberTransfer> {
    if (!params.reason.trim()) throw new Error('স্থানান্তরের কারণ লিখুন');
    const custSnap = await getDoc(this.runner.customerRef(params.customerId));
    if (!custSnap.exists()) throw new Error('গ্রাহক পাওয়া যায়নি');
    const customer = custSnap.data() as Customer;
    if (Number(customer.centerId) === Number(params.toCenterId) && Number(customer.assignedFieldOfficerId) === Number(params.toFieldOfficerId)) {
      throw new Error('বর্তমান ও নতুন সমিতি/মাঠকর্মী একই');
    }

    const receipts = await getDocs(query(collection(this.firestore, 'collections'), where('customerId', '==', params.customerId)));
    if (receipts.docs.some(d => { const r = d.data() as PaymentCollection; return !r.isHandedOverToBranch && !r.isReversed && !r.isDeleted; })) {
      throw new Error('এই সদস্যের আদায়কৃত টাকা এখনো মাঠকর্মীর হাতে — আগে ক্যাশ ক্লোজিং সম্পন্ন করুন');
    }

    const loansSnap = await getDocs(query(collection(this.firestore, 'loans'), where('customerId', '==', params.customerId)));
    const activeLoans = loansSnap.docs.map(d => d.data() as Loan)
      .filter(l => !l.isDeleted && ['APPLIED', 'FIELD_VERIFIED', 'APPROVED', 'DISBURSED', 'OVERDUE', 'WRITTEN_OFF'].includes(l.status));
    const openInstallments: InstallmentSchedule[] = [];
    for (const loan of activeLoans) {
      const insts = await this.runner.getInstallments(loan.loanId);
      openInstallments.push(...insts.filter(i => !isSettledStatus(i.status)));
    }
    if (activeLoans.length + openInstallments.length > 450) throw new Error('একবারে স্থানান্তরের জন্য রেকর্ড অনেক বেশি — প্রধান কার্যালয়ের সহায়তা নিন');

    const transferId = await this.counters.getNextIntegerId('memberTransfers');
    const now = new Date().toISOString();
    const stamp = this.runner.audit.actorStamp(actor);
    const move = { branchId: Number(params.toBranchId), centerId: Number(params.toCenterId) };

    const batch = writeBatch(this.firestore);
    const custFields = { ...move, assignedFieldOfficerId: Number(params.toFieldOfficerId) };
    const entry = this.runner.audit.buildHistoryEntry({ action: 'TRANSFER', changedByUserId: actor.userId, changedByName: actor.name, changedByRole: actor.role, reason: params.reason, previousData: customer as any, newData: custFields });
    batch.update(this.runner.customerRef(params.customerId), { ...custFields, history: this.runner.audit.appendHistory(customer.history, entry) });
    for (const loan of activeLoans) {
      batch.update(this.runner.loanRef(loan.loanId), { ...move, fieldOfficerUserId: Number(params.toFieldOfficerId) });
    }
    for (const inst of openInstallments) {
      batch.update(this.runner.installmentRef(inst.installmentId), { ...move, fieldOfficerUserId: Number(params.toFieldOfficerId) });
    }
    const transfer: MemberTransfer = {
      transferId, customerId: params.customerId,
      fromBranchId: Number(customer.branchId), fromCenterId: Number(customer.centerId), fromFieldOfficerId: Number(customer.assignedFieldOfficerId),
      toBranchId: move.branchId, toCenterId: move.centerId, toFieldOfficerId: Number(params.toFieldOfficerId),
      loansMoved: activeLoans.map(l => l.loanId), reason: params.reason.trim(),
      businessDate: todayDhaka(), createdAt: now, createdBy: stamp
    };
    batch.set(doc(this.firestore, 'memberTransfers', String(transferId)), transfer);
    this.runner.audit.writeAuditLog(batch, {
      entityType: 'customers', entityId: params.customerId, action: 'TRANSFER', reason: params.reason,
      changes: diffFields(customer as any, custFields), branchId: Number(customer.branchId), actor: stamp
    });
    await batch.commit();
    return transfer;
  }

  async getTransfers(customerId: number): Promise<MemberTransfer[]> {
    const snap = await getDocs(query(collection(this.firestore, 'memberTransfers'), where('customerId', '==', customerId)));
    return snap.docs.map(d => d.data() as MemberTransfer).sort((a, b) => b.transferId - a.transferId);
  }

  /** ক্রেডিট স্কোর / কালো তালিকা — কারণসহ ইতিহাস */
  async setCreditScore(customerId: number, score: Customer['creditScore'], reason: string, actor: Actor): Promise<void> {
    if (!reason.trim()) throw new Error('কারণ লেখা বাধ্যতামূলক');
    const snap = await getDoc(this.runner.customerRef(customerId));
    const customer = snap.data() as Customer;
    if (customer.creditScore === score) return;
    const now = new Date().toISOString();
    const fields = { creditScore: score, blacklistReason: score === 'BLACKLISTED' ? reason.trim() : '', creditScoreUpdatedAt: now };
    const entry = this.runner.audit.buildHistoryEntry({ action: 'STATUS_CHANGE', changedByUserId: actor.userId, changedByName: actor.name, changedByRole: actor.role, reason, previousData: customer as any, newData: fields });
    const batch = writeBatch(this.firestore);
    batch.update(this.runner.customerRef(customerId), { ...fields, history: this.runner.audit.appendHistory(customer.history, entry) });
    const change: CreditScoreChange = { customerId, from: customer.creditScore, to: score, reason: reason.trim(), timestamp: now, actor: this.runner.audit.actorStamp(actor) };
    batch.set(doc(collection(this.firestore, 'creditScoreHistory')), change);
    this.runner.audit.writeAuditLog(batch, { entityType: 'customers', entityId: customerId, action: 'STATUS_CHANGE', reason, changes: diffFields(customer as any, fields), branchId: Number(customer.branchId), actor: change.actor });
    await batch.commit();
  }

  async getCreditScoreHistory(customerId: number): Promise<CreditScoreChange[]> {
    const snap = await getDocs(query(collection(this.firestore, 'creditScoreHistory'), where('customerId', '==', customerId)));
    return snap.docs.map(d => d.data() as CreditScoreChange).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  // ---------- সাপ্তাহিক মিটিং হাজিরা ----------

  async saveAttendance(params: { centerId: number; branchId: number; date: string; presentCustomerIds: number[]; absentCustomerIds: number[]; notes?: string }, actor: Actor): Promise<void> {
    const meetingId = `${params.centerId}_${params.date}`;
    const record: MeetingAttendance = {
      meetingId, centerId: Number(params.centerId), branchId: Number(params.branchId), date: params.date,
      presentCustomerIds: params.presentCustomerIds, absentCustomerIds: params.absentCustomerIds,
      notes: params.notes?.trim() || '', recordedAt: new Date().toISOString(), recordedBy: this.runner.audit.actorStamp(actor)
    };
    await setDoc(doc(this.firestore, 'meetings', meetingId), record);
  }

  async getAttendance(centerId: number, date: string): Promise<MeetingAttendance | null> {
    const snap = await getDoc(doc(this.firestore, 'meetings', `${centerId}_${date}`));
    return snap.exists() ? (snap.data() as MeetingAttendance) : null;
  }

  async getAttendanceHistory(centerId: number): Promise<MeetingAttendance[]> {
    const snap = await getDocs(query(collection(this.firestore, 'meetings'), where('centerId', '==', Number(centerId))));
    return snap.docs.map(d => d.data() as MeetingAttendance).sort((a, b) => b.date.localeCompare(a.date));
  }

  // ---------- KYC ডকুমেন্ট (পুরাতন সংস্করণ মোছা হয় না) ----------

  async uploadKycDocument(customerId: number, docType: DocumentVersion['docType'], file: File, actor: Actor): Promise<string> {
    if (!file.type.startsWith('image/') && file.type !== 'application/pdf') throw new Error('শুধু ছবি বা PDF আপলোড করা যাবে');
    if (file.size > 5 * 1024 * 1024) throw new Error('ফাইলের আকার সর্বোচ্চ ৫ MB');
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const path = `customers/${customerId}/${docType.toLowerCase()}_${Date.now()}.${ext}`;
    const fileRef = ref(this.storage, path);
    await uploadBytes(fileRef, file, { contentType: file.type });
    const url = await getDownloadURL(fileRef);

    const snap = await getDoc(this.runner.customerRef(customerId));
    const customer = snap.data() as Customer;
    const field = DOC_FIELD[docType];
    const fields = { [field]: url };
    const now = new Date().toISOString();
    const stamp = this.runner.audit.actorStamp(actor);
    const batch = writeBatch(this.firestore);
    const entry = this.runner.audit.buildHistoryEntry({ action: 'UPDATE', changedByUserId: actor.userId, changedByName: actor.name, changedByRole: actor.role, reason: `KYC ডকুমেন্ট আপলোড (${docType})`, previousData: customer as any, newData: fields });
    batch.update(this.runner.customerRef(customerId), { ...fields, history: this.runner.audit.appendHistory(customer.history, entry) });
    const version: DocumentVersion = { customerId, docType, storagePath: path, url, uploadedAt: now, actor: stamp };
    batch.set(doc(collection(this.firestore, 'documentVersions')), version);
    this.runner.audit.writeAuditLog(batch, { entityType: 'customers', entityId: customerId, action: 'UPDATE', reason: `KYC ডকুমেন্ট (${docType})`, changes: { [field]: { before: (customer as any)[field] ?? null, after: url } }, branchId: Number(customer.branchId), actor: stamp });
    await batch.commit();
    return url;
  }

  async getDocumentVersions(customerId: number): Promise<DocumentVersion[]> {
    const snap = await getDocs(query(collection(this.firestore, 'documentVersions'), where('customerId', '==', customerId)));
    return snap.docs.map(d => d.data() as DocumentVersion).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
  }
}
