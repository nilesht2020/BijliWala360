import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type FilterQuery, type Model } from 'mongoose';
import type {
  ChecklistInput,
  PageMeta,
  ProviderStatus,
  ProviderType,
  ReadinessView,
  RegistrationDetailView,
  RegistrationView,
  VerificationState,
} from '@bijliwala/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { vendorIdsOf } from '../../core/auth/guards';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { DocumentsService } from '../documents/documents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PersonsService } from '../persons/persons.module';
import { PlansService, snapshotOf } from '../plans/plans.module';
import {
  professionalGaps,
  ProfessionalsService,
  type ProfessionalDoc,
} from '../professionals/professionals.module';
import { RolesService } from '../users/roles.service';
import { UsersService } from '../users/users.service';
import { vendorGaps, VendorsService, type VendorDoc } from '../vendors/vendors.module';
import { REGISTRATION_MODEL, type RegistrationDoc } from './schemas';

export type ProviderRef = { type: 'PROFESSIONAL'; doc: ProfessionalDoc } | { type: 'VENDOR'; doc: VendorDoc };

/**
 * Uniform access to the two provider kinds (individual professionals and vendors) so the
 * registration workflow is written once (SRS §4.6).
 */
@Injectable()
export class ProviderDirectory {
  constructor(
    private readonly professionals: ProfessionalsService,
    private readonly vendors: VendorsService,
    private readonly roles: RolesService,
  ) {}

  async mine(user: AuthUser): Promise<ProviderRef> {
    if (user.userType === 'PROFESSIONAL')
      return { type: 'PROFESSIONAL', doc: await this.professionals.getMine(user) };
    if (user.userType === 'VENDOR') return { type: 'VENDOR', doc: await this.vendors.getMine(user) };
    throw new DomainError('FORBIDDEN', 'Only service providers have a registration.');
  }

  async byId(type: ProviderType, id: Types.ObjectId, session?: ClientSession): Promise<ProviderRef> {
    return type === 'PROFESSIONAL'
      ? { type, doc: await this.professionals.getById(id.toHexString(), session) }
      : { type, doc: await this.vendors.getById(id.toHexString(), session) };
  }

  name(p: ProviderRef): string {
    return p.type === 'PROFESSIONAL' ? p.doc.fullName : p.doc.legalName;
  }

  async transition(
    p: { type: ProviderType; id: Types.ObjectId },
    from: ProviderStatus[],
    to: ProviderStatus,
    session: ClientSession,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (p.type === 'PROFESSIONAL') await this.professionals.transition(p.id, from, to, session, extra);
    else await this.vendors.transition(p.id, from, to, session, extra);
  }

  /** Users to notify about a provider's registration. */
  async recipients(
    p: { type: ProviderType; id: Types.ObjectId },
    session?: ClientSession,
  ): Promise<string[]> {
    if (p.type === 'PROFESSIONAL')
      return [(await this.professionals.getById(p.id.toHexString(), session)).userId.toHexString()];
    return this.roles.userIdsInScope('VENDOR_ADMIN', { vendorId: p.id.toHexString() });
  }

  async view(p: ProviderRef): Promise<RegistrationDetailView['provider']> {
    return p.type === 'PROFESSIONAL' ? this.professionals.toView(p.doc) : this.vendors.toView(p.doc);
  }
}

export function toRegistrationView(r: RegistrationDoc, providerStatus: ProviderStatus): RegistrationView {
  return {
    id: r._id.toHexString(),
    providerType: r.providerType,
    providerId: r.providerId.toHexString(),
    providerName: r.providerName,
    providerStatus,
    ...(r.planSnapshot ? { plan: r.planSnapshot } : {}),
    payment: {
      status: r.payment.status,
      totalPaise: r.payment.totalPaise,
      paidPaise: r.payment.paidPaise,
      refundedPaise: r.payment.refundedPaise,
      ...(r.payment.waiver
        ? { waiver: { reason: r.payment.waiver.reason, at: r.payment.waiver.at.toISOString() } }
        : {}),
    },
    verification: {
      status: r.verification.status,
      ...(r.verification.submittedAt ? { submittedAt: r.verification.submittedAt.toISOString() } : {}),
      checklist: r.verification.checklist,
      decisions: r.verification.decisions.map((d) => ({
        decision: d.decision,
        by: d.by,
        at: d.at.toISOString(),
        ...(d.reason ? { reason: d.reason } : {}),
      })),
      ...(r.verification.changesRequested ? { changesRequested: r.verification.changesRequested } : {}),
    },
    createdAt: r.createdAt.toISOString(),
  };
}

