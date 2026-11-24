import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type ClientSession, type FilterQuery, type Model } from 'mongoose';
import {
  applyBasisPoints,
  type CheckoutVerifyInput,
  type OfflinePaymentInput,
  type OnlineOrderResponse,
  type PageMeta,
  type PaymentStatus,
  type RefundStatus,
  type RegistrationPaymentView,
  type RegistrationRefundView,
  type RegistrationView,
} from '@bijliwala/contracts';
import { actorFromUser, AuditService, type AuditContext } from '../../core/audit/audit.service';
import type { AuthUser } from '../../core/auth/auth.types';
import { BusinessConfigService } from '../../core/business-config/business-config.service';
import { TransactionRunner } from '../../core/database/transaction-runner';
import { DomainError, NotFoundError } from '../../core/errors/domain-error';
import { LedgerService } from '../../core/finance/ledger.service';
import { PaymentGateway } from '../../core/finance/payment-gateway';
import {
  WEBHOOK_RECEIVED,
  WebhookIngestionService,
  type WebhookReceivedPayload,
} from '../../core/finance/webhooks';
import { DomainEventBus } from '../../core/outbox/event-bus';
import { DocumentsService } from '../documents/documents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RegistrationsService } from './registrations.service';
import {
  REGISTRATION_PAYMENT_MODEL,
  REGISTRATION_REFUND_MODEL,
  type RegistrationDoc,
  type RegistrationPaymentDoc,
  type RegistrationRefundDoc,
} from './schemas';

