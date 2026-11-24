import { Module, RequestMethod } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { LoggerModule } from 'nestjs-pino';
import { REQUEST_ID_HEADER } from '@bijliwala/contracts';
import { AppConfig } from '../config/app-config';

/** Paths redacted from every log line (SRS §10.6, ARCHITECTURE §6.11). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.otp',
  '*.code',
  '*.token',
  '*.refreshToken',
  '*.accessToken',
  '*.bankAccount',
  '*.accountNumber',
  '*.idNumber',
  '*.pan',
  '*.razorpay_signature',
];

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        // Nest 11 path syntax; the library default ('*') triggers a legacy-route warning.
        forRoutes: [{ path: '{*splat}', method: RequestMethod.ALL }],
        pinoHttp: {
          level: config.env.LOG_LEVEL,
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          genReqId: (req: IncomingMessage) => {
            const incoming = req.headers[REQUEST_ID_HEADER];
            return typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
              ? incoming
              : `req_${randomUUID()}`;
          },
          customProps: () => ({ service: 'api' }),
          autoLogging: { ignore: (req: IncomingMessage) => req.url?.startsWith('/health') ?? false },
          transport: config.env.LOG_PRETTY
            ? { target: 'pino-pretty', options: { singleLine: true } }
            : undefined,
        },
      }),
    }),
  ],
})
export class LoggingModule {}
