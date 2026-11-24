import { z } from 'zod';

/**
 * Infrastructure/secrets configuration only. Business configuration lives in the
 * BusinessConfig store (ARCHITECTURE §6.9) and must never be added here.
 */
const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: bool.default(false),

  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  MONGO_URI: z.string().min(1),
  DB_TXN_MAX_RETRIES: z.coerce.number().int().min(0).max(20).default(5),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  /** `queue` = BullMQ on Redis (production). `inline` = in-process jobs for development without Redis. */
  QUEUE_MODE: z.enum(['queue', 'inline']).default('queue'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_ISSUER: z.string().default('bijliwala'),
  REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),

  /** Base64-encoded 32-byte keys, versioned: "1:<b64>,2:<b64>". Highest version encrypts. */
  FIELD_ENCRYPTION_KEYS: z.string().min(1),
  /** Secret for searchable HMAC hashes (ID numbers, mobiles). */
  HASH_PEPPER: z.string().min(32),

  /** `s3` = S3-compatible object storage. `local` = files on disk behind signed dev URLs (development only). */
  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  LOCAL_STORAGE_DIR: z.string().default('.local-storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_BUCKET: z.string().min(1).default('bijliwala-private'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),

  /** `clamav` = scan uploads with clamd. `none` = file-type checks only (development only). */
  SCANNER: z.enum(['clamav', 'none']).default('clamav'),
  /** Development only: every mobile OTP is this code and it is echoed to the sign-in page. Refused in production. */
  DEV_FIXED_OTP: z
    .string()
    .regex(/^\d{6}$/, 'DEV_FIXED_OTP must be 6 digits')
    .optional(),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  SMS_PROVIDER: z.enum(['console']).default('console'),
  WHATSAPP_PROVIDER: z.enum(['console']).default('console'),
  EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
  SMTP_URL: z.string().optional(),
  EMAIL_FROM: z.string().default('BijliWala360 <no-reply@bijliwala.local>'),

  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  SWAGGER_ENABLED: bool.default(true),

  /** Public URL of the web app, used in emailed links (password set/reset). */
  WEB_BASE_URL: z.string().url().default('http://localhost:5173'),
  /** Shared secret for SMS/WhatsApp delivery-status webhooks (X-Webhook-Token header). */
  NOTIFICATION_WEBHOOK_TOKEN: z.string().min(16).optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Development conveniences that must never reach production. */
function productionGuards(env: Env): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];
  if (env.QUEUE_MODE !== 'queue') problems.push('QUEUE_MODE must be "queue" in production');
  if (env.STORAGE_DRIVER !== 's3') problems.push('STORAGE_DRIVER must be "s3" in production');
  if (env.SCANNER !== 'clamav') problems.push('SCANNER must be "clamav" in production');
  if (env.DEV_FIXED_OTP) problems.push('DEV_FIXED_OTP must not be set in production');
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.RAZORPAY_WEBHOOK_SECRET) {
    problems.push(
      'RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are required in production',
    );
  }
  return problems.map((p) => `  - ${p}`);
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const guards = productionGuards(parsed.data);
  if (guards.length) throw new Error(`Invalid production configuration:\n${guards.join('\n')}`);
  return parsed.data;
}
