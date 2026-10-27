import { Injectable, inject } from '@angular/core';
import {
  Firestore, collection, doc, getDoc, getDocs, query, where, writeBatch
} from '@angular/fire/firestore';
import { PasswordResetRequest, SmsLog, StaffCredential } from '../models/database.models';
import { AuditHistoryService } from './audit-history.service';

const PBKDF2_ITERATIONS = 100_000;
export const MIN_PASSWORD_LENGTH = 6;
const TEMP_PASSWORD_LENGTH = 8;
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

type Actor = { userId: number; name: string; role: string };

/** লগইনের সময় পাসওয়ার্ড যাচাইয়ের ফলাফল */
export interface PasswordCheck {
  /** NO_PASSWORD = এখনো নির্ধারিত হয়নি (আগের ডেমো লগইন চলবে) */
  status: 'OK' | 'WRONG' | 'NO_PASSWORD';
  mustChangePassword: boolean;
}

/** রিসেট অনুরোধ পাঠানো কর্মী */
export interface ResetRequester {
  userId: number;
  name: string;
  email: string;
  phone: string;
  branchId: number;
}

/**
 * কর্মীর লগইন পাসওয়ার্ড (`staffCredentials/{userId}`)।
 * পাসওয়ার্ড কখনো সরাসরি সংরক্ষিত হয় না — শুধু লবণযুক্ত PBKDF2-SHA256 হ্যাশ।
 * যে কর্মীর এখনো পাসওয়ার্ড নির্ধারিত হয়নি, তার লগইন আগের মতো (ডেমো) চলে।
 *
 * পাসওয়ার্ড ভুলে গেলে: কর্মী লগইন পাতা থেকে অনুরোধ পাঠান (`passwordResetRequests`) →
 * অ্যাডমিন অস্থায়ী পাসওয়ার্ড দেন (`adminSetPassword`) → পরের লগইনে কর্মী নতুন পাসওয়ার্ড দিতে বাধ্য।
 * SMS গেটওয়ে এখনো নেই, তাই অস্থায়ী পাসওয়ার্ড শুধু অ্যাডমিনকে দেখানো হয়; `smsLogs`-এ শুধু "পাসওয়ার্ড পরিবর্তিত" বার্তা সারিবদ্ধ হয় (পাসওয়ার্ড নয়)।
 */
@Injectable({ providedIn: 'root' })
export class StaffCredentialService {
  private firestore = inject(Firestore);
  private audit = inject(AuditHistoryService);

  async hasPassword(userId: number): Promise<boolean> {
    return (await this.read(userId)) !== null;
  }

  async check(userId: number, password: string): Promise<PasswordCheck> {
    const cred = await this.read(userId);
    if (!cred) return { status: 'NO_PASSWORD', mustChangePassword: false };
    const hash = await hashPassword(password, fromBase64(cred.salt), cred.iterations);
    return { status: hash === cred.passwordHash ? 'OK' : 'WRONG', mustChangePassword: !!cred.mustChangePassword };
  }

  /** পাসওয়ার্ড নির্ধারিত না থাকলে `null` */
  async verify(userId: number, password: string): Promise<boolean | null> {
    const result = await this.check(userId, password);
    return result.status === 'NO_PASSWORD' ? null : result.status === 'OK';
  }

