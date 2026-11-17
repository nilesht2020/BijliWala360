import { Global, Module } from '@nestjs/common';
import { validateEnv, type Env } from './env.schema';

/** Injection token wrapper so services can `constructor(private readonly config: AppConfig)`. */
export class AppConfig {
  constructor(readonly env: Env) {}

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  get isTest(): boolean {
    return this.env.NODE_ENV === 'test';
  }
}

@Global()
@Module({
  providers: [{ provide: AppConfig, useFactory: () => new AppConfig(validateEnv(process.env)) }],
  exports: [AppConfig],
})
export class AppConfigModule {}
