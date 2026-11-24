import { RequestMethod, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { APP_NAME, IDEMPOTENCY_HEADER, REQUEST_ID_HEADER } from '@bijliwala/contracts';
import { AppConfig } from './core/config/app-config';

export const API_PREFIX = 'api/v1';

/**
 * Applies HTTP-level configuration. Shared by main.ts and the integration-test harness so tests
 * exercise exactly the production pipeline.
 */
export function configureApp(app: NestExpressApplication, options: { swagger?: boolean } = {}): void {
  const config = app.get(AppConfig);

  app.useLogger(app.get(Logger));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { extended: false, limit: '100kb' });
  app.enableCors({
    origin: config.env.CORS_ORIGINS,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', IDEMPOTENCY_HEADER, REQUEST_ID_HEADER, 'If-Match'],
    exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
  });
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health/live', method: RequestMethod.GET },
      { path: 'health/ready', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();

  if (options.swagger ?? config.env.SWAGGER_ENABLED) setupSwagger(app);
}

export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(`${APP_NAME} API`)
      .setDescription(
        'B2B service marketplace REST API. All responses use the `{ success, data, meta }` / `{ success: false, error }` envelope. ' +
          'Money is integer paise. Endpoints marked idempotent require an `Idempotency-Key` header.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addGlobalParameters({
        name: REQUEST_ID_HEADER,
        in: 'header',
        required: false,
        schema: { type: 'string' },
      })
      .build(),
  );
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/docs-json' });
}
