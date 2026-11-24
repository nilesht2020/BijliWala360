/* ================================================================ admin dashboard work queue (AC-21) */

/**
 * Items waiting for an admin, in display order. The server returns only the items the caller has
 * the permission to act on, so the dashboard never reveals counts outside a user's role.
 */
export const WORK_QUEUE_KEYS = [
  'REGISTRATIONS_TO_VERIFY',
  'DOCUMENTS_TO_REVIEW',
  'WORKERS_TO_VERIFY',
  'IDENTITY_CONFLICTS',
  'OFFLINE_PAYMENTS_TO_VERIFY',
  'REFUNDS_TO_APPROVE',
  'COMPANIES_TO_ACTIVATE',
  'NEW_ENQUIRIES',
  'DRAFT_QUOTATIONS',
  'QUOTATIONS_AWAITING_CLIENT',
  'JOBS_TO_STAFF',
] as const;
export type WorkQueueKey = (typeof WORK_QUEUE_KEYS)[number];

export interface WorkQueueItem {
  key: WorkQueueKey;
  count: number;
  /** When the oldest waiting item entered the queue, if any are waiting. */
  oldestAt?: string;
}

export interface WorkQueueView {
  items: WorkQueueItem[];
  generatedAt: string;
}
