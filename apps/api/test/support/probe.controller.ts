import { Body, Controller, Get, HttpCode, Param, Post, Query, UseInterceptors } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Schema, type Model } from 'mongoose';
import { z } from 'zod';
import { CurrentUser, Public, RequirePermissions } from '../../src/core/auth/decorators';
import type { AuthUser } from '../../src/core/auth/auth.types';
import { RateLimit } from '../../src/core/auth/rate-limit';
import { TransactionRunner } from '../../src/core/database/transaction-runner';
import { DomainError } from '../../src/core/errors/domain-error';
import { PagedResult } from '../../src/core/http/response-envelope.interceptor';
import { createZodDto } from '../../src/core/http/zod';
import { Idempotent, IdempotencyInterceptor } from '../../src/core/idempotency/idempotency.interceptor';
import { OutboxService } from '../../src/core/outbox/outbox.service';

export const PROBE_MODEL = 'Probe';
export const probeSchema = new Schema(
  { name: { type: String, required: true }, count: { type: Number, default: 0 } },
  { collection: 'probes', versionKey: false },
);
probeSchema.index({ name: 1 }, { unique: true });

class CreateProbeDto extends createZodDto(
  z.object({ name: z.string().min(2).max(50), count: z.number().int().min(0).default(0) }).strict(),
) {}

class ListQueryDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  }),
) {}

/** Test-only controller that exercises every core HTTP concern. */
@Controller('probe')
export class ProbeController {
  static handlerCalls = 0;

  constructor(
    @InjectModel(PROBE_MODEL) private readonly probes: Model<{ name: string; count: number }>,
    private readonly txn: TransactionRunner,
    private readonly outbox: OutboxService,
  ) {}

  @Public()
  @Get('public')
  publicRoute(): { hello: string } {
    return { hello: 'world' };
  }

  @Public()
  @Get('list')
  list(@Query() q: ListQueryDto): PagedResult<number> {
    return new PagedResult([1, 2, 3], { page: q.page, pageSize: q.pageSize, total: 3 });
  }

  @Public()
  @Get('domain-error')
  domainError(): never {
    throw new DomainError('COMMITMENT_CONFLICT', 'Person already booked.', [{ lineId: 'L1' }]);
  }

  @Public()
  @Get('crash')
  crash(): never {
    throw new Error('internal secret detail');
  }

  @Public()
  @RateLimit({ name: 'probe', limit: 2, windowSeconds: 60, by: 'ip' })
  @Get('limited')
  limited(): { ok: true } {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): { id: string } {
    return { id: user.id };
  }

  @RequirePermissions('allocation.approve')
  @Get('approve-only')
  approveOnly(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Post()
  @HttpCode(201)
  async create(@Body() dto: CreateProbeDto): Promise<{ name: string; count: number }> {
    const doc = await this.probes.create(dto);
    return { name: doc.name, count: doc.count };
  }

  /** Creates a probe + outbox event in one transaction; optionally fails after writing. */
  @Public()
  @Post('txn/:name')
  async txnCreate(@Param('name') name: string, @Query('fail') fail?: string): Promise<{ name: string }> {
    return this.txn.run(async (session) => {
      await this.probes.create([{ name }], { session });
      await this.outbox.add(
        { type: 'probe.created', aggregateType: 'Probe', aggregateId: name, payload: { name } },
        session,
      );
      if (fail === '1') throw new DomainError('STATE_CONFLICT', 'forced failure');
      return { name };
    });
  }

  @RequirePermissions('payment.create')
  @Idempotent()
  @UseInterceptors(IdempotencyInterceptor)
  @Post('pay')
  async pay(
    @Body() body: { amountPaise: number; delayMs?: number },
  ): Promise<{ paymentNo: number; amountPaise: number }> {
    ProbeController.handlerCalls += 1;
    const callNo = ProbeController.handlerCalls;
    if (body.delayMs) await new Promise((r) => setTimeout(r, body.delayMs));
    if (body.amountPaise < 0) throw new DomainError('VALIDATION_FAILED', 'negative');
    return { paymentNo: callNo, amountPaise: body.amountPaise };
  }
}
