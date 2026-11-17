import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/app-config';
import { DomainError } from '../errors/domain-error';

export type PaymentDomain = 'REGISTRATION' | 'BUSINESS';

export interface CreateOrderInput {
  amountPaise: number;
  receipt: string;
  notes: { domain: PaymentDomain; paymentId: string; [key: string]: string };
}

export interface RefundResult {
  refundId: string;
  status: 'processed' | 'pending';
}

/**
 * Razorpay integration surface (SRS §11.2). `live` talks to the Razorpay REST API; `fake` is a
 * self-contained development gateway (used when no Razorpay keys are configured; refused in
 * production) that signs checkout results and webhooks exactly like Razorpay does.
 */
export abstract class PaymentGateway {
  abstract readonly mode: 'live' | 'fake';
  abstract readonly keyId: string;
  abstract createOrder(input: CreateOrderInput): Promise<{ orderId: string }>;
  abstract refund(
    paymentId: string,
    amountPaise: number,
    notes: Record<string, string>,
  ): Promise<RefundResult>;
  protected abstract readonly keySecret: string;
  protected abstract readonly webhookSecret: string;

  /** Checkout signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqualHex(hmacHex(this.keySecret, `${orderId}|${paymentId}`), signature);
  }

  /** Webhook signature: HMAC_SHA256(raw request body, webhook_secret). */
  verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
    return !!signature && safeEqualHex(hmacHex(this.webhookSecret, rawBody), signature);
  }
}

export function hmacHex(secret: string, data: string | Buffer): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

function safeEqualHex(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given ?? '');
  return a.length === b.length && timingSafeEqual(a, b);
}

export class RazorpayGateway extends PaymentGateway {
  readonly mode = 'live' as const;
  private readonly logger = new Logger('Razorpay');

  constructor(
    readonly keyId: string,
    protected readonly keySecret: string,
    protected readonly webhookSecret: string,
    private readonly baseUrl = 'https://api.razorpay.com/v1',
  ) {
    super();
  }

  private async request<T>(method: 'POST' | 'GET', path: string, body?: object): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!res.ok) {
      this.logger.error({ status: res.status, path, error: json.error }, 'Razorpay request failed');
      throw new DomainError(
        'INTERNAL_ERROR',
        'The payment provider could not process the request. Please try again.',
      );
    }
    return json;
  }

  async createOrder(input: CreateOrderInput): Promise<{ orderId: string }> {
    const order = await this.request<{ id: string }>('POST', '/orders', {
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes,
    });
    return { orderId: order.id };
  }

  async refund(paymentId: string, amountPaise: number, notes: Record<string, string>): Promise<RefundResult> {
    const refund = await this.request<{ id: string; status: string }>(
      'POST',
      `/payments/${paymentId}/refund`,
      {
        amount: amountPaise,
        notes,
      },
    );
    return { refundId: refund.id, status: refund.status === 'processed' ? 'processed' : 'pending' };
  }
}

export interface FakeOrder {
  orderId: string;
  amountPaise: number;
  notes: CreateOrderInput['notes'];
}

/** Development gateway: deterministic secrets, in-memory orders, immediate refunds. */
export class FakePaymentGateway extends PaymentGateway {
  readonly mode = 'fake' as const;
  readonly keyId = 'rzp_test_fake';
  protected readonly keySecret = 'fake-key-secret';
  protected readonly webhookSecret = 'fake-webhook-secret';
  readonly orders = new Map<string, FakeOrder>();

  async createOrder(input: CreateOrderInput): Promise<{ orderId: string }> {
    const orderId = `order_fake_${randomBytes(7).toString('hex')}`;
    this.orders.set(orderId, { orderId, amountPaise: input.amountPaise, notes: input.notes });
    return { orderId };
  }

  async refund(): Promise<RefundResult> {
    return { refundId: `rfnd_fake_${randomBytes(7).toString('hex')}`, status: 'processed' };
  }

  /** What Razorpay Checkout returns to the browser after a successful payment. */
  checkoutResult(orderId: string): {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  } {
    const paymentId = `pay_fake_${randomBytes(7).toString('hex')}`;
    return {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: hmacHex(this.keySecret, `${orderId}|${paymentId}`),
    };
  }

  /** A signed webhook exactly as Razorpay would deliver it. */
  webhook(
    event: 'payment.captured' | 'payment.failed',
    order: FakeOrder,
    paymentId: string,
  ): { body: Buffer; signature: string; eventId: string } {
    const body = Buffer.from(
      JSON.stringify({
        entity: 'event',
        event,
        created_at: Math.floor(Date.now() / 1000),
        payload: {
          payment: {
            entity: {
              id: paymentId,
              order_id: order.orderId,
              amount: order.amountPaise,
              currency: 'INR',
              status: event === 'payment.captured' ? 'captured' : 'failed',
              method: 'upi',
              notes: order.notes,
              ...(event === 'payment.failed' ? { error_description: 'Payment declined (simulated)' } : {}),
            },
          },
        },
      }),
    );
    return {
      body,
      signature: hmacHex(this.webhookSecret, body),
      eventId: `evt_fake_${randomBytes(7).toString('hex')}`,
    };
  }
}

@Injectable()
export class PaymentGatewayFactory {
  static create(config: AppConfig): PaymentGateway {
    const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET } = config.env;
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET && RAZORPAY_WEBHOOK_SECRET) {
      return new RazorpayGateway(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET);
    }
    return new FakePaymentGateway(); // production config validation forbids this path
  }
}
