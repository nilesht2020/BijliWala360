import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads a local `.env` file for development (Node 22 built-in, no dotenv dependency).
 * Looks in the current directory, then the repository root. Real environment variables win.
 */
export function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'production') return;
  for (const candidate of [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')]) {
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
  }
}
