---
name: quality-gates
description: Run the Bijli Wala quality gates (contracts build, typecheck, ESLint, Prettier, contracts/API/web tests) and report results. Use after any code change, before saying work is done, before a commit or PR, or when asked to "verify", "check", "run tests" or "make sure it passes".
---

# Quality gates

Run from the repo root (`D:\Git_Repo\BijliWala`). These mirror the README's "Quality gates" and the deleted CI workflow.

## Order (stop and fix at the first real failure)
1. **Contracts first.** Apps import the built `dist`:
   ```bash
   pnpm build:contracts
   ```
2. **Types:**
   ```bash
   pnpm typecheck
   ```
3. **Lint and format:**
   ```bash
   pnpm exec eslint apps/api/src apps/api/test apps/web/src packages/contracts/src
   pnpm format:check
   ```
   If Prettier flags files you touched, run `pnpm exec prettier --write <files>`. Only reformat files you changed.
4. **Tests:**
   ```bash
   pnpm --filter @bijliwala/contracts test
   pnpm --filter @bijliwala/web test
   pnpm --filter @bijliwala/api test      # about 75 s; run it with run_in_background
   ```
   - The API tests start an in-memory MongoDB replica set and mock Redis, so they need no running services.
   - Filter the output with `grep -E "^Tests:|^Test Suites:|✕|FAIL"`. The log is noisy with `ECONNRESET` / Redis warnings at teardown; those are normal.

## Scoping
- Changed only `apps/web`: run typecheck, eslint on `apps/web/src`, and the web tests.
- Changed `packages/contracts`: run **everything**, since both apps depend on it.
- A single test file: `cd apps/web && npx vitest run src/routes/x.test.tsx`, or `cd apps/api && npx jest test/modules/x.int-spec.ts --runInBand --forceExit`.

## Known flake
`src/routes/company/demand.test.tsx` › "asks a new company user to register…" sometimes exceeds the 1 s `findByText` timeout on a cold run. Rerun that file once. If it passes, report it as a timing flake, not a failure. If it fails twice, investigate.

## Reporting
Give the pass/fail counts per suite (for example "API 193/193"). Quote real failures with the assertion message. Never claim green without having run the step.
