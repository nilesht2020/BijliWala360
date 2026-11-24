# Software Requirements Specification
## Bijli Wala — Pan-India Technical Manpower Supply, Workforce Management & Advertising Platform

| Field | Value |
|---|---|
| Document | Software Requirements Specification (SRS) |
| Version | 2.0 (Draft for sign-off) |
| Date | 2026-11-18 |
| Primary source | `docs/bijli wala .docx` (Project Requirement Document v1.0). Where this SRS and that document disagree, the requirement document wins and this SRS must be corrected. |
| Status | Draft. Section 13 lists the v1 assumptions; Section 20 lists the decisions still open for v2. |

### Version 2.0 changes
- The product is renamed from SkillConnect to **Bijli Wala**.
- The scope now follows the Bijli Wala requirement document. It has three independent but connected business modules:
  - **Module A**: technical manpower registration and supply.
  - **Module B**: client manpower booking.
  - **Module C**: third-party advertising.
- Sections 1–13 keep their numbering and requirement IDs, because code comments and the test traceability matrix refer to them. They are updated where the requirement document changes them.
- Sections 14–20 are new:
  - Requirements the document adds: technician registration steps, work orders, payroll, client billing, advertising, CMS, geography, departments and the website structure.
  - Acceptance criteria and handover.
  - A section-by-section traceability matrix back to the requirement document.
- **Changes from v1.0:**
  - **Payroll** for deployed employees is now in scope (Section 16). It was out of scope as A-01 and in Section 12.
  - **Work orders** are now first-class records.
  - Clients can **request a revision** of a quotation.
  - The technician registration gains a **declaration step** and an **Employee ID**.
  - A **third-party advertising marketplace**, a **website CMS**, **geography masters** (states, districts, cities, PIN codes) and **departments with state- and city-scoped permissions** are added.

---

## 1. Introduction

### 1.1 Purpose
This document sets out the functional and non-functional requirements for Bijli Wala. Bijli Wala is a Pan-India technical manpower outsourcing and industrial advertising management platform. Bijli Wala registers, verifies, manages and supplies technical manpower to organisations across India. Examples are electricians, electrical engineers, plumbers, HVAC technicians, civil engineers and other technical staff. They can be registered individually or through vendors and contractors who manage a team.

The company acts as the central manpower service provider. When a client submits a manpower requirement, the operations team does the following:
- identifies suitable registered employees
- prepares a quotation and work order
- deploys the employees
- manages their attendance and duty records
- bills the client under the agreed commercial terms

The platform also earns advertising revenue. It sells dynamic banner placements to brands selling electrical, plumbing, HVAC, civil, construction, safety and industrial products. It is a complete business management system, not just a registration website or static dashboard.

This document is the source of truth for the architecture, database design, API contract, development plan and test plan.

### 1.2 Scope
Bijli Wala provides three business modules.

**Module A — Technical manpower registration and supply**
- Step-by-step registration, verification and activation of technical professionals across India. Examples: electrical engineers, electricians, supervisors, plumbers, pipe fitters, civil, mechanical and HVAC engineers, AC, fire-safety, lift and CCTV technicians, welders, carpenters, masons, network engineers and other maintenance staff.
- Technicians register either as individual professionals or as workers of a registered vendor.
- An employee dashboard covering profile, work offers, assignments, availability, attendance, earnings and payslips.

**Module B — Client manpower booking**
- Registration of corporate clients. Examples: commercial buildings, government contractors, construction companies, factories, industrial plants, hospitals, hotels, malls, offices, warehouses, infrastructure projects, and facility-management and MEP contractors.
- Requirement submission for anything from one employee to hundreds.
- Quotation with approval or revision, work order, admin-controlled allocation, deployment, attendance, payroll, client billing, invoices, payments, refunds and reconciliation.

**Module C — Third-party advertising**
- Advertiser registration.
- Super-Admin-defined ad slots on any page.
- Campaign packages: fixed daily, weekly or monthly, CPC and CPM.
- Creative upload and preview, and admin approval.
- Razorpay payment verified by webhook.
- Automatic scheduling, delivery, expiry and analytics.

**Platform services across all modules**
- Super Admin control.
- Dynamic roles and permissions, scoped by department, state and city.
- Geography masters.
- Website CMS.
- Notifications through WhatsApp, SMS, email, in-app and push.
- Complaints, reports and a full audit trail.

**Client surfaces**
1. **Public website**: the pages in Section 19.1, managed through the CMS.
2. **Login portals**: Employee (technician), Client, Vendor, Advertiser and Admin. After sign-in, each user is sent to the dashboard for their role.
3. **Mobile-first employee workflows**: registration, work offers, attendance and payslips on a smartphone browser. Native apps come later; the API must support them.

### 1.3 Definitions

| Term | Definition |
|---|---|
| Company / Client | A business organisation that buys services through the platform. |
| Provider | Either an Individual Professional or a Vendor. |
| Individual Professional | A self-employed skilled person who registers and works in their own name. |
| Vendor | A contractor or agency organisation that registers once and supplies multiple workers. |
| Vendor Worker | A person employed or managed by a Vendor. Workers are onboarded under the vendor's registration. |
| Service Category | A hierarchical classification of services, for example Electrical → Industrial Wiring. |
| Skill | A specific competency tagged on providers and required by jobs. |
| Registration Plan | A configurable one-time fee plan that applies to a provider type. |
| Enquiry | A company's request for a service before it is priced. |
| Quotation | A priced offer that the platform sends to a company in response to an enquiry. |
| Job | A confirmed unit of work, created from an accepted quotation or directly by an admin. |
| Position / Requirement Line | A line on a job that says how many workers with a given skill are needed, for example 4 × Electrician (HT certified). |
| Matching | System scoring and ranking of eligible providers for a job. |
| Invitation | An offer sent to a professional or vendor to express interest in a job. |
| Invitation Response | A provider's reply to an invitation: interested with availability, declined, or, for vendors, interested with an offered headcount. |
| Allocation Proposal | A draft set of candidate-to-position allocations that an admin assembles and that needs approval. |
| Assignment | A confirmed engagement of a specific person (a professional or a vendor worker) on a job. Created **only** when an allocation proposal is approved. |
| Commitment | A time window in which a person is already assigned. Used to prevent double-booking. |
| Registration Payment | The one-time fee a provider pays to register. It is kept separate from business payments. |
| Business Payment | Money a company pays for services, recorded against an invoice. |
| Reconciliation | Matching recorded payments against gateway settlements or bank statements, and against invoices. |
| Technician / Employee | The requirement document's term for a technical professional registered on the platform. It means either an Individual Professional or a Vendor Worker. Each has an **Employee ID**. |
| Client / Manpower Buyer | The requirement document's term for a Company. |
| Requirement | The requirement document's term for a client's manpower request. Implemented as an **Enquiry**, and shown to clients with a Requirement ID. |
| Project | The requirement document's term for confirmed work at a client site. Implemented as a **Job**, and shown with a Project ID. |
| Work Order | A signed-off commercial instrument generated after quotation approval. It covers client, project, headcount by category, billing rates, duty hours, duration, payment, overtime and replacement terms, taxes and signatures. Every assignment references one. |
| Payroll | The calculation and recording of wages payable to deployed employees. It is kept separate from client billing. |
| Advertiser | A manufacturer, distributor, dealer or supplier that buys advertising placements. |
| Ad Slot | A configurable placement on a page and section, with device, dimension, format, pricing and approval rules. |
| Ad Package | A priced offer for a slot: fixed daily, weekly or monthly, CPC or CPM. Prices come from configuration and are never hardcoded. |
| Campaign | An advertiser's purchase of one or more slots, with creatives, targeting, dates and budget. |
| Department | An internal organisational unit, for example HR or Finance, used to group users and permissions. |

### 1.4 References
- **`docs/bijli wala .docx`: the Bijli Wala Project Requirement Document v1.0, the primary source.**
- Business decisions supplied by the product owner (provider model, registration fee, allocation and payments).
- Razorpay Orders, Payments, Refunds and Webhooks API documentation.
- WhatsApp Business Cloud API documentation.
- Indian GST invoicing rules (for invoice format).
- Digital Personal Data Protection Act, 2023 (India).

---

## 2. Overall Description

### 2.1 Product Perspective
Bijli Wala is a new, standalone system built as a modular monolith with a single deployable backend. It integrates with these external services:

| System | Purpose |
|---|---|
| Razorpay | Online registration fees and business payments, refunds and webhooks. |
| WhatsApp Business API | Template-based transactional notifications. |
| SMS provider (DLT-registered) | OTP delivery and fallback notifications. |
| Email (SMTP or transactional provider) | Invoices, receipts and account emails. |
| S3-compatible object storage | Documents, images, invoices, attendance photos and ad creatives. Private buckets, with a CDN for public website media. |
| Google Maps | Site geocoding, distance for matching, and attendance geofence display. |
| PDF and Excel generation | Quotations, work orders, invoices, payslips and report exports. |

### 2.2 User Classes and Roles

| Role | Surface | Description |
|---|---|---|
| Super Admin | Admin | Full access, including system configuration and role management. |
| Operations Admin | Admin | Manages enquiries, quotations, jobs, matching, invitations and allocation proposals. |
| Allocation Approver | Admin | Approves or rejects allocation proposals. May be the same person as Operations Admin if configured; see BR-ALC-07. |
| Verification Officer | Admin | Reviews provider documents and profiles, and approves or rejects registrations. |
| Finance Admin | Admin | Registration fees, invoices, verification of offline payments, refunds and reconciliation. |
| Support Agent | Admin | Handles complaints. Read-only access to related records. |
| Company Admin | Company | Manages the company profile, users, enquiries, quotations, jobs, payments and complaints. |
| Company User | Company | Raises enquiries and views jobs and attendance for their own sites. Restricted access to finance. |
| Individual Professional | Provider | Manages their own profile, documents and registration, responds to invitations, and records attendance. |
| Vendor Admin | Provider | Manages the vendor profile, workers and registration, responds to invitations with capacity, and manages assignments. |
| Vendor Worker | Provider (light) | Optional OTP login to view their own assignments and mark attendance. Cannot respond to invitations. |
| Advertiser Admin | Advertiser | Manages the advertiser profile, campaigns, creatives, payments and invoices, and views analytics. |
| Advertiser User | Advertiser | Creates and edits campaigns. Restricted access to payments. |
| Department staff | Admin | Custom roles for Recruitment, HR, Operations, Sales, Client Relations, Finance, Advertising, Customer Support, Legal/Compliance and IT/System Administration. Each role can be limited to particular states or cities (Section 18). |

