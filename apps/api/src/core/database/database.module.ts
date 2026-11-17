import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfig } from '../config/app-config';
import { CORE_SCHEMAS } from './core.schemas';
import { SequenceService } from './sequence.service';
import { TransactionRunner } from './transaction-runner';

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        uri: config.env.MONGO_URI,
        // Indexes are created by migrations (DATABASE §1); allow auto-indexing only outside production.
        autoIndex: !config.isProduction,
        retryWrites: true,
        w: 'majority',
      }),
    }),
    MongooseModule.forFeature([...CORE_SCHEMAS]),
  ],
  providers: [TransactionRunner, SequenceService],
  exports: [MongooseModule, TransactionRunner, SequenceService],
})
export class DatabaseModule {}
