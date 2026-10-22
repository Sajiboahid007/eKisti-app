import { PaymentCollection, ReceiptType } from '../models/database.models';

/** পুরাতন রসিদে receiptType না থাকলে কিস্তি (বা অবলোপিত আদায়) ধরা হয় */
export function receiptTypeOf(r: Pick<PaymentCollection, 'receiptType' | 'isWriteOffRecovery'>): ReceiptType {
  return r.receiptType || (r.isWriteOffRecovery ? 'WRITE_OFF_RECOVERY' : 'KISTI');
}

export const RECEIPT_TYPE_LABELS: Record<ReceiptType, string> = {
  KISTI: 'কিস্তি আদায়',
  SAVINGS_DEPOSIT: 'সঞ্চয় জমা',
  FEE: 'ভর্তি / পাসবুক ফি',
  WRITE_OFF_RECOVERY: 'অবলোপিত ঋণ আদায়'
};

export interface FieldCashBreakdown {
  /** কিস্তির আসল + লাভ */
  kisti: number;
  /** কিস্তির সাথে সঞ্চয় + সরাসরি সঞ্চয় জমা */
  savings: number;
  fees: number;
  recovery: number;
  fine: number;
  total: number;
  /** নগদ — ক্যাশিয়ারকে গুনে বুঝিয়ে দিতে হবে */
  cash: number;
  /** বিকাশ / নগদ / ব্যাংক — TrxID যাচাই */
  digital: number;
  count: number;
  oldest: string | null;
  byType: Record<ReceiptType, number>;
}

/**
 * মাঠকর্মীর হাতে থাকা (ক্যাশিয়ারকে এখনো বুঝিয়ে না দেওয়া) টাকার বিভাজন।
 * বাতিল বা ইতোমধ্যে জমা রসিদ বাদ।
 */
export function fieldCashBreakdown(receipts: PaymentCollection[]): FieldCashBreakdown {
  const out: FieldCashBreakdown = {
    kisti: 0, savings: 0, fees: 0, recovery: 0, fine: 0, total: 0, cash: 0, digital: 0, count: 0, oldest: null,
    byType: { KISTI: 0, SAVINGS_DEPOSIT: 0, FEE: 0, WRITE_OFF_RECOVERY: 0 }
  };
  for (const r of receipts) {
    if (r.isDeleted || r.isReversed || r.isHandedOverToBranch) continue;
    const type = receiptTypeOf(r);
    const total = r.totalAmountCollected || 0;
    out.count++;
    out.total += total;
    out.byType[type] += total;
    if (r.paymentMethod === 'CASH') out.cash += total; else out.digital += total;
    if (!out.oldest || r.collectionDate < out.oldest) out.oldest = r.collectionDate;
    out.savings += r.savingsAmountCollected || 0;
    out.fine += r.fineAmountCollected || 0;
    if (type === 'FEE') out.fees += r.feeAmountCollected || total;
    else if (type === 'WRITE_OFF_RECOVERY') out.recovery += (r.principalAmountCollected || 0) + (r.profitAmountCollected || 0);
    else out.kisti += (r.principalAmountCollected || 0) + (r.profitAmountCollected || 0);
  }
  return out;
}