Permissions are defined as fine-grained permission codes, for example `allocation.approve`. Roles are configurable bundles of these codes. The Super Admin can create unlimited custom roles. Permission actions are View, Create, Edit, Delete, Approve, Reject, Export, Download, Assign, Suspend and Manage.

### 2.3 Operating Environment
- Backend: Node.js LTS, NestJS, MongoDB replica set (required for transactions), Redis and BullMQ.
- **Stack deviation from the requirement document (§12):** the document recommends Next.js, PostgreSQL and Prisma. Bijli Wala keeps the stack already built: a React (Vite) SPA, NestJS and MongoDB with Mongoose. Reasons:
  - Phases 1–4 are delivered on this stack.
  - MongoDB replica-set transactions meet the integrity needs for allocation and finance.
  - The requirement document allows "PostgreSQL or an equivalent reliable database".

  The data model is still normalised by reference, with unique identifiers, indexes, and created/updated/created-by fields on every important record (§11 of the document). SEO for public pages is open item O-01 (Section 20).
- Frontend: React SPA running in current versions of Chrome, Edge, Safari and Firefox, and in mobile browsers on Android 10+ and iOS 15+.
- Deployment: Docker containers with separate API and worker processes.
- Locale: India first. Currency is INR, the time zone is Asia/Kolkata for display and data is stored in UTC. English is the UI language in the MVP, and the i18n structure is ready for Hindi.

### 2.4 Design and Implementation Constraints
- The technology stack is fixed (see the project brief).
- MongoDB multi-document transactions are used for allocation and financial operations.
- No business configuration may be hardcoded. This covers fees, tax rates, matching weights, invitation expiry, notification templates, cancellation windows and similar values.
- WhatsApp messages must use pre-approved templates.
- SMS must follow India's DLT regulations (registered sender ID and templates).

### 2.5 Assumptions and Dependencies
- Razorpay merchant account, WhatsApp Business account and DLT registration are available before UAT.
- Background verification (police checks and similar) is done manually by the Verification Officer in the MVP. There is no third-party KYC API.
- The platform invoices companies directly. Wages for deployed employees are calculated and recorded through payroll (Section 16). Payroll is kept separate from client billing. The actual bank disbursement is recorded with a transaction reference; an automated payout API is out of scope (Section 12).

---

## 3. Functional Requirements: Authentication and Users

### 3.1 Authentication (AUTH)

| ID | Requirement |
|---|---|
| FR-AUTH-01 | Providers and company users register and log in with a mobile number and OTP. |
| FR-AUTH-02 | Admin users log in with email and password, and TOTP-based MFA is mandatory. |
| FR-AUTH-03 | Company users may also set a password for email login. |
| FR-AUTH-04 | OTPs are 6 digits, expire after a configurable time (default 5 minutes), allow at most a configurable number of verification attempts (default 5), and are rate-limited per number and per IP. Resend has a configurable cooldown (default 30 seconds). |
| FR-AUTH-05 | Successful login issues a short-lived JWT access token (default 15 minutes) and a rotating refresh token (default 30 days), stored hashed. Reusing a refresh token revokes the whole token family. |
| FR-AUTH-06 | Users can log out, which revokes the refresh token. Admins can force logout of any user. |
| FR-AUTH-07 | Password reset works by email link for admins and company users with passwords. |
| FR-AUTH-08 | Account lockout is temporary after a configurable number of failed attempts. |
| FR-AUTH-09 | All authentication events are written to the audit log: login, failure, OTP request, logout and token revocation. |

### 3.2 Users and RBAC (USR)

| ID | Requirement |
|---|---|
| FR-USR-01 | A single `User` identity holds credentials, contact details and status (`ACTIVE`, `SUSPENDED`, `DEACTIVATED`). |
| FR-USR-02 | Each user has one or more role assignments, scoped to the platform, a specific company or a specific vendor. |
| FR-USR-03 | The Super Admin manages roles and their permission codes. System roles cannot be deleted. |
| FR-USR-04 | Every API endpoint declares its required permission and scope check, which the server enforces. |
| FR-USR-05 | A mobile number and an email address are each unique across all users. |
| FR-USR-06 | Users can update their own profile. Changing the mobile number or email requires OTP or link verification. |

---

## 4. Functional Requirements: Provider Management and Registration

### 4.1 Individual Professionals (PRO)

| ID | Requirement |
|---|---|
| FR-PRO-01 | A professional profile holds full name, photo, date of birth, gender (optional), address, service location (geo point and travel radius in km), languages, years of experience, service categories, skills (each with a proficiency level and years), certifications, and bank details. Bank details are used for payouts outside the system and are stored encrypted. |
| FR-PRO-02 | The profile tracks completion percentage, and a profile cannot be submitted for verification until all mandatory fields and documents are present. |
| FR-PRO-03 | A professional maintains an **availability calendar**: recurring weekly availability plus specific blocked dates. |
| FR-PRO-04 | Profile lifecycle states: `DRAFT → PENDING_PAYMENT → PENDING_VERIFICATION → (CHANGES_REQUESTED ↔ PENDING_VERIFICATION) → APPROVED / REJECTED`, plus `SUSPENDED` and `DEACTIVATED`. |
| FR-PRO-05 | Only `APPROVED` professionals who are not suspended are eligible for matching and invitations. |
| FR-PRO-06 | After approval, editing verified fields (identity, certifications) sets those fields to pending re-verification. The professional stays approved for unaffected skills. |

### 4.2 Vendors (VEN)

| ID | Requirement |
|---|---|
| FR-VEN-01 | A vendor profile holds legal name, trade name, entity type, GSTIN (optional or mandatory per plan), PAN, registered address, operating locations (multiple geo points with radii), service categories, contact persons and bank details (encrypted). |
| FR-VEN-02 | A vendor has one or more Vendor Admin users. |
| FR-VEN-03 | The vendor lifecycle is the same as FR-PRO-04. |
| FR-VEN-04 | A vendor can be eligible for matching only when it is `APPROVED` and has at least one `ACTIVE`, verified worker. |

### 4.3 Vendor Workers (VWK)

| ID | Requirement |
|---|---|
| FR-VWK-01 | Vendor Admins add workers with name, mobile number (optional but recommended), photo, ID document, skills, experience, certifications and base location. |
| FR-VWK-02 | Workers are covered by the vendor's one-time registration. No separate worker fee applies unless the registration plan sets a worker cap (see FR-REG-03). |
| FR-VWK-03 | Each worker is verified by the Verification Officer. States: `PENDING_VERIFICATION`, `ACTIVE`, `REJECTED`, `INACTIVE`. |
| FR-VWK-04 | A person's identity is unique across the platform, using the hashed government ID number and the mobile number. The same person cannot be an active worker for two vendors at once, or be both an active professional and an active vendor worker. Conflicts go to the admin for resolution. |
| FR-VWK-05 | A worker has their own availability calendar and commitments, maintained by the vendor and reflected from assignments. |
| FR-VWK-06 | A vendor can deactivate a worker. Workers with future confirmed assignments cannot be deactivated until those assignments are replaced or cancelled. |

### 4.4 Service Categories and Skills (CAT)

| ID | Requirement |
|---|---|
| FR-CAT-01 | Admins manage a category tree with up to 3 levels. Each category has a name, slug, description, image, icon, display order, active flag and SEO fields. |
| FR-CAT-02 | Admins manage a skills master list, each skill linked to one or more categories, plus the mandatory documents or certifications for that skill, for example an electrical licence. |
| FR-CAT-03 | The public website lists active categories with large images and rounded cards. |
| FR-CAT-04 | A category cannot be deleted while it is in use. It is deactivated instead. |

### 4.5 Registration Plans (PLN)

| ID | Requirement |
|---|---|
| FR-PLN-01 | Admins define registration plans with: name, code, provider type (`PROFESSIONAL` or `VENDOR`), fee amount, GST rate, included features, maximum workers (vendors only, nullable meaning unlimited), mandatory document types, validity flag (`ONE_TIME`), active flag, and effective dates. |
| FR-PLN-02 | Several active plans may exist per provider type, for example Vendor Basic (up to 25 workers) and Vendor Enterprise (unlimited). |
| FR-PLN-03 | Changing a plan's price does not affect providers who have already paid. The plan's terms are snapshotted onto the provider's registration record. |
| FR-PLN-04 | **No recurring or annual renewal** in the MVP. |
| FR-PLN-05 | A vendor may upgrade its plan (for example to raise the worker cap) by paying the difference. Upgrades create a new registration payment linked to the original. |
| FR-PLN-06 | Admins may waive or discount a registration fee with a reason. The waiver is audited and requires the `registration.waive` permission. |

### 4.6 Registration Workflow (REG)

```
Mobile OTP → Account created → Choose provider type → Profile completion
→ Document upload → Select plan → Pay registration fee (Razorpay or offline)
→ Submit for verification → Verification Officer review
→ (Changes requested ↺) → Approved / Rejected → Notification
```