/** Hooks implemented by the payments service; injected lazily to avoid a constructor cycle. */
export interface RegistrationPaymentHooks {
  createRejectionRefund(
    reg: RegistrationDoc,
    reason: string,
    actorId: string,
    session: ClientSession,
  ): Promise<void>;
}

/**
 * Provider registration workflow (SRS §4.6): plan selection -> submission (profile + documents
 * complete) -> payment -> verification decision. Provider lifecycle changes are applied through
 * conditional transitions inside transactions.
 */
@Injectable()
export class RegistrationsService {
  paymentHooks?: RegistrationPaymentHooks;

  constructor(
    @InjectModel(REGISTRATION_MODEL) private readonly registrations: Model<RegistrationDoc>,
    readonly providers: ProviderDirectory,
    private readonly professionals: ProfessionalsService,
    private readonly vendors: VendorsService,
    private readonly plans: PlansService,
    private readonly documents: DocumentsService,
    private readonly persons: PersonsService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  async ensure(p: ProviderRef, session?: ClientSession): Promise<RegistrationDoc> {
    const doc = await this.registrations
      .findOneAndUpdate(
        { providerType: p.type, providerId: p.doc._id },
        {
          $setOnInsert: { providerType: p.type, providerId: p.doc._id },
          $set: { providerName: this.providers.name(p) },
        },
        { upsert: true, new: true, session },
      )
      .lean<RegistrationDoc>()
      .exec();
    return doc as RegistrationDoc;
  }

  async getById(id: string | Types.ObjectId, session?: ClientSession): Promise<RegistrationDoc> {
    const reg = Types.ObjectId.isValid(id)
      ? await this.registrations.findById(id, undefined, { session }).lean<RegistrationDoc>().exec()
      : null;
    if (!reg) throw new NotFoundError('Registration', String(id));
    return reg;
  }

  async view(reg: RegistrationDoc): Promise<RegistrationView> {
    const p = await this.providers.byId(reg.providerType, reg.providerId);
    return toRegistrationView(reg, p.doc.status);
  }

  async getMine(user: AuthUser): Promise<RegistrationView> {
    const p = await this.providers.mine(user);
    return toRegistrationView(await this.ensure(p), p.doc.status);
  }

  /* ------------------------------------------------------------------ plan & readiness */

  async selectPlan(user: AuthUser, planCode: string, ctx: AuditContext): Promise<RegistrationView> {
    const p = await this.providers.mine(user);
    if (!['DRAFT', 'PENDING_PAYMENT', 'CHANGES_REQUESTED'].includes(p.doc.status)) {
      throw new DomainError('PROVIDER_TYPE_LOCKED', 'Your plan can no longer be changed.');
    }
    const plan = await this.plans.activeByCode(planCode, p.type);
    const snapshot = snapshotOf(plan);
    const reg = await this.txn.run(async (session) => {
      const current = await this.ensure(p, session);
      if (current.payment.status !== 'UNPAID')
        throw new DomainError(
          'REGISTRATION_ALREADY_PAID',
          'You have already paid; the plan cannot be changed.',
        );
      const updated = await this.registrations
        .findOneAndUpdate(
          { _id: current._id, 'payment.status': 'UNPAID' },
          {
            $set: { planSnapshot: snapshot, 'payment.totalPaise': snapshot.totalPaise },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<RegistrationDoc>()
        .exec();
      if (!updated)
        throw new DomainError(
          'REGISTRATION_ALREADY_PAID',
          'You have already paid; the plan cannot be changed.',
        );
      if (p.type === 'VENDOR') await this.vendors.setWorkerCap(p.doc._id, snapshot.maxWorkers, session);
      return updated;
    });
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'registration.plan_selected',
      entityType: 'ProviderRegistration',
      entityId: reg._id.toHexString(),
      after: { planCode },
      context: ctx,
    });
    return toRegistrationView(reg, p.doc.status);
  }

  private async requiredDocTypes(p: ProviderRef, reg: RegistrationDoc): Promise<string[]> {
    const fromPlan = reg.planSnapshot?.mandatoryDocTypeCodes ?? [];
    const fromSkills = p.type === 'PROFESSIONAL' ? await this.professionals.skillDocTypes(p.doc) : [];
    return [...new Set([...fromPlan, ...fromSkills])];
  }

  async readiness(p: ProviderRef, reg: RegistrationDoc): Promise<ReadinessView> {
    const required = await this.requiredDocTypes(p, reg);
    const missingCodes = await this.documents.missingTypes(p.type, p.doc._id.toHexString(), required);
    const types = new Map((await this.documents.listTypes(true)).map((t) => [t.code, t.name]));
    const missingProfile =
      p.type === 'PROFESSIONAL'
        ? professionalGaps(p.doc)
        : vendorGaps(p.doc, reg.planSnapshot?.gstinRequired ?? false);
    return {
      planSelected: !!reg.planSnapshot,
      missingProfile,
      missingDocuments: missingCodes.map((code) => ({ code, name: types.get(code) ?? code })),
      requiredDocuments: required.map((code) => ({ code, name: types.get(code) ?? code })),
      canSubmit: !!reg.planSnapshot && missingProfile.length === 0 && missingCodes.length === 0,
    };
  }

  async myReadiness(user: AuthUser): Promise<ReadinessView> {
    const p = await this.providers.mine(user);
    return this.readiness(p, await this.ensure(p));
  }

  /* ------------------------------------------------------------------ submission */

  /**
   * Submits for verification. Professionals claim their person identity here (BR-PRV-01). If the
   * fee is not yet paid the provider waits in PENDING_PAYMENT and enters the queue on payment.
   */
  async submit(user: AuthUser, ctx: AuditContext): Promise<RegistrationView> {
    const p = await this.providers.mine(user);
    const reg = await this.ensure(p);
    if (!['DRAFT', 'CHANGES_REQUESTED', 'PENDING_PAYMENT'].includes(p.doc.status)) {
      throw new DomainError('INVALID_STATE_TRANSITION', 'Your registration has already been submitted.');
    }
    const ready = await this.readiness(p, reg);
    if (!ready.planSelected)
      throw new DomainError('REGISTRATION_PLAN_REQUIRED', 'Choose a registration plan first.');
    if (ready.missingProfile.length) {
      throw new DomainError(
        'PROFILE_INCOMPLETE',
        'Complete your profile before submitting.',
        ready.missingProfile.map((m) => ({ field: m })),
      );
    }
    if (ready.missingDocuments.length) {
      throw new DomainError(
        'DOCUMENTS_MISSING',
        'Upload all required documents before submitting.',
        ready.missingDocuments.map((d) => ({ field: d.code, message: d.name })),
      );
    }
    const paid = reg.payment.status === 'PAID' || reg.payment.status === 'WAIVED';
    const account = await this.users.getById(user.id);
    try {
      const updated = await this.txn.run(async (session) => {
        if (p.type === 'PROFESSIONAL') {
          const identity = p.doc.identity;
          if (!identity) throw new DomainError('PROFILE_INCOMPLETE', 'Add your government ID.');
          const person = await this.persons.claim(
            {
              fullName: p.doc.fullName,
              idType: identity.idType,
              idHash: identity.idHash,
              idLast4: identity.idLast4,
              ...(account.mobile ? { mobile: account.mobile } : {}),
              role: { type: 'PROFESSIONAL', refId: p.doc._id.toHexString() },
            },
            session,
          );
          await this.professionals.linkPerson(p.doc._id, person._id, session);
        }
        await this.providers.transition(
          { type: p.type, id: p.doc._id },
          ['DRAFT', 'CHANGES_REQUESTED', 'PENDING_PAYMENT'],
          paid ? 'PENDING_VERIFICATION' : 'PENDING_PAYMENT',
          session,
        );
        const doc = await this.registrations
          .findOneAndUpdate(
            { _id: reg._id },
            {
              $set: {
                'verification.status': paid ? 'PENDING' : 'NOT_SUBMITTED',
                'verification.submittedAt': new Date(),
              },
              $unset: { 'verification.changesRequested': 1 },
              $inc: { version: 1 },
            },
            { new: true, session },
          )
          .lean<RegistrationDoc>()
          .exec();
        await this.audit.record(
          {
            actor: actorFromUser(user),
            action: 'registration.submit',
            entityType: 'ProviderRegistration',
            entityId: reg._id.toHexString(),
            after: { paid },
            context: ctx,
          },
          session,
        );
        return doc as RegistrationDoc;
      });
      return this.view(updated);
    } catch (err) {
      if (p.type === 'PROFESSIONAL') {
        await this.persons
          .recordConflict(err, { type: 'PROFESSIONAL', refId: p.doc._id.toHexString(), name: p.doc.fullName })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  /** Called by the payments service when the fee is settled (paid or waived), inside its transaction. */
  async onFeeSettled(
    regId: Types.ObjectId,
    state: 'PAID' | 'WAIVED',
    amountPaise: number,
    session: ClientSession,
    waiver?: { by: string; reason: string },
  ): Promise<void> {
    const reg = await this.registrations
      .findOneAndUpdate(
        { _id: regId },
        {
          $set: {
            'payment.status': state,
            ...(waiver ? { 'payment.waiver': { ...waiver, at: new Date() } } : {}),
          },
          $inc: { 'payment.paidPaise': amountPaise, version: 1 },
        },
        { new: true, session },
      )
      .lean<RegistrationDoc>()
      .exec();
    if (!reg) return;
    const p = await this.providers.byId(reg.providerType, reg.providerId, session);
    if (reg.verification.submittedAt && p.doc.status === 'PENDING_PAYMENT') {
      await this.providers.transition(
        { type: reg.providerType, id: reg.providerId },
        ['PENDING_PAYMENT'],
        'PENDING_VERIFICATION',
        session,
      );
      await this.registrations.updateOne(
        { _id: reg._id },
        { $set: { 'verification.status': 'PENDING' } },
        { session },
      );
    }
  }

  async setPaymentState(
    regId: Types.ObjectId,
    state: RegistrationDoc['payment']['status'],
    session: ClientSession,
    incRefunded = 0,
  ): Promise<void> {
    await this.registrations.updateOne(
      { _id: regId },
      { $set: { 'payment.status': state }, $inc: { 'payment.refundedPaise': incRefunded, version: 1 } },
      { session },
    );
  }

  /* ------------------------------------------------------------------ admin: queue & decisions */

  async list(q: {
    page: number;
    pageSize: number;
    verificationStatus?: VerificationState;
    providerType?: ProviderType;
    paymentStatus?: RegistrationDoc['payment']['status'];
  }): Promise<{ items: RegistrationView[]; meta: PageMeta }> {
    const filter: FilterQuery<RegistrationDoc> = {};
    if (q.verificationStatus) filter['verification.status'] = q.verificationStatus;
    if (q.providerType) filter.providerType = q.providerType;
    if (q.paymentStatus) filter['payment.status'] = q.paymentStatus;
    const [docs, total] = await Promise.all([
      this.registrations
        .find(filter)
        .sort({ 'verification.submittedAt': 1, createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<RegistrationDoc[]>()
        .exec(),
      this.registrations.countDocuments(filter),
    ]);
    return {
      items: await Promise.all(docs.map((d) => this.view(d))),
      meta: { page: q.page, pageSize: q.pageSize, total },
    };
  }

  async requiredDocTypesFor(reg: RegistrationDoc): Promise<string[]> {
    return this.requiredDocTypes(await this.providers.byId(reg.providerType, reg.providerId), reg);
  }

  async saveChecklist(
    id: string,
    input: ChecklistInput,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationView> {
    const reg = await this.getById(id);
    const doc = await this.registrations
      .findByIdAndUpdate(
        reg._id,
        { $set: { 'verification.checklist': input.items }, $inc: { version: 1 } },
        { new: true },
      )
      .lean<RegistrationDoc>()
      .exec();
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'registration.checklist',
      entityType: 'ProviderRegistration',
      entityId: id,
      after: input,
      context: ctx,
    });
    return this.view(doc as RegistrationDoc);
  }

  private async decide(
    id: string,
    decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED',
    reason: string | undefined,
    user: AuthUser,
    ctx: AuditContext,
    work: (reg: RegistrationDoc, session: ClientSession) => Promise<void>,
  ): Promise<RegistrationView> {
    const reg = await this.getById(id);
    if (reg.verification.status !== 'PENDING')
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        'Only registrations waiting for verification can be decided.',
      );
    const updated = await this.txn.run(async (session) => {
      const claimed = await this.registrations
        .findOneAndUpdate(
          { _id: reg._id, 'verification.status': 'PENDING', version: reg.version },
          {
            $set: { 'verification.status': decision },
            $push: {
              'verification.decisions': {
                decision,
                by: user.id,
                at: new Date(),
                ...(reason ? { reason } : {}),
                checklistSnapshot: reg.verification.checklist,
              },
            },
            $inc: { version: 1 },
          },
          { new: true, session },
        )
        .lean<RegistrationDoc>()
        .exec();
      if (!claimed)
        throw new DomainError('STATE_CONFLICT', 'Someone else decided this registration at the same time.');
      await work(claimed, session);
      const event = {
        APPROVED: 'registration.approved',
        REJECTED: 'registration.rejected',
        CHANGES_REQUESTED: 'registration.changes_requested',
      }[decision];
      const recipients = await this.providers.recipients(
        { type: reg.providerType, id: reg.providerId },
        session,
      );
      await this.notifications.request(
        {
          eventType: event,
          priority: 'CRITICAL',
          recipients: recipients.map((userId) => ({ userId })),
          data: { name: reg.providerName, reason: reason ?? '' },
        },
        session,
      );
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: event,
          entityType: 'ProviderRegistration',
          entityId: id,
          reason,
          context: ctx,
        },
        session,
      );
      return (await this.registrations
        .findById(reg._id, undefined, { session })
        .lean<RegistrationDoc>()
        .exec()) as RegistrationDoc;
    });
    return this.view(updated);
  }

  async approve(id: string, user: AuthUser, ctx: AuditContext): Promise<RegistrationView> {
    const reg = await this.getById(id);
    if (reg.payment.status !== 'PAID' && reg.payment.status !== 'WAIVED') {
      throw new DomainError('INVALID_STATE_TRANSITION', 'The registration fee has not been received.');
    }
    const required = await this.requiredDocTypesFor(reg);
    const unverified = await this.documents.unverifiedTypes(
      reg.providerType,
      reg.providerId.toHexString(),
      required,
    );
    if (unverified.length) {
      throw new DomainError(
        'DOCUMENTS_MISSING',
        'Verify every required document before approving.',
        unverified.map((c) => ({ field: c })),
      );
    }
    return this.decide(id, 'APPROVED', undefined, user, ctx, async (r, session) => {
      await this.providers.transition(
        { type: r.providerType, id: r.providerId },
        ['PENDING_VERIFICATION'],
        'APPROVED',
        session,
        { approvedAt: new Date(), approvedBy: user.id },
      );
    });
  }

  async reject(id: string, reason: string, user: AuthUser, ctx: AuditContext): Promise<RegistrationView> {
    return this.decide(id, 'REJECTED', reason, user, ctx, async (r, session) => {
      await this.providers.transition(
        { type: r.providerType, id: r.providerId },
        ['PENDING_VERIFICATION'],
        'REJECTED',
        session,
        { statusReason: reason },
      );
      if (r.providerType === 'PROFESSIONAL') {
        const personId = await this.professionals.unlinkPerson(r.providerId, session);
        if (personId) await this.persons.release(personId, session);
      }
      await this.paymentHooks?.createRejectionRefund(r, reason, user.id, session);
    });
  }

  async requestChanges(
    id: string,
    comment: string,
    items: string[],
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationView> {
    return this.decide(id, 'CHANGES_REQUESTED', comment, user, ctx, async (r, session) => {
      await this.providers.transition(
        { type: r.providerType, id: r.providerId },
        ['PENDING_VERIFICATION'],
        'CHANGES_REQUESTED',
        session,
      );
      await this.registrations.updateOne(
        { _id: r._id },
        { $set: { 'verification.changesRequested': { comment, items } } },
        { session },
      );
    });
  }

  /** The vendor id is part of the caller's scopes; professionals are matched by user id. */
  isOwnRegistration(user: AuthUser, reg: RegistrationDoc): Promise<boolean> {
    if (reg.providerType === 'VENDOR')
      return Promise.resolve(vendorIdsOf(user).includes(reg.providerId.toHexString()));
    return this.professionals.findByUser(user.id).then((p) => !!p && p._id.equals(reg.providerId));
  }
}
