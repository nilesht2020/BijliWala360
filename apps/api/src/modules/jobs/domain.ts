import { Types } from 'mongoose';
import {
  canTransitionJob,
  type BillUnit,
  type JobImpact,
  type JobPositionInput,
  type JobStatus,
  type Shift,
} from '@skillconnect/contracts';
import { DomainError } from '../../core/errors/domain-error';

/** Embedded position (DATABASE §9 `jobs.positions`). `available = required - held - confirmed`. */
export interface PositionDoc {
  _id: Types.ObjectId;
  skillId: Types.ObjectId;
  title: string;
  minExperienceYears: number;
  requiredCertDocTypeCodes: string[];
  shift: Shift;
  required: number;
  held: number;
  confirmed: number;
  available: number;
  billRatePaise: number;
  billUnit: BillUnit;
  payRatePaise?: number;
  showPayRate: boolean;
  allowPartialAvailability: boolean;
}

type ParsedPosition = Omit<
  JobPositionInput,
  'minExperienceYears' | 'requiredCertDocTypeCodes' | 'showPayRate' | 'allowPartialAvailability'
> & {
  minExperienceYears: number;
  requiredCertDocTypeCodes: string[];
  showPayRate: boolean;
  allowPartialAvailability: boolean;
};

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransitionJob(from, to))
    throw new DomainError(
      'INVALID_STATE_TRANSITION',
      `A job that is ${from.toLowerCase().replace(/_/g, ' ')} cannot become ${to.toLowerCase().replace(/_/g, ' ')}.`,
    );
}

/** The status a job on hold returns to: the one it was put on hold from. */
export function resumeTargetOf(history: Array<{ from: string; to: string }>): JobStatus {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const h = history[i];
    if (h?.to === 'ON_HOLD') return h.from as JobStatus;
  }
  return 'OPEN';
}

export function newPosition(p: ParsedPosition): PositionDoc {
  return {
    _id: new Types.ObjectId(),
    skillId: new Types.ObjectId(p.skillId),
    title: p.title,
    minExperienceYears: p.minExperienceYears,
    requiredCertDocTypeCodes: p.requiredCertDocTypeCodes,
    shift: p.shift,
    required: p.required,
    held: 0,
    confirmed: 0,
    available: p.required,
    billRatePaise: p.billRatePaise,
    billUnit: p.billUnit,
    ...(p.payRatePaise !== undefined ? { payRatePaise: p.payRatePaise } : {}),
    showPayRate: p.showPayRate,
    allowPartialAvailability: p.allowPartialAvailability,
  };
}

const committed = (p: PositionDoc) => p.held + p.confirmed;

/**
 * Applies an edit of positions and/or schedule (FR-JOB-04/05). Never lets `required` drop below
 * the places already held or confirmed, never removes or re-skills a position with commitments,
 * and reports what existing allocations are affected so that Phase 5 flows can follow up.
 */
export function planJobEdit(
  existing: PositionDoc[],
  input: ParsedPosition[] | undefined,
  scheduleChanged: boolean,
): { positions: PositionDoc[]; impact: JobImpact[] } {
  const impact: JobImpact[] = [];
  let positions = existing;

  if (input) {
    const byId = new Map(existing.map((p) => [p._id.toHexString(), p]));
    const kept = new Set<string>();
    positions = input.map((p) => {
      if (!p.id) return newPosition(p);
      const old = byId.get(p.id);
      if (!old)
        throw new DomainError('VALIDATION_FAILED', 'A position does not belong to this job.', [
          { path: 'positions', message: `Unknown position ${p.id}` },
        ]);
      if (kept.has(p.id))
        throw new DomainError('VALIDATION_FAILED', 'A position appears twice.', [{ path: 'positions' }]);
      kept.add(p.id);
      const used = committed(old);
      if (p.required < used)
        throw new DomainError(
          'JOB_HEADCOUNT_BELOW_COMMITTED',
          `"${old.title}" already has ${used} place(s) held or confirmed; the headcount cannot go below that.`,
          [{ positionId: p.id, committed: used }],
        );
      if (used > 0 && p.skillId !== old.skillId.toHexString())
        throw new DomainError(
          'POSITION_HAS_COMMITMENTS',
          `"${old.title}" has allocations, so its skill cannot change. Add a new position instead.`,
          [{ positionId: p.id }],
        );
      if (used > 0 && (p.shift.startMin !== old.shift.startMin || p.shift.endMin !== old.shift.endMin))
        impact.push({
          positionId: p.id,
          kind: 'SHIFT_CHANGED',
          affected: used,
          message: `The shift of "${old.title}" changed; ${used} allocated provider(s) must re-confirm.`,
        });
      if (used > 0 && p.required < old.required)
        impact.push({
          positionId: p.id,
          kind: 'HEADCOUNT_REDUCED',
          affected: used,
          message: `"${old.title}" headcount reduced from ${old.required} to ${p.required}.`,
        });
      return {
        ...old,
        skillId: new Types.ObjectId(p.skillId),
        title: p.title,
        minExperienceYears: p.minExperienceYears,
        requiredCertDocTypeCodes: p.requiredCertDocTypeCodes,
        shift: p.shift,
        required: p.required,
        available: p.required - used,
        billRatePaise: p.billRatePaise,
        billUnit: p.billUnit,
        ...(p.payRatePaise !== undefined ? { payRatePaise: p.payRatePaise } : {}),
        showPayRate: p.showPayRate,
        allowPartialAvailability: p.allowPartialAvailability,
      };
    });
    for (const old of existing) {
      if (!kept.has(old._id.toHexString()) && committed(old) > 0)
        throw new DomainError(
          'POSITION_HAS_COMMITMENTS',
          `"${old.title}" has allocations and cannot be removed.`,
          [{ positionId: old._id.toHexString() }],
        );
    }
  }

  if (scheduleChanged)
    for (const p of positions)
      if (committed(p) > 0)
        impact.push({
          positionId: p._id.toHexString(),
          kind: 'SCHEDULE_CHANGED',
          affected: committed(p),
          message: `The schedule changed; ${committed(p)} allocation(s) on "${p.title}" need re-validation.`,
        });

  return { positions, impact };
}

/** Staffed jobs whose headcount changed move between PARTIALLY_STAFFED and STAFFED. */
export function staffingStatusAfterEdit(current: JobStatus, positions: PositionDoc[]): JobStatus {
  if (current !== 'STAFFED' && current !== 'PARTIALLY_STAFFED') return current;
  return positions.every((p) => p.confirmed >= p.required) ? 'STAFFED' : 'PARTIALLY_STAFFED';
}
