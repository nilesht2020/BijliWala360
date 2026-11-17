import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig } from './core/config/app-config';
import { loadDotEnv } from './core/config/load-env';

async function bootstrap(): Promise<void> {
  loadDotEnv();
  // rawBody is required for webhook HMAC verification (FR-WHK-01).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  configureApp(app);
  const port = app.get(AppConfig).env.PORT;
  await app.listen(port);
}

void bootstrap();
