import { PaymentCollection } from '../models/database.models';
import { fieldCashBreakdown, receiptTypeOf } from './field-cash';

function receipt(over: Partial<PaymentCollection>): PaymentCollection {
  return {
    receiptId: 1, loanId: 1, customerId: 1, customerName: 'x', installmentNo: 1, branchId: 1, centerId: 1,
    collectedByUserId: 502, collectedByName: 'FO', principalAmountCollected: 0, profitAmountCollected: 0,
    savingsAmountCollected: 0, fineAmountCollected: 0, totalAmountCollected: 0, paymentMethod: 'CASH',
    collectionDate: '2026-10-22T04:00:00.000Z', isHandedOverToBranch: false,
    isDeleted: false, deletedAt: null, deletedByUserId: null, deleteReason: null, history: [], ...over
  };
}

describe('fieldCashBreakdown', () => {
  it('splits field cash by type and skips handed-over / reversed receipts', () => {
    const b = fieldCashBreakdown([
      receipt({ principalAmountCollected: 500, profitAmountCollected: 100, savingsAmountCollected: 50, totalAmountCollected: 650 }),
      receipt({ receiptType: 'SAVINGS_DEPOSIT', loanId: 0, savingsAmountCollected: 200, totalAmountCollected: 200 }),
      receipt({ receiptType: 'FEE', loanId: 0, feeAmountCollected: 70, totalAmountCollected: 70 }),
      receipt({ isWriteOffRecovery: true, principalAmountCollected: 300, totalAmountCollected: 300, paymentMethod: 'BKASH' }),
      receipt({ principalAmountCollected: 999, totalAmountCollected: 999, isHandedOverToBranch: true }),
      receipt({ principalAmountCollected: 999, totalAmountCollected: 999, isReversed: true })
    ]);
    expect(b.kisti).toBe(600);
    expect(b.savings).toBe(250);
    expect(b.fees).toBe(70);
    expect(b.recovery).toBe(300);
    expect(b.total).toBe(1220);
    expect(b.cash).toBe(920);
    expect(b.digital).toBe(300);
    expect(b.count).toBe(4);
  });

  it('treats legacy receipts without receiptType as kisti', () => {
    expect(receiptTypeOf({})).toBe('KISTI');
    expect(receiptTypeOf({ isWriteOffRecovery: true })).toBe('WRITE_OFF_RECOVERY');
  });
});
