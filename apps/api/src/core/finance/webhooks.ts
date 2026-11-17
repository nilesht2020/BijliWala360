import { Body, Controller, Global, Headers, HttpCode, Injectable, Module, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController, ApiTags } from '@nestjs/swagger';
import { InjectModel, MongooseModule } from '@nestjs/mongoose';
import type { Request } from 'express';
import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../auth/rate-limit';
import { AppConfig } from '../config/app-config';
import { TransactionRunner } from '../database/transaction-runner';
import { DomainError } from '../errors/domain-error';
import { RawResponse } from '../http/response-envelope.interceptor';
import { createZodDto } from '../http/zod';
import { OutboxService } from '../outbox/outbox.service';
import { FINANCE_SCHEMAS, WEBHOOK_EVENT_MODEL, type WebhookEventDoc } from './finance.schemas';
import { LedgerService } from './ledger.service';
import {
  FakePaymentGateway,
  PaymentGateway,
  PaymentGatewayFactory,
  type PaymentDomain,
} from './payment-gateway';

export const WEBHOOK_RECEIVED = 'payment.webhook_received';

export interface WebhookReceivedPayload {
  webhookEventId: string;
  eventType: string;
  domain: PaymentDomain | null;
}

/** The parts of a Razorpay webhook payload the domain handlers use. */
export interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
  amount: number;
  status: string;
  method?: string;
  notes?: Record<string, string>;
  error_description?: string;
}

export interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
  notes?: Record<string, string>;
}

export interface RazorpayWebhook {
  event: string;
  payload: {
    payment?: { entity: RazorpayPaymentEntity };
    refund?: { entity: RazorpayRefundEntity };
  };
}

function domainOf(body: RazorpayWebhook): PaymentDomain | null {
  const notes = body.payload.payment?.entity.notes ?? body.payload.refund?.entity.notes;
  const domain = notes?.domain;
  return domain === 'REGISTRATION' || domain === 'BUSINESS' ? domain : null;
}

/**
 * Webhook ingestion (FR-WHK-01..05): verify the HMAC on the raw body, store the event once
 * (unique provider+eventId), and hand it to the domain consumers through the transactional
 * outbox. The HTTP response is returned immediately; duplicates are acknowledged and ignored.
 */
@Injectable()
export class WebhookIngestionService {
  constructor(
    @InjectModel(WEBHOOK_EVENT_MODEL) private readonly events: Model<WebhookEventDoc>,
    private readonly gateway: PaymentGateway,
    private readonly outbox: OutboxService,
    private readonly txn: TransactionRunner,
  ) {}

  async ingest(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    eventIdHeader: string | undefined,
  ): Promise<{ duplicate: boolean }> {
    if (!rawBody || !this.gateway.verifyWebhookSignature(rawBody, signature)) {
      throw new DomainError('WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature.');
    }
    let body: RazorpayWebhook;
    try {
      body = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhook;
    } catch {
      throw new DomainError('VALIDATION_FAILED', 'Webhook body is not valid JSON.');
    }
    const eventId = eventIdHeader || `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
    const domain = domainOf(body);
    try {
      await this.txn.run(async (session) => {
        const [doc] = await this.events.create(
          [
            {
              provider: 'RAZORPAY',
              eventId,
              eventType: body.event,
              payload: body as unknown as Record<string, unknown>,
              ...(domain ? { domain } : {}),
            },
          ],
          { session },
        );
        const payload: WebhookReceivedPayload = {
          webhookEventId: (doc as { _id: { toHexString(): string } })._id.toHexString(),
          eventType: body.event,
          domain,
        };
        await this.outbox.add(
          {
            type: WEBHOOK_RECEIVED,
            aggregateType: 'WebhookEvent',
            aggregateId: eventId,
            payload: { ...payload },
          },
          session,
        );
      });
      return { duplicate: false };
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return { duplicate: true };
      throw err;
    }
  }

  async load(id: string): Promise<(WebhookEventDoc & { payload: RazorpayWebhook }) | null> {
    return this.events.findById(id).lean<WebhookEventDoc & { payload: RazorpayWebhook }>().exec();
  }

  async markProcessed(id: string, status: 'PROCESSED' | 'IGNORED' | 'FAILED', error?: string): Promise<void> {
    await this.events.updateOne(
      { _id: id },
      { $set: { status, processedAt: new Date(), ...(error ? { error } : {}) }, $inc: { attempts: 1 } },
    );
  }
}

@ApiExcludeController()
@Controller('webhooks')
export class RazorpayWebhookController {
  constructor(private readonly ingestion: WebhookIngestionService) {}

  @Public()
  @SkipRateLimit()
  @Post('razorpay')
  @HttpCode(200)
  @RawResponse()
  async razorpay(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ): Promise<{ received: true; duplicate: boolean }> {
    const { duplicate } = await this.ingestion.ingest(req.rawBody, signature, eventId);
    return { received: true, duplicate };
  }
}

class SimulatePaymentDto extends createZodDto(
  z.object({ orderId: z.string().min(1).max(100), outcome: z.enum(['success', 'failure']) }).strict(),
) {}

/**
 * Development-only stand-in for Razorpay Checkout (fake gateway only; 404 otherwise). Produces the
 * signed checkout result the browser would receive and delivers the signed webhook through the
 * normal ingestion path.
 */
@ApiTags('Development')
@ApiBearerAuth()
@Controller('dev/payments')
export class DevPaymentsController {
  constructor(
    private readonly gateway: PaymentGateway,
    private readonly ingestion: WebhookIngestionService,
  ) {}

  @Post('simulate')
  @HttpCode(200)
  async simulate(@Body() dto: SimulatePaymentDto): Promise<Record<string, string | boolean>> {
    if (!(this.gateway instanceof FakePaymentGateway)) throw new DomainError('NOT_FOUND', 'Not found.');
    const order = this.gateway.orders.get(dto.orderId);
    if (!order) throw new DomainError('NOT_FOUND', 'Unknown order.');
    const checkout = this.gateway.checkoutResult(order.orderId);
    const hook = this.gateway.webhook(
      dto.outcome === 'success' ? 'payment.captured' : 'payment.failed',
      order,
      checkout.razorpay_payment_id,
    );
    await this.ingestion.ingest(hook.body, hook.signature, hook.eventId);
    return dto.outcome === 'success' ? checkout : { failed: true };
  }
}

/** Shared financial core: payment gateway, webhook ingestion and the ledger (ARCHITECTURE §4.1). */
@Global()
@Module({
  imports: [MongooseModule.forFeature(FINANCE_SCHEMAS)],
  controllers: [RazorpayWebhookController, DevPaymentsController],
  providers: [
    {
      provide: PaymentGateway,
      inject: [AppConfig],
      useFactory: (config: AppConfig) => PaymentGatewayFactory.create(config),
    },
    WebhookIngestionService,
    LedgerService,
  ],
  exports: [PaymentGateway, WebhookIngestionService, LedgerService],
})
export class FinanceModule {}
