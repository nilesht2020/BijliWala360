import { Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { createTestApp, type TestApp } from '../setup/harness';
import { PROBE_MODEL, ProbeController, probeSchema } from '../support/probe.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: PROBE_MODEL, schema: probeSchema }])],
  exports: [MongooseModule],
})
class ProbeModelModule {}

describe('HTTP pipeline (envelope, errors, validation, auth, rate limit, idempotency)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp({ imports: [ProbeModelModule], controllers: [ProbeController] });
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('envelope and errors', () => {
    it('wraps success responses and echoes a request id', async () => {
      const res = await t.http().get('/api/v1/probe/public').expect(200);
      expect(res.body).toEqual({ success: true, data: { hello: 'world' } });
      expect(res.headers['x-request-id']).toMatch(/^req_/);
    });

    it('honours a well-formed incoming request id', async () => {
      const res = await t
        .http()
        .get('/api/v1/probe/public')
        .set('X-Request-Id', 'client-abc-12345')
        .expect(200);
      expect(res.headers['x-request-id']).toBe('client-abc-12345');
    });

    it('lifts pagination meta and coerces query params', async () => {
      const res = await t.http().get('/api/v1/probe/list?page=2&pageSize=5').expect(200);
      expect(res.body).toEqual({ success: true, data: [1, 2, 3], meta: { page: 2, pageSize: 5, total: 3 } });
    });

    it('maps domain errors to their contract status and code', async () => {
      const res = await t.http().get('/api/v1/probe/domain-error').expect(422);
      expect(res.body).toMatchObject({
        success: false,
        error: { code: 'COMMITMENT_CONFLICT', details: [{ lineId: 'L1' }] },
        requestId: expect.stringMatching(/^req_/),
      });
    });

    it('hides internal error details', async () => {
      const res = await t.http().get('/api/v1/probe/crash').expect(500);
      expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' });
      expect(JSON.stringify(res.body)).not.toContain('secret');
    });

    it('returns an enveloped 404 for unknown routes', async () => {
      const res = await t.http().get('/api/v1/does-not-exist').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('validation and sanitising', () => {
    it('rejects invalid bodies with field details', async () => {
      const res = await t.http().post('/api/v1/probe').send({ name: 'x' }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details[0].path).toBe('name');
    });

    it('rejects unknown keys (strict schemas)', async () => {
      const res = await t.http().post('/api/v1/probe').send({ name: 'ok-name', isAdmin: true }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });

    it('blocks NoSQL operator injection in body and query', async () => {
      await t
        .http()
        .post('/api/v1/probe')
        .send({ name: { $gt: '' } })
        .expect(400);
      const res = await t.http().get('/api/v1/probe/list?page[$gt]=1').expect(400);
      expect(res.body.error.details[0].path).toContain('$gt');
      expect(res.body.requestId).toMatch(/^req_/);
    });

    it('translates unique-index violations into 409', async () => {
      await t.http().post('/api/v1/probe').send({ name: 'dup-name' }).expect(201);
      const res = await t.http().post('/api/v1/probe').send({ name: 'dup-name' }).expect(409);
      expect(res.body.error.code).toBe('STATE_CONFLICT');
    });
  });

  describe('authentication and authorisation', () => {
    it('requires a bearer token on non-public routes', async () => {
      const res = await t.http().get('/api/v1/probe/me').expect(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects malformed tokens', async () => {
      await t.http().get('/api/v1/probe/me').set('Authorization', 'Bearer not-a-jwt').expect(401);
    });

    it('rejects validly signed tokens for principals the resolver does not know', async () => {
      const token = await t.app
        .get(JwtService)
        .signAsync({ sub: 'ffffffffffffffffffffffff', typ: 'ADMIN', pv: 1 });
      const res = await t.http().get('/api/v1/probe/me').set('Authorization', `Bearer ${token}`).expect(401);
      expect(res.body.error.message).toBe('Session is no longer valid.');
    });

    it('rejects expired tokens with TOKEN_EXPIRED', async () => {
      const token = await t.app
        .get(JwtService)
        .signAsync({ sub: 'aaaaaaaaaaaaaaaaaaaaaaaa', typ: 'ADMIN', pv: 1 }, { expiresIn: -10 });
      const res = await t.http().get('/api/v1/probe/me').set('Authorization', `Bearer ${token}`).expect(401);
      expect(res.body.error.code).toBe('TOKEN_EXPIRED');
    });

    it('attaches the principal for valid tokens', async () => {
      const token = await t.tokenFor({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
      const res = await t.http().get('/api/v1/probe/me').set('Authorization', `Bearer ${token}`).expect(200);
      expect(res.body.data).toEqual({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
    });

    it('enforces @RequirePermissions', async () => {
      const opsToken = await t.tokenFor({ permissions: ['allocation.propose'] });
      const res = await t
        .http()
        .get('/api/v1/probe/approve-only')
        .set('Authorization', `Bearer ${opsToken}`)
        .expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');

      const approverToken = await t.tokenFor({ permissions: ['allocation.approve'] });
      await t
        .http()
        .get('/api/v1/probe/approve-only')
        .set('Authorization', `Bearer ${approverToken}`)
        .expect(200);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with Retry-After once the limit is exceeded', async () => {
      await t.http().get('/api/v1/probe/limited').expect(200);
      await t.http().get('/api/v1/probe/limited').expect(200);
      const res = await t.http().get('/api/v1/probe/limited').expect(429);
      expect(res.body.error.code).toBe('RATE_LIMITED');
      expect(res.headers['retry-after']).toBe('60');
    });
  });

  describe('idempotency', () => {
    let token: string;
    beforeAll(async () => {
      token = await t.tokenFor({ permissions: ['payment.create'] });
    });
    const pay = (key: string | null, body: object) => {
      const req = t.http().post('/api/v1/probe/pay').set('Authorization', `Bearer ${token}`).send(body);
      return key ? req.set('Idempotency-Key', key) : req;
    };

    it('requires the header on idempotent routes', async () => {
      const res = await pay(null, { amountPaise: 100 }).expect(400);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('replays the original response without re-running the handler', async () => {
      const before = ProbeController.handlerCalls;
      const first = await pay('key-replay-0001', { amountPaise: 500 }).expect(201);
      const second = await pay('key-replay-0001', { amountPaise: 500 }).expect(201);
      expect(second.body).toEqual(first.body);
      expect(ProbeController.handlerCalls).toBe(before + 1);
    });

    it('treats key order differences as the same payload', async () => {
      await pay('key-order-0001', { amountPaise: 1, delayMs: 0 }).expect(201);
      await pay('key-order-0001', { delayMs: 0, amountPaise: 1 }).expect(201);
    });

    it('rejects reuse of a key with a different payload', async () => {
      await pay('key-reuse-0001', { amountPaise: 500 }).expect(201);
      const res = await pay('key-reuse-0001', { amountPaise: 999 }).expect(422);
      expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('runs the handler once under concurrent duplicates', async () => {
      const before = ProbeController.handlerCalls;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => pay('key-concurrent-01', { amountPaise: 700, delayMs: 300 })),
      );
      const ok = results.filter((r) => r.status === 201);
      const inProgress = results.filter((r) => r.status === 409);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      expect(ok.length + inProgress.length).toBe(5);
      inProgress.forEach((r) => expect(r.body.error.code).toBe('REQUEST_IN_PROGRESS'));
      expect(ProbeController.handlerCalls).toBe(before + 1);
    });

    it('releases the key when the handler fails so the client can retry', async () => {
      await pay('key-fail-000001', { amountPaise: -1 }).expect(400);
      const before = ProbeController.handlerCalls;
      await pay('key-fail-000001', { amountPaise: -1 }).expect(400);
      expect(ProbeController.handlerCalls).toBe(before + 1);
    });

    it('scopes keys per user', async () => {
      const otherToken = await t.tokenFor({ permissions: ['payment.create'] });
      const mine = await pay('key-scope-00001', { amountPaise: 5 }).expect(201);
      const theirs = await t
        .http()
        .post('/api/v1/probe/pay')
        .set('Authorization', `Bearer ${otherToken}`)
        .set('Idempotency-Key', 'key-scope-00001')
        .send({ amountPaise: 5 })
        .expect(201);
      expect(theirs.body.data.paymentNo).not.toBe(mine.body.data.paymentNo);
    });
  });

  describe('health', () => {
    it('serves liveness and readiness outside the API prefix without auth', async () => {
      await t.http().get('/health/live').expect(200, { status: 'ok' });
      const res = await t.http().get('/health/ready').expect(200);
      expect(res.body).toEqual({ status: 'ok', checks: { mongo: 'up', redis: 'up' } });
    });
  });
});
