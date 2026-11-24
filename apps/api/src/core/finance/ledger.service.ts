import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Model } from 'mongoose';
import type { LedgerBook } from '@bijliwala/contracts';
import { DomainError } from '../errors/domain-error';
import { LEDGER_MODEL, type LedgerAccount, type LedgerEntryDoc } from './finance.schemas';

export interface JournalLine {
  account: LedgerAccount;
  debitPaise?: number;
  creditPaise?: number;
}

export interface Journal {
  book: LedgerBook;
  refType: string;
  refId: string;
  narration: string;
  lines: JournalLine[];
  partyType?: string;
  partyId?: string;
  postedBy?: string;
  reversesJournalId?: string;
}

/** Pure check: every journal must balance and use non-negative integer paise (BR-FIN-05). */
export function assertBalanced(lines: JournalLine[]): void {
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    const d = l.debitPaise ?? 0;
    const c = l.creditPaise ?? 0;
    if (!Number.isSafeInteger(d) || !Number.isSafeInteger(c) || d < 0 || c < 0 || (d > 0 && c > 0)) {
      throw new DomainError(
        'LEDGER_UNBALANCED',
        'Each ledger line must be a non-negative integer debit or credit.',
      );
    }
    debit += d;
    credit += c;
  }
  if (lines.length < 2 || debit !== credit || debit === 0) {
    throw new DomainError(
      'LEDGER_UNBALANCED',
      `Journal does not balance (debit ${debit}, credit ${credit}).`,
    );
  }
}

/**
 * Append-only double-entry ledger (FR-BPAY-09, ARCHITECTURE §4.1). Journals are posted inside the
 * caller's transaction; corrections are reversing journals, never updates.
 */
@Injectable()
export class LedgerService {
  constructor(@InjectModel(LEDGER_MODEL) private readonly entries: Model<LedgerEntryDoc>) {}

  async post(journal: Journal, session: ClientSession): Promise<string> {
    const lines = journal.lines.filter((l) => (l.debitPaise ?? 0) > 0 || (l.creditPaise ?? 0) > 0);
    assertBalanced(lines);
    const journalId = randomUUID();
    const postedAt = new Date();
    await this.entries.insertMany(
      lines.map((l) => ({
        journalId,
        book: journal.book,
        account: l.account,
        debitPaise: l.debitPaise ?? 0,
        creditPaise: l.creditPaise ?? 0,
        currency: 'INR' as const,
        refType: journal.refType,
        refId: journal.refId,
        partyType: journal.partyType,
        partyId: journal.partyId,
        narration: journal.narration,
        postedAt,
        postedBy: journal.postedBy,
        reversesJournalId: journal.reversesJournalId,
      })),
      { session, ordered: true },
    );
    return journalId;
  }

  async forRef(refType: string, refId: string): Promise<LedgerEntryDoc[]> {
    return this.entries.find({ refType, refId }).sort({ postedAt: 1 }).lean<LedgerEntryDoc[]>().exec();
  }
}