| ID | Requirement |
|---|---|
| FR-REG-01 | A provider chooses `PROFESSIONAL` or `VENDOR` after OTP verification. The choice cannot be changed after payment. |
| FR-REG-02 | The registration fee is paid online through Razorpay (Order, then Checkout, then signature verification, then webhook confirmation). Offline payment is possible only if the plan allows it, and requires Finance verification. |
| FR-REG-03 | If a vendor exceeds its plan's worker cap, it must upgrade before adding more active workers. |
| FR-REG-04 | Payment is required **before** verification review. An admin with `registration.waive` can override this. |
| FR-REG-05 | If a registration is rejected, the refund follows the configurable refund policy for that plan: full, partial or none. Refunds run through the Refunds flow. |
| FR-REG-06 | The Verification Officer sees a checklist for each document and field, and can approve, reject or request changes, with comments per item. |
| FR-REG-07 | Approval sets the provider to `APPROVED`, records the verifier, timestamp and checklist snapshot, and triggers a welcome notification. |
| FR-REG-08 | Registration payments are stored in a **separate collection and ledger** from business payments. |

### 4.7 Documents (DOC)

| ID | Requirement |
|---|---|
| FR-DOC-01 | Admins configure the supported document types: Aadhaar (masked), PAN, GST certificate, trade licence, skill certificate, police verification, cancelled cheque, and others. Each type defines its owner type, allowed MIME types, maximum size, whether it is mandatory, whether it has an expiry, and whether a number field is captured. |
| FR-DOC-02 | Uploads go through presigned URLs to private object storage. The backend validates MIME type by magic bytes, size and extension, and runs a virus scan (ClamAV or equivalent) before marking the document `UPLOADED`. |
| FR-DOC-03 | Files are never public. Downloads use short-lived presigned URLs and are authorised per request. |
| FR-DOC-04 | Document states: `PENDING_UPLOAD`, `UPLOADED`, `VERIFIED`, `REJECTED`, `EXPIRED`. |
| FR-DOC-05 | Sensitive ID numbers are stored encrypted, plus a hash for duplicate detection. Only the last 4 digits are displayed. Full Aadhaar numbers are never stored; masked Aadhaar images are required. |
| FR-DOC-06 | Documents that expire trigger reminders a configurable number of days before expiry. When a document expires, the affected skill or provider becomes ineligible for matching until it is renewed. |
| FR-DOC-07 | Re-uploading a document creates a new version. Previous versions are kept for audit. |

---

## 5. Functional Requirements: Companies, Enquiries and Quotations

### 5.1 Companies (CMP)

| ID | Requirement |
|---|---|
| FR-CMP-01 | A company registers with legal name, GSTIN (optional), PAN, billing address, industry, size, primary contact (OTP verified), and one or more **sites**, each with an address, geo point and site contact. |
| FR-CMP-02 | Company states: `PENDING_VERIFICATION`, `ACTIVE`, `SUSPENDED`. An admin activates a company after a basic KYC check. Enquiries are allowed while the company is pending; jobs are not. |
| FR-CMP-03 | A Company Admin invites company users and assigns them the Company Admin or Company User role, optionally restricted to specific sites. |
| FR-CMP-04 | Each company has configurable commercial terms: credit period in days, a credit limit (optional), whether offline payment is allowed, and whether an advance percentage is required. |

### 5.2 Enquiries (ENQ)

| ID | Requirement |
|---|---|
| FR-ENQ-01 | A company, a public visitor (as a lead) or an admin on behalf of a company can create an enquiry with: service category, required skills, headcount per skill, site, start date, duration or end date, shift timings, description, attachments and budget (optional). |
| FR-ENQ-02 | Enquiry states: `NEW → IN_REVIEW → QUOTED → ACCEPTED / REJECTED / EXPIRED / CANCELLED`. |
| FR-ENQ-03 | Operations Admins can assign an enquiry to themselves or another admin, and add internal notes. |
| FR-ENQ-04 | An enquiry raised by a public lead must be converted into a company account before it can be quoted. |

### 5.3 Quotations (QUO)

| ID | Requirement |
|---|---|
| FR-QUO-01 | Admins create quotations from enquiries. Line items have a description, skill, quantity (headcount), unit (per hour, day, month or fixed), rate, duration, tax rate and amount. Quotations also carry discounts, terms, validity date and payment terms (advance percentage, milestones). |
| FR-QUO-02 | Quotations are versioned. Revising a quotation creates version n+1 and supersedes the previous version. |
| FR-QUO-03 | Quotation states: `DRAFT → SENT → ACCEPTED / REJECTED / EXPIRED / SUPERSEDED`. |
| FR-QUO-04 | The company accepts or rejects in the portal. Acceptance records the user, timestamp and IP, and creates a job (FR-JOB-01). |
| FR-QUO-05 | A PDF of the quotation is generated and stored, and sent by email and WhatsApp. |
| FR-QUO-06 | Tax is calculated from configured GST rates. CGST and SGST apply when the supply is intra-state, and IGST when it is inter-state. |

---

## 6. Functional Requirements: Jobs, Matching, Invitations and Allocation

### 6.1 Allocation Lifecycle Overview
The platform must implement the following distinct, auditable stages. **No stage may be skipped, and an invitation response never directly creates an assignment.**

| # | Stage | Actor | Output |
|---|---|---|---|
| 1 | Job created | Admin or system (from quotation) | Job with positions, in `OPEN` |
| 2 | Matching executed | Admin triggers; system computes | Ranked candidate list (match run) |
| 3 | Invitations sent | Admin selects candidates | Invitations, `SENT` |
| 4 | Providers respond | Professional or Vendor Admin | Invitation response |
| 5 | Availability recorded | System | Availability snapshot on the response |
| 6 | Admin reviews candidates | Ops Admin | Shortlist |
| 7 | Allocation proposal created | Ops Admin | Proposal `DRAFT → PENDING_APPROVAL` |
| 8 | Capacity validated | System | Validation result; blocking errors prevent submission or approval |
| 9 | Proposal approved | Allocation Approver | Proposal `APPROVED` |
| 10 | Confirmed assignments created | System (atomic transaction) | Assignments `CONFIRMED` and commitments recorded |
| 11 | Notifications sent | System (queue) | WhatsApp, SMS and in-app messages to providers, workers and the company |

### 6.2 Jobs (JOB)

| ID | Requirement |
|---|---|
| FR-JOB-01 | A job is created from an accepted quotation, inheriting its positions, site, schedule and commercial terms, or manually by an admin for a company with `ACTIVE` status. |
| FR-JOB-02 | A job holds: job number (human-readable, unique), company, site, category, **positions** (skill, headcount required, minimum experience, required certifications, shift, rate), start and end dates, schedule pattern (dates and shift times), description, special instructions and status. |
| FR-JOB-03 | Job states: `DRAFT → OPEN → MATCHING → ALLOCATING → PARTIALLY_STAFFED → STAFFED → IN_PROGRESS → COMPLETED`, plus `ON_HOLD` and `CANCELLED`. Transitions are enforced by a state machine. |
| FR-JOB-04 | Each position tracks `required`, `proposed` (in pending proposals), and `confirmed` counts. `confirmed` must never exceed `required`. |
| FR-JOB-05 | Changes to a job's schedule or headcount after assignments exist require re-validation, and may create replacement or cancellation flows. |
| FR-JOB-06 | Cancelling a job cancels pending invitations and proposals, and cancels or ends assignments under the configured cancellation policy. |

### 6.3 Matching (MAT)

