import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { emailSchema, passwordSchema } from '@bijliwala/contracts';
import { loadDotEnv } from '../core/config/load-env';
import { hashPassword } from '../core/crypto/password';
import { TransactionRunner } from '../core/database/transaction-runner';
import { RolesService } from '../modules/users/roles.service';
import { UsersService } from '../modules/users/users.service';
import { CliModule } from './cli.module';

/**
 * Bootstraps the first Super Admin (there is no other way to create one on a fresh install).
 * Reads ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD from the environment so the password never
 * appears in shell history or process lists. TOTP enrolment is enforced on first sign-in.
 *
 *   ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='...' pnpm --filter @bijliwala/api cli:create-admin
 */
async function main(): Promise<void> {
  loadDotEnv();
  const email = emailSchema.parse(process.env.ADMIN_EMAIL);
  const name = (process.env.ADMIN_NAME ?? 'Super Admin').trim();
  const password = passwordSchema.parse(process.env.ADMIN_PASSWORD);

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    const users = app.get(UsersService);
    const roles = app.get(RolesService);
    await roles.seedSystemRoles();
    if (await users.findByEmail(email)) throw new Error(`A user with email ${email} already exists.`);
    const user = await app.get(TransactionRunner).run(async (session) => {
      const created = await users.createAdmin({ name, email }, session);
      await roles.grant(
        created._id.toHexString(),
        { roleCode: 'SUPER_ADMIN', scope: { type: 'PLATFORM' } },
        { system: 'cli:create-admin' },
        undefined,
        session,
      );
      return created;
    });
    await users.setPasswordHash(user._id, await hashPassword(password));
    process.stdout.write(
      `Super Admin created: ${email}. Sign in at /admin/login and set up your authenticator app.\n`,
    );
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
