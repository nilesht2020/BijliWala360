import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { loadDotEnv } from '../core/config/load-env';
import { CliModule } from './cli.module';

loadDotEnv();

/**
 * Creates every index declared on the Mongoose schemas (DATABASE §1). The schemas are the single
 * source of truth for indexes; production runs with autoIndex disabled, so this command runs as a
 * release step before new code is rolled out. It never drops indexes.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn', 'log'] });
  const logger = new Logger('sync-indexes');
  const connection = app.get<Connection>(getConnectionToken());
  for (const model of Object.values(connection.models)) {
    await model.createCollection().catch(() => undefined);
    await model.createIndexes();
    logger.log(`Indexes ensured for ${model.collection.collectionName}`);
  }
  await app.close();
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
