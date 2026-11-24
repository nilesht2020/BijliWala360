---
name: run-app
description: Start the Bijli Wala app locally (MongoDB replica set on 27117, NestJS API on 3000, Vite web on 5173), create the dev Super Admin, and smoke-test it. Use when asked to run, start, restart or launch the app, or before manually checking a change in the real app.
---

# Run Bijli Wala locally

This machine has no Docker, so the stack runs directly on Windows. `.env` is already set up for no-Docker mode: `QUEUE_MODE=inline`, `STORAGE_DRIVER=local`, `SCANNER=none` and `DEV_FIXED_OTP=123456`. **Redis is not installed.** `/health/ready` will report `degraded` with `redis: down`; that is expected and harmless.

## 1. MongoDB replica set (port 27117)
The API needs a replica set (it uses transactions). `MONGO_URI` in `.env` points to `127.0.0.1:27117`, replica set `testset`, database `bijliwala`.
- **Do not use** the Windows MongoDB service on 27017. It is a standalone server, not a replica set.
- Start it with the bundled script. It starts mongod from the mongodb-memory-server cache, waits for it, and initiates the replica set on first run (safe to repeat):
  ```bash
  bash .claude/skills/run-app/start-mongo.sh        # run with run_in_background: true
  ```
  Data lives in `%LOCALAPPDATA%\bijliwala\mongo-data`, so it survives restarts. The script caps the WiredTiger cache at 0.25 GB because this machine runs low on memory.

## 2. API and web (separate background shells)
```bash
pnpm build:contracts   # only if packages/contracts changed since the last build
pnpm dev:api           # http://localhost:3000, Swagger at /api/docs
pnpm dev:web           # http://localhost:5173, proxies /api to the API
```
Wait until both respond, using one `until` loop rather than polling the logs:
```bash
until curl -s -m 2 http://localhost:3000/health/ready | grep -q '"mongo":"up"' && \
      [ "$(curl -s -m 2 -o /dev/null -w '%{http_code}' http://localhost:5173)" = 200 ]; do sleep 2; done
```

## 3. Dev Super Admin (once per database)
Check first: `node` with `require('mongoose').mongo` lists `users` with `userType: 'ADMIN'`. If there are none:
```bash
pnpm --filter @bijliwala/api build
E=$(grep '^DEV_ADMIN_EMAIL=' .env | cut -d= -f2-); P=$(grep '^DEV_ADMIN_PASSWORD=' .env | cut -d= -f2-)
ADMIN_EMAIL="$E" ADMIN_NAME="Super Admin" ADMIN_PASSWORD="$P" pnpm --filter @bijliwala/api cli:create-admin
```
- **Never** `source .env`: the `EMAIL_FROM=Bijli Wala <...>` line breaks bash.
- **Never** print `DEV_ADMIN_PASSWORD` or any other secret from `.env`.
- The admin signs in at `/admin/login` and enrolls TOTP on first sign-in.

## 4. Drive it (don't just launch it)
- **Browser:** if the Claude in Chrome extension is connected, open http://localhost:5173 in a new tab and take a screenshot.
- **Otherwise,** use the API through the web proxy. For sample accounts, use the `dev-test-data` skill.
- Mobile numbers must be E.164 (`+919876543210`). The OTP is always `123456`, and `otp/request` also returns `devCode`.

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Background shells get killed "because the system is running low on memory" | Claude Code reaps idle background shells under memory pressure. Don't restart on your own; tell the user. Suggest running the three commands in their own terminals, or starting Claude Code with `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`. |
| API exits with a Mongo "not primary" / transaction error | The replica set isn't initiated. Rerun `start-mongo.sh`. |
| `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` on install | Use `CI=true pnpm install --no-frozen-lockfile`. |
| `VALIDATION_FAILED` on `mobile` | Use E.164 format with `+91`. |
| After an API code change: `EADDRINUSE :::3000` in the dev:api log, and new routes return 404 | On Windows, `nest start --watch` sometimes leaves the old `node ... apps\api\dist\main` process running. Stop the dev:api task, find the PID with `Get-NetTCPConnection -LocalPort 3000 -State Listen`, check its command line is `apps\api\dist\main`, `Stop-Process` it, then start `pnpm dev:api` again. |