const FINAL: PaymentStatus[] = ['SUCCESS', 'FAILED', 'REJECTED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
const OPEN_ONLINE: PaymentStatus[] = ['CREATED', 'PENDING_CONFIRMATION'];

export function toPaymentView(p: RegistrationPaymentDoc): RegistrationPaymentView {
  return {
    id: p._id.toHexString(),
    registrationId: p.registrationId.toHexString(),
    providerType: p.providerType,
    providerName: p.providerName,
    mode: p.mode,
    ...(p.method ? { method: p.method } : {}),
    basePaise: p.basePaise,
    taxPaise: p.taxPaise,
    amountPaise: p.amountPaise,
    status: p.status,
    capturedPaise: p.capturedPaise,
    refundedPaise: p.refundedPaise,
    ...(p.gateway
      ? {
          gateway: {
            orderId: p.gateway.orderId,
            ...(p.gateway.paymentId ? { paymentId: p.gateway.paymentId } : {}),
          },
        }
      : {}),
    ...(p.offline
      ? {
          offline: {
            reference: p.offline.reference,
            ...(p.offline.bank ? { bank: p.offline.bank } : {}),
            paidOn: p.offline.paidOn,
            proofDocId: p.offline.proofDocId.toHexString(),
          },
        }
      : {}),
    ...(p.rejectionReason ? { rejectionReason: p.rejectionReason } : {}),
    ...(p.failureReason ? { failureReason: p.failureReason } : {}),
    createdAt: p.createdAt.toISOString(),
  };
}

export function toRefundView(r: RegistrationRefundDoc): RegistrationRefundView {
  return {
    id: r._id.toHexString(),
    paymentId: r.paymentId.toHexString(),
    registrationId: r.registrationId.toHexString(),
    amountPaise: r.amountPaise,
    reason: r.reason,
    mode: r.mode,
    status: r.status,
    ...(r.gatewayRefundId ? { gatewayRefundId: r.gatewayRefundId } : {}),
    ...(r.offlineReference ? { offlineReference: r.offlineReference } : {}),
    createdAt: r.createdAt.toISOString(),
  };
}

/** Splits a refund between revenue and GST in proportion to the original payment (half-up). */
export function refundTaxShare(amountPaise: number, taxPaise: number, totalPaise: number): number {
  if (totalPaise === 0) return 0;
  return Math.floor((amountPaise * taxPaise * 2 + totalPaise) / (2 * totalPaise));
}

/** Refund owed on rejection under the plan's policy (FR-REG-05). */
export function rejectionRefundAmount(
  paidPaise: number,
  policy: { onRejection: 'FULL' | 'PARTIAL' | 'NONE'; partialPct?: number },
): number {
  if (policy.onRejection === 'NONE') return 0;
  if (policy.onRejection === 'FULL') return paidPaise;
  return applyBasisPoints(paidPaise, (policy.partialPct ?? 0) * 100);
}

/**
 * Registration fee payments (FR-REG-02/04/05/08): Razorpay online payments (the webhook is the
 * source of truth), offline payments with maker-checker verification, waivers and refunds. Every
 * money movement posts a balanced journal to the REGISTRATION ledger book (BR-FIN-01).
 */
@Injectable()
export class RegistrationPaymentsService implements OnModuleInit {
  private readonly logger = new Logger(RegistrationPaymentsService.name);

  constructor(
    @InjectModel(REGISTRATION_PAYMENT_MODEL) private readonly payments: Model<RegistrationPaymentDoc>,
    @InjectModel(REGISTRATION_REFUND_MODEL) private readonly refunds: Model<RegistrationRefundDoc>,
    private readonly registrations: RegistrationsService,
    private readonly gateway: PaymentGateway,
    private readonly webhooks: WebhookIngestionService,
    private readonly ledger: LedgerService,
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationsService,
    private readonly bus: DomainEventBus,
    private readonly config: BusinessConfigService,
    private readonly txn: TransactionRunner,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.registrations.paymentHooks = {
      createRejectionRefund: (reg, reason, actorId, session) =>
        this.createRejectionRefund(reg, reason, actorId, session),
    };
    this.bus.subscribe(WEBHOOK_RECEIVED, 'registration-payments', async (event) => {
      const payload = event.payload as unknown as WebhookReceivedPayload;
      if (payload.domain === 'REGISTRATION') await this.handleWebhook(payload.webhookEventId);
    });
  }

  /* ------------------------------------------------------------------ provider: online */

  private async myRegistration(user: AuthUser): Promise<RegistrationDoc> {
    const p = await this.registrations.providers.mine(user);
    return this.registrations.ensure(p);
  }

  private dueFor(reg: RegistrationDoc): { basePaise: number; taxPaise: number; amountPaise: number } {
    const plan = reg.planSnapshot;
    if (!plan) throw new DomainError('REGISTRATION_PLAN_REQUIRED', 'Choose a registration plan first.');
    if (reg.payment.status === 'PAID' || reg.payment.status === 'WAIVED')
      throw new DomainError('REGISTRATION_ALREADY_PAID', 'Your registration fee is already settled.');
    // The amount always comes from the server-side plan snapshot, never from the client (PAY-07).
    return { basePaise: plan.feePaise, taxPaise: plan.taxPaise, amountPaise: plan.totalPaise };
  }

  async startOnline(user: AuthUser): Promise<OnlineOrderResponse> {
    const reg = await this.myRegistration(user);
    const due = this.dueFor(reg);
    if (await this.payments.exists({ registrationId: reg._id, status: 'PENDING_VERIFICATION' })) {
      throw new DomainError('STATE_CONFLICT', 'An offline payment is waiting for verification.');
    }
    const _id = new Types.ObjectId();
    const { orderId } = await this.gateway.createOrder({
      amountPaise: due.amountPaise,
      receipt: `reg_${_id.toHexString()}`,
      notes: { domain: 'REGISTRATION', paymentId: _id.toHexString(), registrationId: reg._id.toHexString() },
    });
    await this.payments.create({
      _id,
      registrationId: reg._id,
      providerType: reg.providerType,
      providerId: reg.providerId,
      providerName: reg.providerName,
      mode: 'ONLINE',
      ...due,
      gateway: { orderId },
      status: 'CREATED',
      recordedBy: user.id,
    });
    return {
      paymentId: _id.toHexString(),
      mode: this.gateway.mode,
      razorpay: {
        keyId: this.gateway.keyId,
        orderId,
        amount: due.amountPaise,
        currency: 'INR',
        name: 'BijliWala360',
        description: `${reg.planSnapshot?.name ?? 'Registration'} fee`,
      },
    };
  }

  /** Browser-side confirmation; marks PENDING_CONFIRMATION. The webhook marks SUCCESS (FR-BPAY-01). */
  async verifyCheckout(
    user: AuthUser,
    paymentId: string,
    input: CheckoutVerifyInput,
  ): Promise<RegistrationPaymentView> {
    const reg = await this.myRegistration(user);
    const payment = Types.ObjectId.isValid(paymentId)
      ? await this.payments
          .findOne({ _id: paymentId, registrationId: reg._id })
          .lean<RegistrationPaymentDoc>()
          .exec()
      : null;
    if (!payment || payment.gateway?.orderId !== input.razorpay_order_id)
      throw new NotFoundError('Payment', paymentId);
    if (
      !this.gateway.verifyCheckoutSignature(
        input.razorpay_order_id,
        input.razorpay_payment_id,
        input.razorpay_signature,
      )
    ) {
      throw new DomainError('VALIDATION_FAILED', 'The payment confirmation could not be verified.');
    }
    await this.payments.updateOne(
      { _id: payment._id, status: 'CREATED' },
      { $set: { status: 'PENDING_CONFIRMATION', 'gateway.signatureVerifiedAt': new Date() } },
    );
    return toPaymentView(
      (await this.payments
        .findById(payment._id)
        .lean<RegistrationPaymentDoc>()
        .exec()) as RegistrationPaymentDoc,
    );
  }

  /* ------------------------------------------------------------------ webhook (FR-WHK-*) */

  async handleWebhook(webhookEventId: string): Promise<void> {
    const event = await this.webhooks.load(webhookEventId);
    if (!event || event.status !== 'RECEIVED') return;
    const body = event.payload;
    try {
      if (body.event === 'payment.captured' || body.event === 'order.paid') {
        const entity = body.payload.payment?.entity;
        if (!entity) return this.webhooks.markProcessed(webhookEventId, 'IGNORED', 'No payment entity');
        const payment = await this.payments
          .findOne({ 'gateway.orderId': entity.order_id })
          .lean<RegistrationPaymentDoc>()
          .exec();
        if (!payment) return this.webhooks.markProcessed(webhookEventId, 'IGNORED', 'Unknown order');
        if (entity.amount !== payment.amountPaise) {
          this.logger.error(
            { paymentId: payment._id.toHexString(), expected: payment.amountPaise, got: entity.amount },
            'Webhook amount mismatch',
          );
          return this.webhooks.markProcessed(webhookEventId, 'FAILED', 'AMOUNT_MISMATCH');
        }
        await this.txn.run(async (session) => {
          await this.applySuccess(
            payment._id,
            { gatewayPaymentId: entity.id, method: entity.method },
            'system:razorpay',
            session,
          );
        });
      } else if (body.event === 'payment.failed') {
        const entity = body.payload.payment?.entity;
        if (entity) {
          // Monotonic: a late "failed" can never downgrade a captured payment (FR-WHK-04).
          await this.payments.updateOne(
            { 'gateway.orderId': entity.order_id, status: { $in: OPEN_ONLINE } },
            { $set: { status: 'FAILED', failureReason: entity.error_description ?? 'Payment failed' } },
          );
        }
      } else if (body.event === 'refund.processed' || body.event === 'refund.failed') {
        const entity = body.payload.refund?.entity;
        const refund = entity
          ? await this.refunds.findOne({ gatewayRefundId: entity.id }).lean<RegistrationRefundDoc>().exec()
          : null;
        if (refund) {
          if (body.event === 'refund.processed')
            await this.txn.run((session) => this.markRefundProcessed(refund._id, session));
          else await this.failRefund(refund._id, 'Refund failed at the payment provider');
        }
      } else {
        return this.webhooks.markProcessed(webhookEventId, 'IGNORED');
      }
      await this.webhooks.markProcessed(webhookEventId, 'PROCESSED');
    } catch (err) {
      this.logger.error({ err, webhookEventId }, 'Registration webhook processing failed');
      throw err; // retried by the event bus
    }
  }

  /**
   * Single success path for online and offline payments: the conditional status update makes
   * duplicate webhooks, retries and races harmless (exactly-once financial effect).
   */
  private async applySuccess(
    paymentId: Types.ObjectId,
    info: { gatewayPaymentId?: string; method?: string; verifiedBy?: string },
    actor: string,
    session: ClientSession,
  ): Promise<boolean> {
    const payment = await this.payments
      .findOneAndUpdate(
        { _id: paymentId, status: { $nin: FINAL } },
        {
          $set: {
            status: 'SUCCESS',
            ...(info.gatewayPaymentId ? { 'gateway.paymentId': info.gatewayPaymentId } : {}),
            ...(info.method ? { 'gateway.method': info.method } : {}),
            ...(info.verifiedBy ? { verifiedBy: info.verifiedBy, verifiedAt: new Date() } : {}),
          },
          $inc: { version: 1 },
        },
        { new: true, session },
      )
      .lean<RegistrationPaymentDoc>()
      .exec();
    if (!payment) return false;
    await this.payments.updateOne(
      { _id: payment._id },
      { $set: { capturedPaise: payment.amountPaise } },
      { session },
    );
    await this.ledger.post(
      {
        book: 'REGISTRATION',
        refType: 'REGISTRATION_PAYMENT',
        refId: payment._id.toHexString(),
        partyType: payment.providerType,
        partyId: payment.providerId.toHexString(),
        narration: `Registration fee received (${payment.mode.toLowerCase()})`,
        postedBy: actor,
        lines: [
          {
            account: payment.mode === 'ONLINE' ? 'GATEWAY_CLEARING' : 'BANK',
            debitPaise: payment.amountPaise,
          },
          { account: 'REGISTRATION_REVENUE', creditPaise: payment.basePaise },
          { account: 'GST_OUTPUT', creditPaise: payment.taxPaise },
        ],
      },
      session,
    );
    await this.registrations.onFeeSettled(payment.registrationId, 'PAID', payment.amountPaise, session);
    const recipients = await this.registrations.providers.recipients(
      { type: payment.providerType, id: payment.providerId },
      session,
    );
    await this.notifications.request(
      {
        eventType: 'registration.payment_received',
        priority: 'CRITICAL',
        recipients: recipients.map((userId) => ({ userId })),
        data: { name: payment.providerName, amount: (payment.amountPaise / 100).toFixed(2) },
      },
      session,
    );
    await this.audit.record(
      {
        actor: { system: actor },
        action: 'registration_payment.succeeded',
        entityType: 'RegistrationPayment',
        entityId: payment._id.toHexString(),
        after: { amountPaise: payment.amountPaise, mode: payment.mode },
        isFinancial: true,
      },
      session,
    );
    return true;
  }

  /* ------------------------------------------------------------------ provider: offline */

  async recordOffline(
    user: AuthUser,
    input: OfflinePaymentInput,
    ctx: AuditContext,
  ): Promise<RegistrationPaymentView> {
    const reg = await this.myRegistration(user);
    const due = this.dueFor(reg);
    if (!reg.planSnapshot?.offlinePaymentAllowed)
      throw new DomainError('OFFLINE_NOT_ALLOWED', 'This plan must be paid online.');
    const enabled = await this.config.get('payment.offlineMethodsEnabled');
    if (!enabled.includes(input.method))
      throw new DomainError('OFFLINE_NOT_ALLOWED', 'This payment method is not accepted.', [
        { field: 'method' },
      ]);
    await this.documents.assertUsable(
      input.proofDocId,
      reg.providerType,
      reg.providerId.toHexString(),
      'PAYMENT_PROOF',
    );
    const referenceKey = `${input.method}:${input.reference.replace(/\s+/g, '').toUpperCase()}:${(input.bank ?? '').trim().toUpperCase()}`;
    try {
      const doc = await this.txn.run(async (session) => {
        if (
          await this.payments
            .exists({ registrationId: reg._id, status: 'PENDING_VERIFICATION' })
            .session(session)
        ) {
          throw new DomainError('STATE_CONFLICT', 'A payment is already waiting for verification.');
        }
        const [created] = await this.payments.create(
          [
            {
              registrationId: reg._id,
              providerType: reg.providerType,
              providerId: reg.providerId,
              providerName: reg.providerName,
              mode: 'OFFLINE',
              method: input.method,
              ...due,
              offline: {
                reference: input.reference.trim(),
                referenceKey,
                ...(input.bank ? { bank: input.bank } : {}),
                paidOn: input.paidOn,
                proofDocId: new Types.ObjectId(input.proofDocId),
              },
              status: 'PENDING_VERIFICATION',
              recordedBy: user.id,
            },
          ],
          { session },
        );
        await this.registrations.setPaymentState(reg._id, 'PENDING', session);
        await this.audit.record(
          {
            actor: actorFromUser(user),
            action: 'registration_payment.offline_recorded',
            entityType: 'RegistrationPayment',
            entityId: String(created?._id),
            after: { method: input.method, amountPaise: due.amountPaise },
            isFinancial: true,
            context: ctx,
          },
          session,
        );
        return (created as unknown as { toObject(): RegistrationPaymentDoc }).toObject();
      });
      return toPaymentView(doc);
    } catch (err) {
      if ((err as { code?: number }).code === 11000) {
        throw new DomainError(
          'DUPLICATE_PAYMENT_REFERENCE',
          'This transaction reference has already been used.',
          [{ field: 'reference' }],
        );
      }
      throw err;
    }
  }

  async myPayments(user: AuthUser): Promise<RegistrationPaymentView[]> {
    const reg = await this.myRegistration(user);
    const docs = await this.payments
      .find({ registrationId: reg._id })
      .sort({ createdAt: -1 })
      .lean<RegistrationPaymentDoc[]>()
      .exec();
    return docs.map(toPaymentView);
  }

  /* ------------------------------------------------------------------ finance: offline verification */

  private async getPayment(id: string, session?: ClientSession): Promise<RegistrationPaymentDoc> {
    const p = Types.ObjectId.isValid(id)
      ? await this.payments.findById(id, undefined, { session }).lean<RegistrationPaymentDoc>().exec()
      : null;
    if (!p) throw new NotFoundError('Payment', id);
    return p;
  }

  /** Maker-checker (BR-FIN-03): the verifier can never be the person who recorded the payment. */
  async verifyOffline(id: string, user: AuthUser, ctx: AuditContext): Promise<RegistrationPaymentView> {
    const p = await this.getPayment(id);
    if (p.mode !== 'OFFLINE' || p.status !== 'PENDING_VERIFICATION')
      throw new DomainError(
        'INVALID_STATE_TRANSITION',
        'Only offline payments awaiting verification can be verified.',
      );
    if (p.recordedBy === user.id)
      throw new DomainError(
        'MAKER_CHECKER_VIOLATION',
        'You recorded this payment, so someone else must verify it.',
      );
    await this.txn.run(async (session) => {
      const ok = await this.applySuccess(p._id, { verifiedBy: user.id }, `user:${user.id}`, session);
      if (!ok) throw new DomainError('STATE_CONFLICT', 'This payment was already processed.');
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'registration_payment.verified',
          entityType: 'RegistrationPayment',
          entityId: id,
          isFinancial: true,
          context: ctx,
        },
        session,
      );
    });
    return toPaymentView(await this.getPayment(id));
  }

  async rejectOffline(
    id: string,
    reason: string,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationPaymentView> {
    const p = await this.getPayment(id);
    if (p.recordedBy === user.id)
      throw new DomainError(
        'MAKER_CHECKER_VIOLATION',
        'You recorded this payment, so someone else must review it.',
      );
    await this.txn.run(async (session) => {
      const res = await this.payments.updateOne(
        { _id: p._id, mode: 'OFFLINE', status: 'PENDING_VERIFICATION' },
        {
          $set: { status: 'REJECTED', rejectionReason: reason, verifiedBy: user.id, verifiedAt: new Date() },
          $inc: { version: 1 },
        },
        { session },
      );
      if (res.modifiedCount !== 1)
        throw new DomainError(
          'INVALID_STATE_TRANSITION',
          'Only offline payments awaiting verification can be rejected.',
        );
      await this.registrations.setPaymentState(p.registrationId, 'UNPAID', session);
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'registration_payment.rejected',
          entityType: 'RegistrationPayment',
          entityId: id,
          reason,
          isFinancial: true,
          context: ctx,
        },
        session,
      );
    });
    return toPaymentView(await this.getPayment(id));
  }

  async waive(
    registrationId: string,
    reason: string,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationView> {
    const reg = await this.registrations.getById(registrationId);
    if (!reg.planSnapshot)
      throw new DomainError('REGISTRATION_PLAN_REQUIRED', 'The provider has not chosen a plan.');
    if (reg.payment.status !== 'UNPAID')
      throw new DomainError('INVALID_STATE_TRANSITION', 'Only unpaid registrations can be waived.');
    await this.txn.run(async (session) => {
      await this.registrations.onFeeSettled(reg._id, 'WAIVED', 0, session, { by: user.id, reason });
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'registration.fee_waived',
          entityType: 'ProviderRegistration',
          entityId: registrationId,
          reason,
          after: { amountPaise: reg.planSnapshot?.totalPaise },
          isFinancial: true,
          context: ctx,
        },
        session,
      );
    });
    return this.registrations.view(await this.registrations.getById(registrationId));
  }

  async list(q: {
    page: number;
    pageSize: number;
    status?: PaymentStatus;
    mode?: 'ONLINE' | 'OFFLINE';
  }): Promise<{ items: RegistrationPaymentView[]; meta: PageMeta }> {
    const filter: FilterQuery<RegistrationPaymentDoc> = {};
    if (q.status) filter.status = q.status;
    if (q.mode) filter.mode = q.mode;
    const [docs, total] = await Promise.all([
      this.payments
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<RegistrationPaymentDoc[]>()
        .exec(),
      this.payments.countDocuments(filter),
    ]);
    return { items: docs.map(toPaymentView), meta: { page: q.page, pageSize: q.pageSize, total } };
  }

  async forRegistration(
    regId: Types.ObjectId,
  ): Promise<{ payments: RegistrationPaymentView[]; refunds: RegistrationRefundView[] }> {
    const [payments, refunds] = await Promise.all([
      this.payments
        .find({ registrationId: regId })
        .sort({ createdAt: -1 })
        .lean<RegistrationPaymentDoc[]>()
        .exec(),
      this.refunds
        .find({ registrationId: regId })
        .sort({ createdAt: -1 })
        .lean<RegistrationRefundDoc[]>()
        .exec(),
    ]);
    return { payments: payments.map(toPaymentView), refunds: refunds.map(toRefundView) };
  }

  /* ------------------------------------------------------------------ refunds (FR-RFD-*) */

  async createRejectionRefund(
    reg: RegistrationDoc,
    reason: string,
    actorId: string,
    session: ClientSession,
  ): Promise<void> {
    if (!reg.planSnapshot) return;
    const payment = await this.payments
      .findOne({ registrationId: reg._id, status: 'SUCCESS' }, undefined, { session })
      .lean<RegistrationPaymentDoc>()
      .exec();
    if (!payment) return;
    const amount = rejectionRefundAmount(payment.capturedPaise, reg.planSnapshot.refundPolicy);
    if (amount <= 0) return;
    await this.refunds.create(
      [
        {
          paymentId: payment._id,
          registrationId: reg._id,
          amountPaise: amount,
          reason: `Registration rejected: ${reason}`,
          mode: payment.mode,
          status: 'PENDING_APPROVAL',
          requestedBy: actorId,
        },
      ],
      { session },
    );
  }

  private async getRefund(id: string): Promise<RegistrationRefundDoc> {
    const r = Types.ObjectId.isValid(id)
      ? await this.refunds.findById(id).lean<RegistrationRefundDoc>().exec()
      : null;
    if (!r) throw new NotFoundError('Refund', id);
    return r;
  }

  /**
   * Approves a refund. The cap `refunded + amount <= captured` is enforced with a conditional
   * increment (FR-RFD-04); the gateway is called only after the reservation is committed.
   */
  async approveRefund(id: string, user: AuthUser, ctx: AuditContext): Promise<RegistrationRefundView> {
    const refund = await this.getRefund(id);
    if (refund.requestedBy === user.id)
      throw new DomainError(
        'MAKER_CHECKER_VIOLATION',
        'You requested this refund, so someone else must approve it.',
      );
    const nextStatus: RefundStatus = refund.mode === 'ONLINE' ? 'PROCESSING' : 'APPROVED';
    await this.txn.run(async (session) => {
      const claimed = await this.refunds.updateOne(
        { _id: refund._id, status: 'PENDING_APPROVAL' },
        { $set: { status: nextStatus, approvedBy: user.id }, $inc: { version: 1 } },
        { session },
      );
      if (claimed.modifiedCount !== 1)
        throw new DomainError('INVALID_STATE_TRANSITION', 'This refund is not waiting for approval.');
      const reserved = await this.payments.updateOne(
        {
          _id: refund.paymentId,
          status: { $in: ['SUCCESS', 'PARTIALLY_REFUNDED'] },
          $expr: { $lte: [{ $add: ['$refundedPaise', refund.amountPaise] }, '$capturedPaise'] },
        },
        { $inc: { refundedPaise: refund.amountPaise } },
        { session },
      );
      if (reserved.modifiedCount !== 1)
        throw new DomainError('REFUND_EXCEEDS_CAPTURED', 'The refund would exceed the amount received.');
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'registration_refund.approved',
          entityType: 'RegistrationRefund',
          entityId: id,
          after: { amountPaise: refund.amountPaise },
          isFinancial: true,
          context: ctx,
        },
        session,
      );
    });

    if (refund.mode === 'ONLINE') {
      const payment = await this.getPayment(refund.paymentId.toHexString());
      try {
        const result = await this.gateway.refund(payment.gateway?.paymentId ?? '', refund.amountPaise, {
          domain: 'REGISTRATION',
          refundId: id,
        });
        await this.refunds.updateOne({ _id: refund._id }, { $set: { gatewayRefundId: result.refundId } });
        if (result.status === 'processed')
          await this.txn.run((session) => this.markRefundProcessed(refund._id, session));
      } catch (err) {
        await this.failRefund(refund._id, err instanceof Error ? err.message : 'Gateway error');
        throw err;
      }
    }
    return toRefundView(await this.getRefund(id));
  }

  async rejectRefund(
    id: string,
    reason: string,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationRefundView> {
    const res = await this.refunds.updateOne(
      { _id: id, status: 'PENDING_APPROVAL' },
      { $set: { status: 'REJECTED', failureReason: reason, approvedBy: user.id } },
    );
    if (res.modifiedCount !== 1)
      throw new DomainError('INVALID_STATE_TRANSITION', 'This refund is not waiting for approval.');
    await this.audit.record({
      actor: actorFromUser(user),
      action: 'registration_refund.rejected',
      entityType: 'RegistrationRefund',
      entityId: id,
      reason,
      isFinancial: true,
      context: ctx,
    });
    return toRefundView(await this.getRefund(id));
  }

  async completeOfflineRefund(
    id: string,
    reference: string,
    user: AuthUser,
    ctx: AuditContext,
  ): Promise<RegistrationRefundView> {
    const refund = await this.getRefund(id);
    if (refund.mode !== 'OFFLINE' || refund.status !== 'APPROVED')
      throw new DomainError('INVALID_STATE_TRANSITION', 'Only approved offline refunds can be completed.');
    await this.txn.run(async (session) => {
      await this.refunds.updateOne(
        { _id: refund._id },
        { $set: { offlineReference: reference } },
        { session },
      );
      await this.markRefundProcessed(refund._id, session);
      await this.audit.record(
        {
          actor: actorFromUser(user),
          action: 'registration_refund.paid_offline',
          entityType: 'RegistrationRefund',
          entityId: id,
          after: { reference },
          isFinancial: true,
          context: ctx,
        },
        session,
      );
    });
    return toRefundView(await this.getRefund(id));
  }

  private async markRefundProcessed(refundId: Types.ObjectId, session: ClientSession): Promise<void> {
    const refund = await this.refunds
      .findOneAndUpdate(
        { _id: refundId, status: { $in: ['PROCESSING', 'APPROVED'] } },
        { $set: { status: 'PROCESSED', processedAt: new Date() } },
        { new: true, session },
      )
      .lean<RegistrationRefundDoc>()
      .exec();
    if (!refund) return; // already processed (duplicate webhook)
    const payment = await this.getPayment(refund.paymentId.toHexString(), session);
    const fully = payment.refundedPaise >= payment.capturedPaise;
    await this.payments.updateOne(
      { _id: payment._id },
      { $set: { status: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } },
      { session },
    );
    await this.registrations.setPaymentState(
      refund.registrationId,
      fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
      session,
      refund.amountPaise,
    );
    const taxShare = refundTaxShare(refund.amountPaise, payment.taxPaise, payment.amountPaise);
    await this.ledger.post(
      {
        book: 'REGISTRATION',
        refType: 'REFUND',
        refId: refund._id.toHexString(),
        partyType: payment.providerType,
        partyId: payment.providerId.toHexString(),
        narration: 'Registration fee refund',
        lines: [
          { account: 'REGISTRATION_REVENUE', debitPaise: refund.amountPaise - taxShare },
          { account: 'GST_OUTPUT', debitPaise: taxShare },
          {
            account: payment.mode === 'ONLINE' ? 'GATEWAY_CLEARING' : 'BANK',
            creditPaise: refund.amountPaise,
          },
        ],
      },
      session,
    );
  }

  /** Releases the reservation of a refund that could not be paid out. */
  private async failRefund(refundId: Types.ObjectId, reason: string): Promise<void> {
    await this.txn.run(async (session) => {
      const refund = await this.refunds
        .findOneAndUpdate(
          { _id: refundId, status: { $in: ['PROCESSING', 'APPROVED'] } },
          { $set: { status: 'FAILED', failureReason: reason } },
          { new: true, session },
        )
        .lean<RegistrationRefundDoc>()
        .exec();
      if (refund)
        await this.payments.updateOne(
          { _id: refund.paymentId },
          { $inc: { refundedPaise: -refund.amountPaise } },
          { session },
        );
    });
  }

  async listRefunds(q: {
    page: number;
    pageSize: number;
    status?: RefundStatus;
  }): Promise<{ items: RegistrationRefundView[]; meta: PageMeta }> {
    const filter: FilterQuery<RegistrationRefundDoc> = q.status ? { status: q.status } : {};
    const [docs, total] = await Promise.all([
      this.refunds
        .find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean<RegistrationRefundDoc[]>()
        .exec(),
      this.refunds.countDocuments(filter),
    ]);
    return { items: docs.map(toRefundView), meta: { page: q.page, pageSize: q.pageSize, total } };
  }
}
