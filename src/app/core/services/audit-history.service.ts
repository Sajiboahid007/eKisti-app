import { Injectable, inject } from '@angular/core';
import { Firestore, Transaction, WriteBatch, collection, doc, getDocs, query, where } from '@angular/fire/firestore';
import { EditHistoryEntry, AuditAction, AuditLog, ActorStamp } from '../models/database.models';

/** ডকুমেন্টের ভেতরে সর্বশেষ কতটি হিস্ট্রি রাখা হবে (পূর্ণ ইতিহাস auditLogs কালেকশনে) */
export const EMBEDDED_HISTORY_LIMIT = 30;

let lastHistoryId = 0;

/**
 * হিস্ট্রি আইডি — সময়ভিত্তিক অনন্য সংখ্যা।
 * আগে প্রতিটি লেখায় counters/history ডকুমেন্টে ট্রানজ্যাকশন হতো (Firestore-এ ~১ লেখা/সেকেন্ড সীমা),
 * যা মাঠে একসাথে আদায়ের সময় জট তৈরি করত। লগের আইডি ক্রমিক হওয়া জরুরি নয়।
 */
export function nextHistoryId(): number {
  const candidate = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  lastHistoryId = candidate > lastHistoryId ? candidate : lastHistoryId + 1;
  return lastHistoryId;
}

/** শুধু পরিবর্তিত ফিল্ডগুলোর আগে/পরে মান */
export function diffFields(before: Record<string, any> | undefined, after: Record<string, any>): Record<string, { before: any; after: any }> {
  const changes: Record<string, { before: any; after: any }> = {};
  for (const key of Object.keys(after)) {
    if (key === 'history') continue;
    const prev = before ? before[key] : undefined;
    if (JSON.stringify(prev) !== JSON.stringify(after[key])) {
      changes[key] = { before: prev === undefined ? null : prev, after: after[key] === undefined ? null : after[key] };
    }
  }
  return changes;
}

@Injectable({
  providedIn: 'root'
})
export class AuditHistoryService {
  private firestore = inject(Firestore);

  /**
   * Creates an audit history entry for tracking updates, edits, or deletes
   */
  async createHistoryEntry(params: {
    action: AuditAction;
    changedByUserId: number;
    changedByName: string;
    changedByRole: string;
    reason: string;
    previousData?: Record<string, any>;
    newData?: Record<string, any>;
  }): Promise<EditHistoryEntry> {
    return this.buildHistoryEntry(params);
  }

  /** সিঙ্ক্রোনাস সংস্করণ — ট্রানজ্যাকশনের ভেতরে ব্যবহারের জন্য */
  buildHistoryEntry(params: {
    action: AuditAction;
    changedByUserId: number;
    changedByName: string;
    changedByRole: string;
    reason: string;
    previousData?: Record<string, any>;
    newData?: Record<string, any>;
    timestamp?: string;
  }): EditHistoryEntry {
    // Clean previousData and newData to never recursively nest previous history arrays
    const cleanPrevious = params.previousData ? { ...params.previousData } : {};
    delete cleanPrevious['history'];
    const cleanNew = params.newData ? { ...params.newData } : {};
    delete cleanNew['history'];

    // আপডেটে পুরো ডকুমেন্টের বদলে শুধু পরিবর্তিত ফিল্ডের পূর্বের মান রাখা (ডকুমেন্ট সাইজ নিয়ন্ত্রণ)
    const previousData = params.previousData && params.newData && params.action !== 'DELETE'
      ? Object.fromEntries(Object.keys(cleanNew).filter(k => k in cleanPrevious).map(k => [k, cleanPrevious[k]]))
      : cleanPrevious;

    return {
      historyId: nextHistoryId(),
      action: params.action,
      timestamp: params.timestamp || new Date().toISOString(),
      changedByUserId: params.changedByUserId,
      changedByName: params.changedByName,
      changedByRole: params.changedByRole,
      reason: params.reason,
      previousData,
      newData: cleanNew
    };
  }

  /**
   * Helper to append a new history entry onto an existing entity's history array.
   * সর্বশেষ EMBEDDED_HISTORY_LIMIT টি রাখা হয়; পূর্ণ ইতিহাস auditLogs কালেকশনে থাকে।
   */
  appendHistory(existingHistory: EditHistoryEntry[] | undefined, newEntry: EditHistoryEntry): EditHistoryEntry[] {
    const historyList = existingHistory || [];
    return [...historyList, newEntry].slice(-EMBEDDED_HISTORY_LIMIT);
  }

  /** কেন্দ্রীয় অডিট লগ ডকুমেন্ট তৈরি (auto ID) — ট্রানজ্যাকশন/ব্যাচের সাথে একই কমিটে লেখা হয় */
  writeAuditLog(
    writer: Transaction | WriteBatch,
    log: Omit<AuditLog, 'auditId' | 'timestamp'> & { timestamp?: string }
  ): void {
    const ref = doc(collection(this.firestore, 'auditLogs'));
    const entry: AuditLog = {
      ...log,
      auditId: ref.id,
      timestamp: log.timestamp || new Date().toISOString()
    };
    (writer as any).set(ref, stripUndefined(entry));
  }

  /** একটি রেকর্ডের পূর্ণ অডিট ইতিহাস (নতুন থেকে পুরাতন) */
  async getAuditLogs(entityType: string, entityId: number | string): Promise<AuditLog[]> {
    try {
      const snap = await getDocs(query(
        collection(this.firestore, 'auditLogs'),
        where('entityType', '==', entityType),
        where('entityId', '==', entityId)
      ));
      const list: AuditLog[] = [];
      snap.forEach(d => list.push(d.data() as AuditLog));
      return list.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    } catch (err) {
      console.error('Error loading audit logs:', err);
      return [];
    }
  }

  actorStamp(user: { userId: number; name: string; role: string }): ActorStamp {
    return { userId: user.userId, name: user.name, role: user.role };
  }
}

/** Firestore undefined মান গ্রহণ করে না */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(v => stripUndefined(v)) as unknown as T;
  }
  // শুধু সাধারণ অবজেক্ট — Firestore FieldValue (increment ইত্যাদি) অক্ষত রাখা
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}
