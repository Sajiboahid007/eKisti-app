import { Injectable, inject } from '@angular/core';
import { CounterService } from './counter.service';
import { EditHistoryEntry, AuditAction } from '../models/database.models';

@Injectable({
  providedIn: 'root'
})
export class AuditHistoryService {
  private counterService = inject(CounterService);

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
    const historyId = await this.counterService.getNextIntegerId('history');

    // Clean previousData and newData to never recursively nest previous history arrays
    const cleanPrevious = params.previousData ? { ...params.previousData } : {};
    delete cleanPrevious['history'];
    const cleanNew = params.newData ? { ...params.newData } : {};
    delete cleanNew['history'];

    return {
      historyId,
      action: params.action,
      timestamp: new Date().toISOString(),
      changedByUserId: params.changedByUserId,
      changedByName: params.changedByName,
      changedByRole: params.changedByRole,
      reason: params.reason,
      previousData: cleanPrevious,
      newData: cleanNew
    };
  }

  /**
   * Helper to append a new history entry onto an existing entity's history array
   */
  appendHistory(existingHistory: EditHistoryEntry[] | undefined, newEntry: EditHistoryEntry): EditHistoryEntry[] {
    const historyList = existingHistory || [];
    return [...historyList, newEntry];
  }
}