  /**
   * নতুন পাসওয়ার্ড সংরক্ষণ। নিজের পাসওয়ার্ড বদলাতে `currentPassword` আবশ্যক
   * (আগে নির্ধারিত থাকলে)। অ্যাডমিন নতুন কর্মী তৈরির সময় `currentPassword` ছাড়াই দেন।
   * নিজে বদলালে `mustChangePassword` মুছে যায়।
   */
  async setPassword(
    userId: number,
    newPassword: string,
    actor: Actor,
    reason: string,
    currentPassword?: string
  ): Promise<void> {
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`পাসওয়ার্ড কমপক্ষে ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে`);
    }
    if (currentPassword !== undefined && (await this.verify(userId, currentPassword)) === false) {
      throw new Error('বর্তমান পাসওয়ার্ড সঠিক নয়');
    }
    const batch = writeBatch(this.firestore);
    await this.writeCredential(batch, userId, newPassword, actor, reason, false);
    await batch.commit();
  }

  /**
   * সুপার অ্যাডমিন / অ্যাডমিন কর্তৃক যেকোনো কর্মীর পাসওয়ার্ড পরিবর্তন বা রিসেট।
   * `newPassword` না দিলে অস্থায়ী পাসওয়ার্ড তৈরি হয়। `mustChange` হলে কর্মী পরের লগইনে নতুন পাসওয়ার্ড দিতে বাধ্য।
   * ওই কর্মীর অপেক্ষমাণ "পাসওয়ার্ড ভুলে গেছেন" অনুরোধ নিষ্পত্তি হয় এবং SMS সারিবদ্ধ হয়।
   * যে পাসওয়ার্ড সংরক্ষিত হলো তা ফেরত দেয় — অ্যাডমিন কর্মীকে জানান।
   */
  async adminSetPassword(
    staff: ResetRequester,
    actor: Actor,
    options: { newPassword?: string; mustChange?: boolean } = {}
  ): Promise<string> {
    if (!ADMIN_ROLES.includes(actor.role)) {
      throw new Error('শুধু সুপার অ্যাডমিন ও অ্যাডমিন অন্য কর্মীর পাসওয়ার্ড পরিবর্তন করতে পারেন');
    }
    const password = options.newPassword ?? generateTempPassword();
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`পাসওয়ার্ড কমপক্ষে ${MIN_PASSWORD_LENGTH} অক্ষরের হতে হবে`);
    }
    const mustChange = options.mustChange ?? true;
    const now = new Date().toISOString();
    const pending = await this.pendingRequestsFor(staff.userId);

    const batch = writeBatch(this.firestore);
    await this.writeCredential(batch, staff.userId, password, actor,
      options.newPassword
        ? `অ্যাডমিন কর্তৃক পাসওয়ার্ড পরিবর্তন (${actor.name})`
        : `অ্যাডমিন কর্তৃক অস্থায়ী পাসওয়ার্ড রিসেট (${actor.name})`,
      mustChange);
    for (const r of pending) {
      batch.update(doc(this.firestore, 'passwordResetRequests', r.requestId!), {
        status: 'RESOLVED', resolvedAt: now, resolvedByUserId: actor.userId, resolvedByName: actor.name
      });
    }
    if (staff.phone) {
      const sms: SmsLog = {
        to: staff.phone, type: 'PASSWORD_RESET', relatedId: staff.userId, branchId: Number(staff.branchId) || 0,
        status: 'QUEUED', createdAt: now,
        // smsLogs সব কর্মী পড়তে পারেন — তাই পাসওয়ার্ড নিজে বার্তায় রাখা হয় না, অ্যাডমিন সরাসরি জানান
        message: `eKisti: আপনার লগইন পাসওয়ার্ড অ্যাডমিন (${actor.name}) পরিবর্তন করেছেন। নতুন পাসওয়ার্ড অ্যাডমিনের কাছ থেকে জেনে নিন।`
      };
      batch.set(doc(collection(this.firestore, 'smsLogs')), sms);
    }
    await batch.commit();
    return password;
  }

  /** লগইন পাতা থেকে "পাসওয়ার্ড ভুলে গেছেন" অনুরোধ; আগে থেকে অপেক্ষমাণ থাকলে নতুন অনুরোধ হয় না */
  async requestReset(staff: ResetRequester): Promise<'CREATED' | 'ALREADY_PENDING'> {
    if ((await this.pendingRequestsFor(staff.userId)).length > 0) return 'ALREADY_PENDING';
    const ref = doc(collection(this.firestore, 'passwordResetRequests'));
    const request: PasswordResetRequest = {
      requestId: ref.id, userId: staff.userId, name: staff.name, email: staff.email || '', phone: staff.phone || '',
      branchId: Number(staff.branchId) || 0, status: 'PENDING', requestedAt: new Date().toISOString()
    };
    const batch = writeBatch(this.firestore);
    batch.set(ref, request);
    await batch.commit();
    return 'CREATED';
  }

  async getPendingRequests(): Promise<PasswordResetRequest[]> {
    const snap = await getDocs(query(collection(this.firestore, 'passwordResetRequests'), where('status', '==', 'PENDING')));
    return snap.docs
      .map(d => ({ ...(d.data() as PasswordResetRequest), requestId: d.id }))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  async rejectRequest(requestId: string, actor: Actor): Promise<void> {
    const batch = writeBatch(this.firestore);
    batch.update(doc(this.firestore, 'passwordResetRequests', requestId), {
      status: 'REJECTED', resolvedAt: new Date().toISOString(), resolvedByUserId: actor.userId, resolvedByName: actor.name
    });
    await batch.commit();
  }

  private async pendingRequestsFor(userId: number): Promise<PasswordResetRequest[]> {
    const snap = await getDocs(query(collection(this.firestore, 'passwordResetRequests'),
      where('userId', '==', userId), where('status', '==', 'PENDING')));
    return snap.docs.map(d => ({ ...(d.data() as PasswordResetRequest), requestId: d.id }));
  }

  private async writeCredential(
    batch: ReturnType<typeof writeBatch>, userId: number, password: string, actor: Actor, reason: string, mustChange: boolean
  ): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const cred: StaffCredential = {
      userId,
      passwordHash: await hashPassword(password, salt, PBKDF2_ITERATIONS),
      salt: toBase64(salt),
      iterations: PBKDF2_ITERATIONS,
      updatedAt: new Date().toISOString(),
      updatedByUserId: actor.userId,
      mustChangePassword: mustChange
    };
    batch.set(doc(this.firestore, 'staffCredentials', userId.toString()), cred);
    // হ্যাশ নয়, শুধু "পরিবর্তিত হয়েছে" লগ হয়
    this.audit.writeAuditLog(batch, {
      entityType: 'staff', entityId: userId, action: 'UPDATE', reason,
      changes: { password: { before: '••••••', after: '••••••' } },
      actor: this.audit.actorStamp(actor)
    });
  }

  private async read(userId: number): Promise<StaffCredential | null> {
    const snap = await getDoc(doc(this.firestore, 'staffCredentials', userId.toString()));
    return snap.exists() ? (snap.data() as StaffCredential) : null;
  }
}

/** বিভ্রান্তিকর অক্ষর (0/O, 1/l/I) বাদ দিয়ে অস্থায়ী পাসওয়ার্ড */
function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(TEMP_PASSWORD_LENGTH));
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

async function hashPassword(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return toBase64(new Uint8Array(bits));
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), c => c.charCodeAt(0));
}