| ID | Requirement |
|---|---|
| FR-MAT-01 | Matching runs per job position and returns ranked candidates of two kinds: professionals, and vendors (with the count of each vendor's eligible workers). |
| FR-MAT-02 | **Hard filters** (exclusion): the provider is `APPROVED` and not suspended. For vendors, eligible workers are `ACTIVE` and verified. The provider has the required skill or category. Mandatory certifications and documents are valid and unexpired for the job period. The provider is within service radius of the site. The provider is available on the job dates (calendar). The provider has **no conflicting commitment** (assignment overlap). The provider is not on the company's blocked list. |
| FR-MAT-03 | **Soft scoring**: weighted sum of skill match and proficiency, distance, experience, performance rating, reliability (attendance rate and no-show rate), past work with the same company, and current workload. **Weights are configurable** by the Super Admin. |
| FR-MAT-04 | The weights and filters for each match run are stored as a snapshot (inputs, weights and results) for audit. |
| FR-MAT-05 | Admins can see the score breakdown, filter or sort the candidates, and manually add a provider who failed the soft criteria. Hard-filter failures can be overridden only for configurable reasons (for example distance), with a mandatory justification. Overrides are audited. Availability conflicts can never be overridden. |
| FR-MAT-06 | Matching for vendors counts eligible workers so that admins can see the maximum capacity a vendor could offer. |

### 6.4 Invitations (INV)

| ID | Requirement |
|---|---|
| FR-INV-01 | Admins send invitations to selected candidates from a match run, in bulk or individually. One invitation per provider per position is active at a time. |
| FR-INV-02 | An invitation includes: job summary (without the company's commercial rates), site area (exact address withheld until assignment), dates, shift, skill and rate offered to the provider (if configured), and response deadline (configurable, default 24 hours). |
| FR-INV-03 | Invitations are delivered by WhatsApp (with a deep link), SMS fallback and in-app message. |
| FR-INV-04 | Invitation states: `SENT → VIEWED → RESPONDED_INTERESTED / RESPONDED_DECLINED / EXPIRED / WITHDRAWN`. |
| FR-INV-05 | **Professional response**: interested or declined. If interested, the professional confirms availability for the job dates. They may mark partial availability for specific dates if the position allows it. A decline reason is optional. |
| FR-INV-06 | **Vendor response**: interested or declined. If interested, the vendor gives `offeredHeadcount` (at most its count of eligible workers) and, optionally, the specific workers it proposes. The system validates that the proposed workers are eligible and not committed. |
| FR-INV-07 | Responses are **idempotent**. Repeated submissions with the same idempotency key return the original result. Changing a response is allowed until the deadline or until the provider is included in an approved proposal, whichever comes first. Each change is versioned. |
| FR-INV-08 | **An invitation response never creates an assignment.** It only marks the candidate as interested and available for admin review. |
| FR-INV-09 | Admins can withdraw invitations. Expiry is processed by a scheduled job. |
| FR-INV-10 | When a provider responds, the response records an availability snapshot taken at that moment. This is stage 5. |

### 6.5 Allocation Proposals (ALC)

| ID | Requirement |
|---|---|
| FR-ALC-01 | Ops Admins create allocation proposals for a job. A proposal contains lines that each map a position to either a professional (from an interested response) or a specific vendor worker (from an interested vendor response). |
| FR-ALC-02 | A proposal may cover some or all positions, and several proposals may exist per job. The sum of headcount across confirmed and pending-approval proposals must not exceed the requirement. |
| FR-ALC-03 | Proposal states: `DRAFT → PENDING_APPROVAL → APPROVED / REJECTED`, plus `CANCELLED`. A rejected proposal can be cloned into a new draft. |
| FR-ALC-04 | The system validates at **submission and again at approval**: (a) each person is still eligible (status, documents and skills); (b) there is no overlapping commitment, either confirmed or held in another pending proposal; (c) the vendor has not exceeded its offered headcount; (d) the position's confirmed and proposed count stays at or below required; (e) the same person does not appear twice in the job; (f) the source invitation response is `INTERESTED` and not expired or withdrawn. |
| FR-ALC-05 | Validation results are returned for each line as blocking errors or warnings. Warnings, for example low rating, can be acknowledged; blocking errors cannot. |
| FR-ALC-06 | **Approval is atomic**: inside one MongoDB transaction, the proposal status changes from `PENDING_APPROVAL` to `APPROVED` through a conditional update, all lines are revalidated, assignments are created, commitments are inserted (enforced by a unique constraint per person per time slot, or by a conditional check), and position counters are incremented with a guard against exceeding the requirement. If any step fails, the whole approval rolls back and returns the reason. |
| FR-ALC-07 | Two approvers acting at the same time must not be able to over-allocate a position or double-book a person. Concurrency is resolved by optimistic versioning and conditional updates, and the loser receives a `409 CONFLICT`. |
| FR-ALC-08 | Notifications are queued **after the transaction commits** (outbox pattern), never inside it. |
| FR-ALC-09 | When a proposal is rejected, the reason is recorded, and the affected candidates remain available for other proposals. |

### 6.6 Assignments (ASG)

| ID | Requirement |
|---|---|
| FR-ASG-01 | An assignment links job, position, company, site, provider type, professional or (vendor and vendor worker), schedule (dates and shift times), agreed provider rate, source proposal and status. |
| FR-ASG-02 | Assignment states: `CONFIRMED → ACTIVE (on the first check-in) → COMPLETED`, plus `CANCELLED`, `REPLACED` and `NO_SHOW`. |
| FR-ASG-03 | Once an assignment is confirmed, the provider sees the full site address and site contact, and the company sees the assigned person's name, photo, skill and verification badge. Mobile numbers are revealed according to configuration. |
| FR-ASG-04 | **Replacement**: an admin can replace an assigned person. The replacement goes through the same proposal and approval flow, as a single-line "replacement proposal". On approval the old assignment becomes `REPLACED` and its commitment is released, in one transaction. |
| FR-ASG-05 | When a provider cancels after confirmation, an admin must act on it. The provider cannot cancel directly. They raise a cancellation request, which an admin approves, and the request affects their reliability score. |
| FR-ASG-06 | Commitments are released when an assignment is cancelled, replaced or completed early. |

### 6.7 Attendance (ATT)

| ID | Requirement |
|---|---|
| FR-ATT-01 | Assigned persons check in and check out from a mobile browser. Each event captures a timestamp (server time), GPS location and an optional selfie. |
| FR-ATT-02 | Check-in is validated against a geofence radius around the site (configurable). A check-in outside the geofence is flagged, not blocked. |
| FR-ATT-03 | A Vendor Admin may mark attendance for its workers when the workers have no login. These entries are tagged as proxy entries. |
| FR-ATT-04 | Company site users can confirm or dispute daily attendance. Disputes create complaints automatically. |
| FR-ATT-05 | Admins can correct attendance with a reason. Corrections are audited. |
| FR-ATT-06 | If no check-in exists by a configured threshold after shift start, the system raises a no-show alert to Ops and the vendor. |
| FR-ATT-07 | Attendance summaries (days, hours and overtime) feed invoicing when the job is billed on a time and materials basis. |

---

## 7. Functional Requirements: Business Payments and Finance

### 7.1 Invoices (INVC)

| ID | Requirement |
|---|---|
| FR-INVC-01 | Finance generates invoices for a job from one of these: quotation milestones (advance, interim, final), or attendance-based billing for a billing period. |
| FR-INVC-02 | Invoice numbers are sequential and gap-free per financial year, using a configurable prefix, for example `SC/2026-27/000123`. They are generated with an atomic counter. |
| FR-INVC-03 | Invoices are GST compliant and include GSTINs, HSN/SAC codes, place of supply and the tax split. A PDF is generated and stored. |
| FR-INVC-04 | Invoice states: `DRAFT → ISSUED → PARTIALLY_PAID → PAID`, plus `OVERDUE` (computed from the credit period), `CANCELLED` and `VOID`. Issued invoices cannot be edited; corrections use credit notes. |
| FR-INVC-05 | Credit notes reduce the payable amount on an invoice and are numbered separately. |

### 7.2 Business Payments (BPAY)

| ID | Requirement |
|---|---|
| FR-BPAY-01 | **Online**: a company pays one or more invoices through Razorpay. The system creates a Razorpay Order for the payable amount, the client completes Checkout, and the server verifies the signature. **The webhook (`payment.captured` / `order.paid`) is the source of truth** for marking the payment successful. |
| FR-BPAY-02 | **Offline**: the company or Finance records a payment with method (`BANK_TRANSFER`/NEFT/RTGS/IMPS, `CHEQUE`, `UPI_DIRECT`, `CASH` if enabled, `OTHER`), amount, date, reference number (UTR or cheque number), bank, and proof attachment. The state is `PENDING_VERIFICATION`. |
| FR-BPAY-03 | A Finance Admin with `payment.verify` verifies or rejects offline payments. The verifier cannot be the person who recorded the payment (maker-checker). Cheques move through `RECEIVED → DEPOSITED → CLEARED / BOUNCED`. |
| FR-BPAY-04 | Only **verified** or **captured** payments are allocated against invoices and change invoice balances. |
| FR-BPAY-05 | One payment may be allocated across several invoices, and one invoice may receive several payments. Allocations are stored explicitly. |
| FR-BPAY-06 | Payment states: `CREATED → PENDING / PENDING_VERIFICATION → SUCCESS / FAILED / REJECTED`, plus `PARTIALLY_REFUNDED` and `REFUNDED`. |
| FR-BPAY-07 | Duplicate offline references (the same UTR or cheque number and bank) are rejected or flagged. |
| FR-BPAY-08 | All monetary values are stored as integers in **paise**, with an explicit currency code. |
| FR-BPAY-09 | Every financial state change writes immutable **ledger entries** (double-entry style: receivable, cash or gateway clearing, refund payable). Updates to existing ledger entries are not allowed; corrections are reversing entries. |

### 7.3 Refunds (RFD)

| ID | Requirement |
|---|---|
| FR-RFD-01 | Finance initiates a refund against a successful payment, for the full or a partial amount, with a reason. Refunds above a configurable threshold need a second approver. |
| FR-RFD-02 | Online refunds go through the Razorpay Refunds API. Their status updates from the `refund.processed` and `refund.failed` webhooks. |
| FR-RFD-03 | Offline refunds are recorded with a reference and proof, and verified the same way as offline payments. |
| FR-RFD-04 | The total refunded for a payment can never exceed the captured amount. This is enforced atomically. |
| FR-RFD-05 | Refunds apply to both registration payments and business payments, each in its own domain. |

### 7.4 Webhooks and Idempotency (WHK)

| ID | Requirement |
|---|---|
| FR-WHK-01 | Razorpay webhooks are verified by HMAC signature using the raw request body. |
| FR-WHK-02 | Every webhook event is stored once, keyed by the event ID, with a unique index. Duplicate deliveries are acknowledged with `200` and not processed again. |
| FR-WHK-03 | Webhook processing is asynchronous. The endpoint stores the event and returns `200` quickly, and a BullMQ worker processes it with retries. |
| FR-WHK-04 | Status transitions are conditional and monotonic. An out-of-order event, such as `failed` arriving after `captured`, cannot downgrade a final state. |
| FR-WHK-05 | The system routes each event to the registration or business payment domain using the order's `notes.domain`, and the local order record. |

### 7.5 Reconciliation (REC)

| ID | Requirement |
|---|---|
| FR-REC-01 | **Gateway reconciliation**: a daily scheduled job fetches Razorpay payments and settlements for the previous day and matches them against local records by payment ID. Mismatches are reported: missing locally, missing at the gateway, amount mismatch or status mismatch. |
| FR-REC-02 | **Bank reconciliation**: Finance uploads a bank statement as CSV or XLSX, in a configurable column mapping. The system auto-matches statement lines to verified offline payments and Razorpay settlements, by reference, amount and date tolerance. Unmatched lines are matched manually. |
| FR-REC-03 | Each reconciliation run records its period, source, counts (matched, unmatched, exceptions), the user and its status. Exceptions are resolved with notes. |
| FR-REC-04 | **Invoice reconciliation**: receivables ageing, unapplied payments and over or under payments. |
| FR-REC-05 | Registration payments and business payments are reconciled as separate ledgers, with a combined gateway view for settlement matching. |

---

## 8. Functional Requirements: Notifications, Complaints, Reports and Audit

### 8.1 Notifications (NTF)

| ID | Requirement |
|---|---|
| FR-NTF-01 | Notification channels: WhatsApp, SMS, email and in-app (bell icon with unread count). |
| FR-NTF-02 | Notifications are driven by events, for example `invitation.sent`, `assignment.confirmed`, `payment.verified` and `registration.approved`. Each event maps to templates per channel and a channel priority order with fallback. |
| FR-NTF-03 | Templates are stored in the database with variables. WhatsApp templates reference the approved template name and language. |
| FR-NTF-04 | Notifications are sent through BullMQ queues with retry and exponential backoff, plus a dead-letter queue. The delivery status reported by provider webhooks is recorded. |
| FR-NTF-05 | Users can manage their preferences for non-critical notifications. Transactional and critical notifications (OTP, assignment, payment) cannot be disabled. |
| FR-NTF-06 | Quiet hours apply to non-urgent notifications and are configurable. |

### 8.2 Complaints (CMPL)

| ID | Requirement |
|---|---|
| FR-CMPL-01 | Companies, providers and admins can raise complaints linked to a job, assignment, payment or invoice, with a category, description, severity and attachments. |
| FR-CMPL-02 | Complaint states: `OPEN → IN_PROGRESS → RESOLVED → CLOSED`, plus `REOPENED`. Each complaint has an SLA timer per severity (configurable) and escalates when the SLA is breached. |
| FR-CMPL-03 | Complaints carry a comment thread, with internal-only notes for admins. |
| FR-CMPL-04 | A complaint against a provider that is resolved as valid affects that provider's performance score. |

### 8.3 Ratings and Performance (PERF)

| ID | Requirement |
|---|---|
| FR-PERF-01 | When an assignment is completed, the company rates the person from 1 to 5 stars with optional comments. The rating rolls up to the professional or to the vendor and worker. |
| FR-PERF-02 | The performance score is calculated from rating, attendance reliability, no-shows, valid complaints and cancellations, with configurable weights. A scheduled job recalculates it. |

### 8.4 Reports (RPT)

| ID | Report |
|---|---|
| FR-RPT-01 | Registration funnel: sign-ups, completed profiles, paid, verified and approved, by provider type. |
| FR-RPT-02 | Registration revenue by plan and period. |
| FR-RPT-03 | Job fulfilment: positions required vs. confirmed, time to staff, invitation response rate. |
| FR-RPT-04 | Provider utilisation and performance. |
| FR-RPT-05 | Attendance summary by job, site and company. |
| FR-RPT-06 | Receivables ageing, collections, refunds, and online vs. offline split. |
| FR-RPT-07 | Reconciliation exceptions. |
| FR-RPT-08 | Complaints by category, SLA compliance. |

All reports can be filtered by date, company, category and location, and exported to CSV or XLSX. Large exports run asynchronously and deliver a download link.

### 8.5 Audit Logs (AUD)

| ID | Requirement |
|---|---|
| FR-AUD-01 | Every state-changing action records: actor (user ID and role), action, entity type and ID, before and after differences (with sensitive fields redacted), IP address, user agent, request ID and timestamp. |
| FR-AUD-02 | Audit logs are append-only. The API has no update or delete operations for them, and they are retained for at least 7 years for financial entities. |
| FR-AUD-03 | Admins can search the audit log by entity, actor, action and date. |

### 8.6 System Configuration (CFG)

| ID | Requirement |
|---|---|
| FR-CFG-01 | All business configuration lives in a configuration store, editable by the Super Admin and audited. This covers OTP limits, invitation expiry, matching weights, geofence radius, SLA times, refund policies, tax rates, invoice prefix, notification fallbacks and cancellation windows. |
| FR-CFG-02 | Configuration values are cached in Redis and invalidated when they change. |

---

## 9. Business Rules

| ID | Rule |
|---|---|
| BR-REG-01 | Each provider entity pays its registration fee once. There is no renewal in the MVP. |
| BR-REG-02 | A vendor's registration covers all of its workers, up to the plan's worker cap. |
| BR-REG-03 | Unapproved providers cannot be matched, invited or assigned. |
| BR-PRV-01 | A natural person (identified by hashed ID and mobile number) may have only one active provider identity: either a professional or one vendor's worker. |
| BR-ALC-01 | Only admins create allocations. Providers cannot self-assign. |
| BR-ALC-02 | An invitation response, including "interested", never creates an assignment. |
| BR-ALC-03 | Assignments are created only by approving an allocation proposal. |
| BR-ALC-04 | A person cannot hold overlapping commitments. Overlap is checked at the date and shift level. |
| BR-ALC-05 | A position's confirmed count cannot exceed its required count. |
| BR-ALC-06 | A vendor cannot be allocated more workers than the headcount it offered in its response. |
| BR-ALC-07 | The proposal creator may not approve their own proposal when `allocation.requireSeparateApprover` is set (default `true`). |
| BR-FIN-01 | Registration and business payments are separate in collections, ledgers, reports and invoice numbering. |
| BR-FIN-02 | An offline payment affects balances only after it is verified. |
| BR-FIN-03 | Maker-checker applies to offline payment verification and to refunds above the threshold. |
| BR-FIN-04 | Financial records are never hard-deleted. |
| BR-FIN-05 | Amounts are stored in paise as integers. Rounding uses half-up rounding at line level. |

---

## 10. Non-Functional Requirements

### 10.1 Performance
| ID | Requirement |
|---|---|
| NFR-PERF-01 | p95 API latency under 300 ms for reads and under 600 ms for writes, at 100 concurrent users. |
| NFR-PERF-02 | A match run over 50,000 providers completes in under 3 seconds (using indexed geo and skill filters). |
| NFR-PERF-03 | Lists are paginated, with a default of 20 items and a maximum of 100. Cursor pagination is used for large collections. |
| NFR-PERF-04 | Approving a proposal with 50 lines completes in under 2 seconds. |

### 10.2 Scalability and Availability
- The API is stateless, so it scales horizontally. Workers scale independently.
- Target uptime is 99.5% for the MVP. MongoDB runs as a replica set (at least 3 nodes in production).
- Recovery targets: RPO of 15 minutes or less (point-in-time backup) and RTO of 4 hours or less.

### 10.3 Security
- OWASP ASVS Level 2 controls.
- TLS everywhere. Data is encrypted at rest at the database and storage level, and PII fields (bank account, ID numbers) are additionally encrypted at field level.
- Passwords are hashed with Argon2id or bcrypt (cost 12 or higher).
- Rate limiting is applied per IP and per user, and is strict on authentication and OTP.
- Inputs are validated with a whitelist using DTO validation. NoSQL injection protection rejects `$`-prefixed keys.
- CORS uses an allowlist. Helmet security headers are set. CSRF protection is unnecessary because tokens are sent as Bearer headers; if cookies are used for the refresh token, they are `HttpOnly`, `Secure` and `SameSite=Strict`.
- Secrets are supplied through environment variables or a secret manager, never committed.
- File uploads follow FR-DOC-02 and FR-DOC-03.
- Admin MFA is mandatory.
- PII access is logged.

### 10.4 Privacy and Compliance
- DPDP Act 2023: consent capture at sign-up, purpose limitation, and data export or deletion requests. Deletion anonymises PII but keeps financial and audit records as the law requires.
- GST invoicing compliance.
- Aadhaar handling: masked copies only. The full number is never stored.

### 10.5 Reliability and Data Integrity
- Allocation and all financial operations use MongoDB transactions with retry on transient errors.
- Idempotency keys (the `Idempotency-Key` header) are supported on payment creation, offline payment recording, invitation responses and proposal approval. Keys are stored for 24 hours.
- Side effects use a transactional outbox, so notifications and webhooks to internal consumers go out only after the transaction commits.

### 10.6 Observability
- Structured JSON logging (pino) with a request ID and correlation ID, and PII redaction.
- Health endpoints (`/health/live` and `/health/ready`).
- Metrics: request rate, errors, latency, queue depth and failed jobs.
- Error tracking with Sentry or equivalent.

### 10.7 Usability
- Responsive layouts from 360 px wide. Provider workflows (invitation response, attendance and documents) are mobile first.
- WCAG 2.1 AA for colour contrast, keyboard navigation and form labels.
- A clean, premium, light-themed interface with large service imagery and rounded cards. It is original and must not reuse any third-party branding.

### 10.8 Maintainability
- Strict TypeScript on both backend and frontend.
- Modular monolith with clear module boundaries and no circular dependencies.
- Test coverage of at least 80% on services and domain logic, and 100% of allocation and payment state transitions covered by tests.
- An OpenAPI (Swagger) specification generated from the code.

---

## 11. External Interface Requirements

### 11.1 API Conventions
- REST and JSON, versioned under `/api/v1`.
- Success response: `{ "success": true, "data": ..., "meta": { pagination } }`.
- Error response: `{ "success": false, "error": { "code": "ALLOCATION_CAPACITY_EXCEEDED", "message": "...", "details": [...] }, "requestId": "..." }`.
- Standard status codes are used, with `409` for state or concurrency conflicts and `422` for business rule violations.

### 11.2 Razorpay
- Orders API, Checkout (web), Payment signature verification, Refunds API, Settlements API, and webhooks (`payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`).

### 11.3 WhatsApp Business API
- Template messages for invitations, assignments, payment receipts and reminders. Delivery status comes back through webhook.

### 11.4 SMS
- A DLT-compliant provider for OTP and fallback messages, behind a provider-agnostic adapter interface.

### 11.5 Object Storage
- An S3-compatible API (AWS S3, MinIO or Cloudflare R2) using private buckets and presigned PUT and GET URLs.

---

## 12. Out of Scope for MVP
- Automated payout disbursement through a bank or payout API. Payroll is **in scope** from v2.0 (Section 16): wages are calculated and recorded, and each disbursement is recorded with its transaction reference.
- Recurring subscriptions or annual renewals for provider registration. Advertising packages are bought per campaign (Section 17).
- Native mobile apps. The API must support future mobile apps and integrations (requirement document §18).
- Automated assignment of any kind.
- Self-serve instant booking by companies (all jobs go through enquiry and quotation, or are created by an admin).
- Third-party background verification or KYC APIs.
- Multi-currency and multi-country support.
- E-invoicing (IRN) integration with the GST portal. This is a candidate for phase 2.
- Chat between companies and providers.

---

## 13. Assumptions Requiring Confirmation

| # | Assumption | Default taken in this SRS |
|---|---|---|
| A-01 | Who pays providers? | **Superseded in v2.0.** Payroll is calculated and recorded in the platform (Section 16), and disbursement happens outside it with a recorded reference. |
| A-02 | Is the registration fee paid before or after verification? | Before verification. A configurable refund applies on rejection. |
| A-03 | Must a proposal be approved by a different admin than the one who created it? | Yes, configurable, default on. |
| A-04 | Do vendor workers log in? | Optional OTP login. A vendor can mark attendance on a worker's behalf. |
| A-05 | Can companies see provider identities before assignment? | No, only after assignment is confirmed. |
| A-06 | Is the provider rate shown on invitations? | Configurable per job. |
| A-07 | Is the GSTIN mandatory for vendors? | Configurable per registration plan. |
| A-08 | What is the billing basis? | Both milestone (from the quotation) and attendance-based billing are supported. |
| A-09 | Is cash accepted as an offline method? | Disabled by default, can be turned on in configuration. |
| A-10 | What is the geographic scope at launch? | India, INR only. |
| A-11 | Is one person allowed in multiple vendors? | No, a person can be active with only one vendor at a time. |
| A-12 | What granularity do commitments use? | Date plus shift window. Overlapping time ranges on the same date conflict. |

---

## 14. Functional Requirements: Module A — Technician Registration and Employee Dashboard (requirement doc §3, User Type 1)

These requirements extend Sections 4.1–4.7. A technician is an Individual Professional, or a Vendor Worker that a vendor adds.

### 14.1 Registration wizard (TEC)
The public entry point is **"Register as a Technical Professional"**. Registration is split into steps, and the employee can save a draft and resume it.

| ID | Requirement |
|---|---|
| FR-TEC-01 | **Step 1, Basic information.** Full name, mobile number with OTP verification, email, date of birth, gender (only where operationally required), profile photo, permanent and current address, state, district, city and PIN code. State, district, city and PIN code are picked from the geography masters (Section 18.3). |
| FR-TEC-02 | **Step 2, Professional information.** Primary technical category, specialisation, qualification (ITI, Diploma or Degree), institute, passing year, total experience, previous company, previous project experience, technical certificates, resume, and a work portfolio where applicable. |
| FR-TEC-03 | **Step 3, Work availability.** Current employment status, whether available for work, available-from date, preferred states and cities, willing to relocate, willing to travel, preferred employment type, expected daily wage, expected monthly salary, shift preference and an emergency contact. |
| FR-TEC-04 | **Step 4, Documents and verification.** Identity proof through a compliant verification process, PAN where required, qualification and experience certificates, resume, and bank verification details where required. Unnecessary Aadhaar data is not stored (FR-DOC-05). Access to these documents is restricted. |
| FR-TEC-05 | **Step 5, Declaration.** The employee accepts the terms and conditions, the privacy policy, consent for verification, a statement that the submitted information is accurate, and the employment and deployment policies. Each acceptance is stored with the policy version, timestamp, IP address and user agent. |
| FR-TEC-06 | **Step 6, Submission.** The system generates a unique **Employee ID** with a configurable prefix and an atomic counter. It sends confirmation by SMS and email, creates the employee dashboard, sets the status to `PENDING_VERIFICATION` and notifies HR. HR can approve, reject or request corrections. |
| FR-TEC-07 | **Employee account statuses:** `DRAFT`, `SUBMITTED`, `PENDING_VERIFICATION`, `DOCUMENTS_REQUIRED`, `UNDER_REVIEW`, `APPROVED`, `ACTIVE`, `TEMPORARILY_UNAVAILABLE`, `ON_ASSIGNMENT`, `SUSPENDED`, `REJECTED`, `INACTIVE`. These map onto the existing provider lifecycle (FR-PRO-04): `DOCUMENTS_REQUIRED` maps to `CHANGES_REQUESTED`, while `ON_ASSIGNMENT` and `TEMPORARILY_UNAVAILABLE` are derived operational states. Only approved and eligible employees can be assigned. |
| FR-TEC-08 | Whether a registration fee applies (Section 4.5) is configurable per plan. A plan with a zero fee skips the payment step. |

### 14.2 Employee dashboard (EMP)
| ID | Requirement |
|---|---|
| FR-EMP-01 | **My Profile:** personal information, skills, qualifications, documents, experience and profile completion. |
| FR-EMP-02 | **My Work:** new work offers, and current, upcoming and completed assignments. Each shows project location, duty timing, reporting manager and work order details. |
| FR-EMP-03 | **Availability:** available or unavailable, preferred city, preferred work category, expected daily wage and leave dates. |
| FR-EMP-04 | **Attendance:** check-in and check-out, working hours, overtime, attendance history and attendance correction requests. |
| FR-EMP-05 | **Earnings:** daily wage details, approved working days, overtime earnings, deductions, payment status and history, and payslip download (Section 16). |
| FR-EMP-06 | **Other:** notifications, complaints, help and support, change password and account settings. |

### 14.3 Work offer acceptance (OFR)
| ID | Requirement |
|---|---|
| FR-OFR-01 | When HR offers a job, the employee gets an SMS and an app notification, can see the project details, and can accept or decline within the configured response window. This is the existing invitation flow (Section 6.4). |
| FR-OFR-02 | HR receives the response. An accepted offer is confirmed only after the required approval: an allocation proposal is approved and an assignment created (BR-ALC-02, BR-ALC-03). The employee then receives reporting instructions, and the assignment is recorded in the employee's history. |
| FR-OFR-03 | HR may skip the offer step where a valid contract or company employment arrangement allows it. This is recorded as an audited, permission-gated (`allocation.override_offer`) direct proposal line, and it still goes through proposal approval. |

---

## 15. Functional Requirements: Module B — Client Booking, Work Orders and Projects (requirement doc §3, User Type 2, and §6)

### 15.1 Client registration and requirement submission (CLR)
| ID | Requirement |
|---|---|
| FR-CLR-01 | The public entry point is **"Hire Technical Manpower"**. Registration fields: company legal name, business type, contact person, designation, mobile number with OTP, email, GSTIN and company PAN where applicable, registered office address, state, city, PIN code, website and registration documents. The client stays pending until verified (FR-CMP-02). |
| FR-CLR-02 | **Requirement form** (extends FR-ENQ-01). **Project fields:** name, type, description, site address, state, city, PIN code, start date and expected completion. **Manpower fields:** category, specialisation, headcount, qualification, minimum experience, certificates, daily duty hours, number of shifts, working days, weekly off, night shift, expected joining date and contract duration. **Commercial fields:** daily or monthly billing preference, optional budget, whether accommodation, food, transport and safety equipment are provided, and special conditions. **Documents:** requirement document, BOQ, site details and other attachments. One requirement may ask for one employee or hundreds. |
| FR-CLR-03 | On submission the system generates a unique **Requirement ID**, sends a confirmation, notifies Sales and Operations, sets the status to `NEW` and shows the requirement on the client dashboard. |
| FR-CLR-04 | **Internal quotation.** Sales or an admin reviews employee availability, skills, location, wages, transport, accommodation, statutory costs, the company service margin, taxes and other charges, then sends a quotation (Section 5.3). |
| FR-CLR-05 | **Client decision.** The client can approve, reject, **request a revision** or **ask for clarification**. A revision request moves the quotation to `REVISION_REQUESTED` and notifies Sales; the admin's revision creates version n+1 (FR-QUO-02). Clarifications are threaded comments on the quotation. |
| FR-CLR-06 | No employee is deployed against a commercial requirement until the quotation is approved, the work order is issued and the required approvals are complete. |
| FR-CLR-07 | The client can see profiles of proposed candidates, subject to privacy settings. This changes A-05: by default, before confirmation the client sees only skills, experience and verification badges, not contact details. |

### 15.2 Work orders (WO)
| ID | Requirement |
|---|---|
| FR-WO-01 | When a quotation is accepted, the system creates a **Work Order** in `DRAFT` with a unique Work Order ID. It contains client and project details, employee count and categories, daily billing rates, duty hours, contract duration, payment, overtime and replacement terms, responsibilities, applicable taxes and authorised signatures. |
| FR-WO-02 | Work order statuses: `DRAFT → ISSUED → CLIENT_SIGNED → ACTIVE → COMPLETED`, plus `CANCELLED` and `AMENDED`. An amendment creates a new version linked to the previous one. |
| FR-WO-03 | A PDF is generated and stored. Client sign-off is recorded with the user, timestamp and IP address. |
| FR-WO-04 | Every assignment references a work order (BR-WO-01). The job (project) cannot move to `IN_PROGRESS` without an active work order. |

### 15.3 Projects (PRJ)
| ID | Requirement |
|---|---|
| FR-PRJ-01 | A project (a Job, Section 6.2) has a Project ID, client, site address, project manager, start and end dates, assigned employees, required and deployed counts, attendance, billing, payment status and project status. |
| FR-PRJ-02 | Client-facing project statuses are `DRAFT`, `QUOTATION_PENDING`, `AWAITING_APPROVAL`, `READY_FOR_DEPLOYMENT`, `ACTIVE`, `ON_HOLD`, `COMPLETED` and `CANCELLED`. They are derived from the enquiry, quotation, work order and job states. |
| FR-PRJ-03 | **Deployment.** When the work order is active, employees get assignment details, the client gets deployment details, attendance tracking starts on the joining date and the project becomes `ACTIVE`. |
| FR-PRJ-04 | **Client daily operations view.** Shows total assigned, present, absent, late check-ins, attendance pending approval, replacement requests and daily deployment reports. |
| FR-PRJ-05 | **Matching explanations.** The candidate list shows why each candidate matches, using the score breakdown (FR-MAT-05). Filters cover category, skill, experience, qualification, location, availability, expected wage, previous project experience and verification status. |

### 15.4 Client dashboard and data isolation (CLD)
| ID | Requirement |
|---|---|
| FR-CLD-01 | **Sections:** overview, company profile, submit requirement, my requirements, quotations, work orders, active projects, assigned employees, attendance reports, replacement requests, invoices, payments, complaints, notifications and support. |
| FR-CLD-02 | A client can access only its own company details, requirements, projects, assigned employees, attendance, quotations, invoices and payments. Cross-client access returns `404` (no information leak) and is covered by IDOR tests. |

---

## 16. Functional Requirements: Payroll and Client Billing (requirement doc §7, §8)

### 16.1 Payroll (PAY)
| ID | Requirement |
|---|---|
| FR-PAY-01 | A payroll run covers a period, for example weekly or monthly. For each deployed employee it calculates: approved working days, daily or monthly wage, overtime, approved allowances, deductions and net payable. Inputs are **approved** attendance only. |
| FR-PAY-02 | Payroll run statuses: `DRAFT → CALCULATED → APPROVED → PAID` (partially or fully), plus `CANCELLED`. Approval is maker-checker (`payroll.approve`, separate from the preparer). |
| FR-PAY-03 | Each payroll line records the payment date and transaction reference when paid. A payslip PDF is generated and is visible on the employee dashboard. |
| FR-PAY-04 | For vendor workers, payroll is payable to the **vendor**, with a per-worker breakdown, as a vendor payment. For individual professionals it is payable to the professional. |
| FR-PAY-05 | Employee wage rates (assignment `providerRate`) and client billing rates (work order) are stored separately, and **payroll never reads client billing figures** (BR-FIN-06). |
| FR-PAY-06 | Payroll writes ledger entries in a separate `PAYROLL` book. |

### 16.2 Client billing (BIL)
| ID | Requirement |
|---|---|
| FR-BIL-01 | The system generates daily billing records from attendance: the contracted daily rate × billable (client-approved) attendance, plus approved overtime and other agreed charges, minus discounts. |
| FR-BIL-02 | Weekly or monthly invoices are generated according to the work order's billing model (Section 7.1). Different billing models per client contract are supported: daily, monthly, milestone and fixed. |
| FR-BIL-03 | Each invoice shows the invoice total, amount received and balance due. Clients download invoices and see their payment history. Admins track outstanding amounts. Automated payment reminders follow a configurable schedule. |

### 16.3 Payment categories and statuses (PMT)
| ID | Requirement |
|---|---|
| FR-PMT-01 | Payment categories: client payments, employee salary payments (payroll), vendor payments, advertiser payments, refunds, company commissions and other business expenses. Each payment has a transaction ID, related user or company, related invoice, amount, method, gateway reference, transaction date, status and reconciliation status. |
| FR-PMT-02 | Statuses are shown to users as `PENDING`, `INITIATED`, `SUCCESSFUL`, `FAILED`, `REFUNDED`, `PARTIALLY_REFUNDED` and `DISPUTED`. These map onto FR-BPAY-06; `DISPUTED` is added for Razorpay dispute webhooks. |
| FR-PMT-03 | A payment is never marked successful without server-side verification (FR-BPAY-01, FR-WHK-*). |

---

## 17. Functional Requirements: Module C — Third-Party Advertising (requirement doc §3, User Type 3, and §5)

### 17.1 Advertisers (ADV)
| ID | Requirement |
|---|---|
| FR-ADV-01 | The public entry point is **"Advertise With Us"**. Registration fields: company name, brand name, contact person, designation, mobile number with OTP, email, website, GSTIN where applicable, company address, state, city, product categories, business description and logo. |
| FR-ADV-02 | Advertiser statuses: `PENDING`, `APPROVED`, `ACTIVE`, `REJECTED`, `SUSPENDED`. Only approved or active advertisers can submit campaigns. |
| FR-ADV-03 | Product categories are an admin-managed list, separate from the service catalogue. Examples: switches and wires, cables and panels, transformers and generators, lighting, plumbing pipes and fittings, pumps and motors, HVAC, air conditioners, fire safety, construction materials, tools and machinery, safety equipment and industrial supplies. |
| FR-ADV-04 | **Advertiser dashboard:** profile, ad packages, available inventory, create campaign, upload creatives, preview, approval status, active, paused and expired campaigns, impressions, clicks, CTR, spend, remaining budget, payments, invoices, notifications and support. |

### 17.2 Ad slots and inventory (ADS)
| ID | Requirement |
|---|---|
| FR-ADS-01 | The Super Admin creates unlimited ad slots. Each slot has: a unique Ad Slot ID, name, page, section, placement position, supported devices, creative dimensions, maximum file size, supported formats, available campaign types, pricing model, base price, availability status and an approval requirement. |
| FR-ADS-02 | Slots can go on any CMS page: home (top, hero, middle, footer), category pages (Electrical, Plumbing, HVAC, Civil, Industrial Products), About, Contact, Services, sidebar, in-content, footer, mobile banner, sponsored listings and selected dashboard placements. All placements are configured in the admin panel; none are hardcoded. |
| FR-ADS-03 | **Admin controls:** enable or disable a slot, change its position or dimensions, set page, device and location visibility, set campaign priority, pause any campaign, replace a creative, reserve an exclusive placement, and set daily impression limits. |
| FR-ADS-04 | **Ad packages:** fixed daily, weekly or monthly, CPC or CPM. Prices, taxes and limits are configured by the Super Admin and **never hardcoded**. |

### 17.3 Campaigns (CAMP)
| ID | Requirement |
|---|---|
| FR-CAMP-01 | **Campaign wizard:** objective (brand awareness, product promotion, dealer or distributor promotion, website traffic, lead generation or new product launch), then placements (several pages and slots), then targeting (all India, or chosen states, cities, product categories and devices), then package, then creative, then preview, then submit. |
| FR-CAMP-02 | **Creative fields:** campaign name, headline, banner image, desktop image, mobile image, destination URL, start and end dates, pages, slots, locations and budget. The server validates file type by magic bytes, dimensions against the slot, file size, the URL (https only, no internal or blocklisted hosts) and runs content moderation by admin review. Files are virus-scanned (FR-DOC-02). |
| FR-CAMP-03 | The **preview** renders the actual creative in each selected slot's layout. |
| FR-CAMP-04 | Campaign statuses: `DRAFT`, `SUBMITTED`, `UNDER_REVIEW`, `CHANGES_REQUIRED`, `APPROVED`, `PAYMENT_PENDING`, `SCHEDULED`, `ACTIVE`, `PAUSED`, `EXPIRED`, `BUDGET_EXHAUSTED`, `REJECTED`. Transitions are enforced by a state machine. |
| FR-CAMP-05 | **Payment.** When a campaign is approved, the advertiser pays through Razorpay. **Only a verified webhook** marks the payment successful. A browser-side success message never does. After payment the system generates a receipt and invoice, schedules the campaign (`SCHEDULED`), and activates it automatically at the start time. |
| FR-CAMP-06 | **Automatic expiry.** At the end date, or when the budget or impression limit is exhausted, the system stops delivery, marks the campaign `EXPIRED` or `BUDGET_EXHAUSTED`, notifies the advertiser, updates slot inventory and releases the placement. |
| FR-CAMP-07 | Refunds and credits for campaigns are recorded with reasons and approvals (Section 7.3). |

### 17.4 Ad delivery engine (ADD)
| ID | Requirement |
|---|---|
| FR-ADD-01 | A public ad-serve endpoint takes the page, slot, device and visitor location (state and city from IP or the page context). It returns eligible creatives: active, paid, approved, within dates, with budget or impression limit remaining, matching targeting, and under the frequency cap. |
| FR-ADD-02 | Eligible campaigns rotate fairly, weighted by priority, with exclusive reservations honoured. Rejected, unpaid, paused or expired campaigns are never served. |
| FR-ADD-03 | Impressions are recorded when the creative is in view, through a signed, one-time impression token. Clicks go through a server redirect (`/ad/click/:token`) that records the click and then redirects to the destination URL. |
| FR-ADD-04 | Duplicate and suspicious events are filtered: one impression per token, per-IP and per-session rate limits, bot user-agent filtering, and click deduplication within a configurable window. CPC and CPM spend is charged only for valid events. |
| FR-ADD-05 | Analytics for advertisers (impressions, clicks, CTR, spend, remaining budget, by day, slot, page, state and device) come from hourly aggregates. |

---

## 18. Functional Requirements: Super Admin, Departments, Geography and CMS (requirement doc §4)

### 18.1 User management (SAU)
| ID | Requirement |
|---|---|
| FR-SAU-01 | The Super Admin is the highest authority. The first Super Admin is created securely at deployment through the CLI (`cli:create-admin`). There is no public Super Admin registration. |
| FR-SAU-02 | The Super Admin can view all users, search by user ID, mobile or email, filter by role, state and city, and create, edit, approve, reject, suspend and reactivate users. They can also block login, reset account access and view account history (audit log). |

### 18.2 Departments and scoped permissions (DEP)
| ID | Requirement |
|---|---|
| FR-DEP-01 | Admins manage departments. The seeded list is Recruitment, HR, Operations, Sales, Client Relations, Finance, Advertising, Customer Support, Legal/Compliance and IT/System Administration. Admin users belong to one or more departments. |
| FR-DEP-02 | A role assignment can be scoped to a department, a **state** or a **city**, in addition to the existing platform, company and vendor scopes. A scoped admin sees only records in that state or city: technicians, clients, requirements, projects and reports. |
| FR-DEP-03 | Financial access, document access and data exports are separate permissions. They can be withheld from a role regardless of its other rights. |
| FR-DEP-04 | Permission changes take effect immediately. The permission cache is invalidated on change, and authorisation is checked on every request. |
| FR-DEP-05 | No admin can access data beyond their assigned permissions unless explicitly authorised. |

### 18.3 Geography masters (GEO)
| ID | Requirement |
|---|---|
| FR-GEO-01 | Admins manage all Indian states and union territories (each with its GST state code), districts, cities and PIN codes. |
| FR-GEO-02 | Admins assign city managers and HR staff to locations, through scoped role assignments. |
| FR-GEO-03 | Addresses across the platform reference the geography masters, so manpower can be filtered by location and reports can be grouped by city. |

### 18.4 Website CMS (CMS)
| ID | Requirement |
|---|---|
| FR-CMS-01 | The Super Admin manages the home page, About Us, Services, categories, city pages, industry pages, advertiser information, contact details, FAQs, terms and conditions, privacy policy, header, footer, navigation, SEO metadata, and images and banners. |
| FR-CMS-02 | Page content is stored in the database as structured blocks (hero, rich text, card grid, FAQ list, CTA, ad slot). Pages have draft and published versions, a slug and SEO fields. |
| FR-CMS-03 | Rich text is sanitised on save and render, and there is no raw HTML injection. Media is served through the CDN. |

### 18.5 Business reports (RPT, extended)
| ID | Report |
|---|---|
| FR-RPT-09 | Employee registrations, approved employees and active manpower. |
| FR-RPT-10 | Client registrations, requirements received, quotations sent and accepted, and projects active. |
| FR-RPT-11 | Employee deployment and attendance. |
| FR-RPT-12 | Revenue, outstanding invoices, employee payouts (payroll) and vendor payments. |
| FR-RPT-13 | Advertising revenue and campaign performance. |
| FR-RPT-14 | Performance by state and by city across all of the above. |

---

## 19. Website Structure, Acceptance and Handover (requirement doc §10, §14, §16, §17, §18)

### 19.1 Public pages and portals (WEB)
| ID | Requirement |
|---|---|
| FR-WEB-01 | **Public pages:** Home, About Us, Our Services, Technical Manpower, Electrical, Plumbing, HVAC, Civil and Mechanical Services, Industrial Manpower, Industries We Serve, Locations / Cities, Hire Manpower, Register as Technician, Register as Vendor, Advertise With Us, Advertiser Registration, Contact Us, FAQs, Privacy Policy, and Terms and Conditions. All are rendered from the CMS. |
| FR-WEB-02 | **Login portals:** Employee, Client, Vendor, Advertiser and Admin. After login, each user is sent to the correct dashboard for their role (`/app` resolves the home portal). |
| FR-WEB-03 | **UI/UX:** a professional corporate, industrial look; clean typography; simple step-by-step forms; responsive dashboards; mobile-first employee experience; search and filters; paginated tables; charts; status badges; confirmation dialogs; validation; useful empty states; loading indicators; and clear errors. Employee registration must be easy to complete on a smartphone. |

### 19.2 Additional business rules (from requirement doc §18)
| ID | Rule |
|---|---|
| BR-WO-01 | Every deployment (assignment) has a valid commercial record: an accepted quotation and an active work order. |
| BR-FIN-06 | Employee wage rates and client billing rates are stored separately. Client-specific rates are configurable. |
| BR-ADV-01 | No unapproved campaign is published, and no unpaid campaign goes live. |
| BR-ADV-02 | Ad package prices are configuration, never code. |
| BR-GOV-01 | Government and private projects can have different documentation and approval requirements, configured per project type. |
| BR-OPS-01 | The company keeps control of the client relationship and the deployment process. Clients cannot contact or engage employees directly through the platform. |
| BR-AUD-01 | All important actions are logged, every financial transaction is traceable, and authorised users can export data. |

### 19.3 Final acceptance criteria (requirement doc §16)
The project is accepted only when all of the following pass in UAT. Status is as of 2026-11-18.

| # | Criterion | Status |
|---|---|---|
| AC-01 | Employees can register independently | Partial: onboarding exists; the declaration step and Employee ID are pending |
| AC-02 | HR can verify and activate employee profiles | Built (registration review) |
| AC-03 | Clients can register and submit requirements | Built (companies and enquiries); extended fields pending |
| AC-04 | Admin can create and send quotations | Built |
| AC-05 | Clients can approve quotations | Built; revision request pending |
| AC-06 | Work orders can be generated | New |
| AC-07 | HR can allocate verified employees | Phase 5 |
| AC-08 | Employees can access assignments | Phase 5 |
| AC-09 | Attendance is recorded and approved | Phase 6 |
| AC-10 | Payroll and client billing work independently | Phase 7 |
| AC-11 | Clients can view invoices and payments | Phase 7 |
| AC-12 | Advertisers can register | Phase 8 |
| AC-13 | Advertisers can select available ad spaces | Phase 8 |
| AC-14 | Advertisers can pay online | Phase 8 |
| AC-15 | Admin can approve campaigns | Phase 8 |
| AC-16 | Ads activate and expire automatically | Phase 8 |
| AC-17 | Dynamic ad spaces work on all configured pages | Phases 8–9 |
| AC-18 | Advertisers can view campaign analytics | Phase 8 |
| AC-19 | Super Admin controls all users, permissions and modules | Partial: departments and geo scopes in Phase 10 |
| AC-20 | Data is protected with proper access control | Built for existing modules; enforced for each new module |
| AC-21 | All dashboards display actual database records | Admin, company and provider dashboards still have placeholders |
| AC-22 | All modules work on desktop and mobile | Ongoing |
| AC-23 | Complete source code and documentation are delivered | Phase 11 |

### 19.4 Handover (requirement doc §17)
The following are handed over:
- frontend and backend source code
- database schema and index sync scripts (MongoDB has no migrations; the equivalent is the `db:sync-indexes` command plus data migration scripts)
- API documentation (OpenAPI at `/api/docs` and `docs/API.md`)
- admin credentials, through a secure handover process
- environment configuration documentation (`.env.example`)
- deployment scripts (`infra/`)
- payment gateway and third-party integration documentation
- test cases and reports
- backup and restore instructions
- production deployment access
- source code and IP rights as agreed in the contract

All third-party, hosting, API and maintenance costs must be disclosed separately. No hidden recurring service dependency is added without client approval.

---

## 20. Requirement Document Traceability and Open Items

### 20.1 Traceability to `bijli wala .docx`
| Requirement document section | SRS coverage | Status |
|---|---|---|
| §1 Project objective | 1.1, 1.2 | — |
| §2 Business modules A/B/C | 1.2, 4.4, 14, 15, 17 | A partial, B partial, C new |
| §3 User type 1: Employee / Technician | 4.1–4.7, 14 | Partial |
| §3 User type 2: Corporate client | 5, 15 | Partial |
| §3 User type 3: Advertiser | 17.1, 17.3 | New |
| §4 Super Admin | 3.2, 18 | Partial |
| §5 Dynamic ad engine | 17.2–17.4 | New |
| §6 Manpower operations | 6, 15.3 | Phase 5 |
| §7 Attendance and payroll | 6.7, 16.1, 16.2 | Phases 6–7 |
| §8 Payment management | 7, 16.3 | Partial (registration payments built) |
| §9 Notification engine | 8.1 (+ push channel) | Partial (console adapters only) |
| §10 Website structure | 19.1 | Partial |
| §11 Database | DATABASE.md | Mapped to MongoDB |
| §12 Technical architecture | 2.3, ARCHITECTURE.md | Deviation recorded |
| §13 Security and compliance | 10.3, 10.4, 18.2 | Built for existing modules |
| §14 UI/UX | 10.7, FR-WEB-03 | Ongoing |
| §15 Milestones | DEVELOPMENT_PLAN.md | Re-planned |
| §16 Acceptance criteria | 19.3 | Tracked |
| §17 Handover | 19.4 | Phase 11 |
| §18 Commercial and business rules | 9, 19.2 | — |
| §19 Recommendation (approve UI, ER, workflows and commercial proposal first; phase the work, but design the DB for the whole platform) | DEVELOPMENT_PLAN.md preamble | — |

### 20.2 Open items
| # | Item | Proposed default |
|---|---|---|
| O-01 | SEO for CMS-driven public pages on a Vite SPA | Prerender public CMS routes at build time and on publish, served by Nginx, with server-generated sitemap and meta tags. Revisit SSR if needed. |
| O-02 | Does a technician registration fee still apply? | Configurable per plan; a zero-fee plan skips payment (FR-TEC-08). |
| O-03 | Push notifications | Web push (VAPID) for the employee PWA; native push when mobile apps arrive. |
| O-04 | Can the client see proposed candidates before deployment? | Masked profiles (skills, experience, badges) before confirmation. |
| O-05 | Ad click fraud thresholds | Configurable; defaults of 1 click per IP per creative per 30 minutes and 20 impressions per IP per hour per slot. |
| O-06 | Statutory payroll deductions (PF, ESI, TDS) | Recorded as configurable deduction types. Statutory filing is out of scope. |
| O-07 | Vendor portal | Uses the existing provider portal for Vendor Admins, with a separate "Vendor Portal" login entry on the website. |
