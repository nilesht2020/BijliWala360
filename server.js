/**
 * Production entry point for hosting Bijli Wala as ONE Node.js app.
 *
 * Starts the NestJS API (apps/api/dist) and serves the built React web app (apps/web/dist) from the
 * same server, so the browser calls `/api/v1` on the same origin (no CORS or proxy needed).
 *
 * Build first, from the repository root:   pnpm install && pnpm build
 * Then start:                              node server.js
 *
 * Configuration comes from environment variables (MONGO_URI, JWT_*, PORT, ...). Outside production
 * a `.env` file in the repository root is also read.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const apiDist = join(root, 'apps/api/dist');
const webDist = join(root, 'apps/web/dist');

if (!existsSync(join(apiDist, 'app.module.js'))) {
  console.error('API build not found in apps/api/dist. Run "pnpm install && pnpm build" first.');
  process.exit(1);
}

// The API is CommonJS and its dependencies live in apps/api/node_modules, so load them from there.
const requireFromApi = createRequire(join(root, 'apps/api/package.json'));
requireFromApi('reflect-metadata');
const { NestFactory } = requireFromApi('@nestjs/core');
const express = createRequire(requireFromApi.resolve('@nestjs/platform-express'))('express');
const { AppModule } = requireFromApi('./dist/app.module.js');
const { configureApp } = requireFromApi('./dist/bootstrap.js');
const { AppConfig } = requireFromApi('./dist/core/config/app-config.js');
const { loadDotEnv } = requireFromApi('./dist/core/config/load-env.js');

process.chdir(root); // so loadDotEnv() finds ./.env and relative paths (e.g. .local-storage) resolve from the repo root

async function start() {
  loadDotEnv();
  // rawBody is required for webhook HMAC verification (FR-WHK-01).
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  configureApp(app);

  if (existsSync(join(webDist, 'index.html'))) {
    const isApiPath = (path) => path.startsWith('/api/') || path === '/api' || path.startsWith('/health/');
    // Hashed asset files can be cached for a long time; index.html must never be cached.
    app.use(
      express.static(webDist, {
        index: false,
        setHeaders: (res, file) => {
          if (file.includes(`${join('dist', 'assets')}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        },
      }),
    );
    // Single-page app: any other GET page request gets index.html and React Router takes over.
    app.use((req, res, next) => {
      if (req.method !== 'GET' || isApiPath(req.path) || !req.accepts('html')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  } else {
    console.warn('Web build not found in apps/web/dist; serving the API only.');
  }

  const port = app.get(AppConfig).env.PORT;
  await app.listen(port);
  console.log(`Bijli Wala running on http://localhost:${port}`);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
