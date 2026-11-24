---
name: dev-test-data
description: Create sample accounts and records in the running local Bijli Wala app (technician/professional, company client with a registered company, vendor) through the real API using the fixed dev OTP. Use when asked to seed, create test users, set up demo data, or when a manual check needs a signed-in user.
---

# Dev test data

This needs the stack running (`run-app` skill). Everything goes through the public API on `http://localhost:5173/api/v1` (the Vite proxy), the same way the browser does. The data lands in the dev database `bijliwala` on 27117. **Never run this against anything but localhost.**

## Quick seed
```bash
bash .claude/skills/dev-test-data/seed.sh                 # default sample set
bash .claude/skills/dev-test-data/seed.sh professional +919800000101 "Ravi Electrician"
bash .claude/skills/dev-test-data/seed.sh company      +919800000201 "Asha Facilities"
bash .claude/skills/dev-test-data/seed.sh vendor       +919800000301 "Kumar Contractors"
```
The script:
- requests an OTP, verifies `123456`, and signs up the user type if the number is new (or just signs in)
- for `company`, also creates the company with a valid PAN/GSTIN pair for Maharashtra (state code 27)
- prints the user's name and roles

Re-running it with the same number is safe; it signs in instead.

## Rules
- Mobile numbers must be E.164 (`+91XXXXXXXXXX`). Use the `+9198000001xx` range for seed data, so it is easy to spot.
- PAN format is `ABCDE1234F`. The GSTIN must be `<stateCode><PAN>1Z5`, and its state code must match `billingAddress.stateCode`.
- Admin accounts cannot use OTP. For the admin, use `cli:create-admin` (see `run-app`), which needs TOTP on sign-in.
- Don't print access tokens or secrets in the reply. Tell the user the mobile number and that the OTP is `123456`.
- After seeding, list what was created so the user can sign in at http://localhost:5173/login.
