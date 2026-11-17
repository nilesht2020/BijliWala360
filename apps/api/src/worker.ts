import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createServer } from 'node:http';
import { Logger } from 'nestjs-pino';
import { AppConfig } from './core/config/app-config';
import { loadDotEnv } from './core/config/load-env';
import { WorkerModule } from './worker.module';

/** Worker process entry point: no public HTTP API, only a liveness endpoint for orchestration. */
async function bootstrap(): Promise<void> {
  loadDotEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const port = app.get(AppConfig).env.WORKER_HEALTH_PORT;
  const server = createServer((req, res) => {
    const ok = req.url === '/health/live';
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok ? { status: 'ok' } : { status: 'not_found' }));
  });
  server.listen(port);

  const shutdown = async () => {
    server.close();
    await app.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void bootstrap();
