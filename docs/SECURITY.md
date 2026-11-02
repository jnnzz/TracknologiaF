# Security

Tracknologia uses defense in depth rather than relying on Next.js alone.

## Security layers

```text
Supabase Auth
      |
      v
Tracknologia authorization
      |
      v
PostgreSQL Row Level Security
      |
      v
Database
```

## Production Configuration & Environment Safety

The application centralizes runtime environment parsing in `src/lib/config/server.ts`.

Key invariants:

- **Central Seam**: Server environment validation is decoupled from route invocation and executed on Node.js startup via `src/instrumentation.ts` when `APP_ENV=production` or `APP_ENV=staging`.
- **Fail-Fast**: Production configurations missing required secrets (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PUBLIC_ABUSE_HMAC_SECRET`, and `PUBLIC_ABUSE_TRUSTED_PROXY_SECRET` unless `PUBLIC_ABUSE_CLIENT_IP_SOURCE=vercel` on Vercel) or with invalid app origins fail immediately at boot. `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are optional but all-or-none: a partial set fails at boot. Without them, invitation email is disabled and the production app sends nothing and logs no email content.
- **Forbidden Ingress Bypasses**: `PUBLIC_ABUSE_SHARED_DEV_BUCKET=true` and `NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION=false` are explicitly rejected in production to prevent silent security degradation.
- **Secret Privacy**: Configuration validation errors and email client error logs MUST NEVER leak API keys, HMAC secrets, bearer tokens, or email message bodies. Dev email logging executes ONLY when no SMTP settings are configured in local/development mode, printing only safe non-sensitive metadata (recipient address, sender address, subject line).
- **Browser Bundle Scan**: Server secrets are read only in the `server-only` config seam and are never `NEXT_PUBLIC_*`. The CI `Verify` build then searches `.next/static` for the build's placeholder values of `SUPABASE_SERVICE_ROLE_KEY`, `SMTP_PASSWORD`, `PUBLIC_ABUSE_HMAC_SECRET` and `PUBLIC_ABUSE_TRUSTED_PROXY_SECRET`, and fails if any appears or the directory is empty.
- **SMTP TLS**: App SMTP requires TLS before any login or message data. Port 465 uses implicit TLS, and every other port requires STARTTLS. Certificates are always verified.
- **SMTP sender**: Configured SMTP also requires an explicit, non-empty `EMAIL_FROM` in every runtime. It never falls back to `SMTP_USER`, which may be a technical Brevo login rather than a sender address. The provider must verify the sender; startup validation cannot establish ownership or guarantee delivery. Existing SMTP deployments must set `EMAIL_FROM` before upgrading.
- **Brevo setup**: `SMTP_PASSWORD` contains a server-only SMTP key, not an API key or Gmail password. App invitation settings and Supabase Auth SMTP settings are separate; changing one does not change the other. For the no-domain pilot, sender verification, transactional activation, account quota, and actual confirmation/recovery delivery must be checked before launch; see `docs/SETUP.md`. No approval or inbox-delivery guarantee is inferred from successful configuration or unit tests.

## Authentication

Supabase Auth owns authentication/session mechanics:

- signup/login;
- password handling;
- password reset;
- session/JWT handling;
- authenticated user identity.

Tracknologia must not implement its own password hashing or JWT system.

### Login return paths

`/login?redirectTo=` targets are untrusted input. One helper, `getSafeInternalRedirectUrl`, is shared by the login page, `loginAction`, the auth callback, and `proxy`: it accepts only single-leading-slash local paths of at most 2048 characters, trims boundary whitespace, preserves safe query/fragment values, and falls back to `/dashboard` for absolute, protocol-relative, backslash, control-character, or oversized targets. The login form re-posts only the sanitized target and the Server Action re-sanitizes it, so a forged form field cannot redirect off-site. `proxy` treats `/internal` and `/internal/...` (not lookalikes such as `/internally`) as coarse authenticated destinations only; that redirect is not operator authorization, which is enforced by the `/internal` guard and the service-role-only internal seams described below.

### Password recovery routing

- Supabase Auth owns every recovery token: its single-use recovery link is
  exchanged only by `/auth/callback`; the application keeps no reset-token
  table and never derives account state from link text.
- The reset-request response is neutral. It never reveals whether an email
  is registered (Supabase silently skips unknown addresses), and production
  Auth failures are surfaced as generic messages only. The recovery email
  goes to the account's sign-in email — never to a Provider's customer
  contact email, and never to another person's account on request of a
  third party.
- `proxy.ts` keeps `/forgot-password` and `/reset-password` reachable for
  signed-in visitors (it still refreshes their session) but redirects
  signed-in visitors only from `/login` and `/register`. Recovery entry
  pages resolve their own state deliberately; an automatic redirect would
  strand a valid recovery session on the dashboard.
- The reset form opens only with a server-issued recovery grant. The callback
  issues one only when the session produced by the code it just redeemed has a
  `recovery` entry in its `amr` claim, with a recent timestamp. The `amr` is
  read from the access token Supabase returned in that exchange. The token is
  decoded, not signature-verified, because the server received it straight
  from Supabase. The user's `recovery_sent_at` history never proves purpose, and
  neither do the `next` parameter or the `?flow=recovery` marker. A valid
  magic-link, password or OTP exchange routed to `/reset-password` gets no grant.
- The grant is an HMAC-signed, HttpOnly cookie scoped to `/reset-password`. It
  is bound to the Auth user id and to the session id (`session_id`), and it is
  valid for 10 minutes. Its signing key is derived from the abuse secret under
  the label `tracknologia:recovery-grant:v1`, so the raw secret is never the
  HMAC key.
- Honest lifetime: the grant is short-lived (10 minutes), user- and
  session-bound, and cleared by the browser after a successful change. It is
  not an atomic server-side spent token. A copied cookie stays usable from the
  same session until it expires, and two simultaneous requests carrying the same
  cookie can both pass the check. The credential change itself is enforced by
  Supabase Auth.
- `updatePasswordAction` refuses a missing, expired, tampered, other-user or
  other-session grant without calling Supabase, so the password is unchanged.
  A signed-in visit with `?flow=recovery` but no valid grant shows the fresh-link
  card, not a password form. A signed-in visit without that marker is redirected
  to the dashboard. The credential change only ever affects the signed-in
  visitor's own account.
- A recovery exchange replaces any existing session with the recovered
  account's session. The reset form names that account by masked email
  (`b•••@example.com`), so the change is never silent. A failed, expired or
  reused recovery link lands on `/reset-password?callback_error=auth_callback_failed`,
  which shows the recovery error state with a path to request a new email,
  even when the browser already has a session. Unknown `error` values are not
  echoed.
- Production credential updates fail closed: Auth internals such as
  missing or expired recovery sessions surface as one deliberate message
  directing the person to request a fresh recovery email.

## Authorization

Tracknologia owns application permissions:

- current Provider membership;
- membership role;
- Provider ownership of Repair/Repair Request;
- allowed Repair state changes;
- public vs private data exposure.

An authenticated user is not automatically authorized for a resource.

## Provider isolation

Provider A must not read or mutate Provider B's Repairs or Repair Requests.

Enforce this twice:

1. application authorization in Tracknologia features;
2. PostgreSQL RLS policies as defense in depth.

Feature 03 Provider queries include the trusted `provider_id` from
`requireProviderContext()` and RLS independently checks
`get_auth_user_provider_ids()`. Accept/decline RPCs derive `auth.uid()` again,
hide cross-tenant rows as not found, and never trust URL/form ownership fields.

Provider profile mutation is additionally constrained by column-level grants:
Owners may edit operating/profile fields, but authenticated clients cannot
rewrite Provider type, slug, ownership, IDs, or timestamps. Direct writes to
`provider_service_modes` are denied; the Owner-only
`set_provider_service_modes` RPC replaces modes atomically and serializes
same-Provider calls with a row lock. Database checks bound direct profile values
that bypass application validation.

Feature 04 Provider operations likewise derive trusted context inside the
Repairs Module. Authenticated members may update only the explicitly granted
Repair snapshot/detail columns for their Provider. They cannot directly insert
Repairs or Status Events, or rewrite Provider ownership, source Request,
origin, ticket/tracking identifiers, lifecycle state, actors, or timestamps.

An actual Repair `service_mode` change is additionally guarded by
`enforce_repair_service_mode_update`. The trigger locks the owning Provider row
`FOR SHARE` and rejects unsupported new non-null values, so direct Supabase
writes cannot bypass configured-mode validation and concurrent Owner mode
replacement cannot create a stale-check success. Unchanged historical modes
remain valid after later Provider configuration removal.

Direct creation uses `create_provider_repair` to commit one Repair and initial
Status Event atomically. Lifecycle changes use `change_repair_status`, which
locks the Repair, rechecks the exact transition graph, appends history, and
maintains `completed_at` in one transaction. Cross-Provider identifiers are
hidden as not found. Customer Updates are Provider-scoped and append-only;
authenticated users cannot edit/delete them, and anonymous roles cannot read
the raw table.

## Internal operator access

Internal operators are a separate private privilege layer. They are not Provider
roles, not `user_metadata`, and not inferred from owning or joining a Provider:

- `internal_operators` is a private allow-list keyed by Auth user with an
  `enabled` flag. It is provisioned only by a deliberate, owner-approved
  service-role runbook operation (see `docs/OPERATIONS.md`); there is no seed
  identity, signup trigger, metadata flag, or self-service grant.
- `src/features/internal-operations` owns the guard.
  `requireInternalOperator()` derives the user only from the authenticated
  session, performs an exact-user lookup with no process/global cache, and
  returns `ALLOWED`, `UNAUTHENTICATED`, `FORBIDDEN`, or `UNAVAILABLE`.
  Missing/disabled mappings and Provider-backed users without a mapping are
  `FORBIDDEN`; Auth/database faults are `UNAVAILABLE`.
- The `/internal` layout and every sensitive internal page operation run the
  guard. Anonymous visitors return to login with the sanitized `/internal`
  destination; `FORBIDDEN` renders a 404 without internal data; `UNAVAILABLE`
  renders a safe unavailable state without signing the user out.
- Sensitive internal renders require `recordSensitiveInternalAccess(...)` to
  succeed first. It re-runs the guard itself, refuses every non-`ALLOWED`
  outcome, and then appends the audit event through a service-role-only
  `SECURITY DEFINER` function. That function accepts only fixed operation
  categories and rechecks the enabled mapping under `FOR SHARE` at write time,
  so a revocation wins over a delayed append. Audit failure denies the render.
- `internal_access_audit` is append-only. `service_role` may read but cannot
  insert, update, or delete directly; no ordinary client can execute the audit
  or admin functions, so operator access is not a publishable-key write
  surface. Auth deletion removes the live mapping and nulls the direct user
  references on retained audit rows through `ON DELETE SET NULL`; operation,
  reason and timestamp remain and may stay linkable to external approval
  records, so this is not full anonymization.
- The owner approved 180-day retention for internal access, feedback review,
  and feedback privacy/deletion audits, with monthly manual review
  ([#87 decision](https://github.com/Jacinth091/Tracknologia/issues/87#issuecomment-6537741845)).
  No automatic audit deletion or general audit purge is implemented. Follow
  the read-only inventory and approval/escalation process in
  `docs/OPERATIONS.md` ("Monthly audit-retention review"); append-only grants and
  history protections remain in force.
- Private Feedback (issue #89): `feedback_submissions` and
  `feedback_review_events` have RLS enabled, no policies, and no client grants.
  `service_role` may only `SELECT`; direct writes bypassing the RPCs are denied.
  `submit_feedback(...)` (service-role only) accepts a nonce retry without
  changing the original and returns the same generic `ACCEPTED` receipt, so it
  never discloses earlier content or whether a nonce existed.
  `record_feedback_review(...)` (service-role only) accepts an operator UUID
  that the server resolves from the verified internal session before it calls
  the function. The SQL function does not read any session itself; it trusts
  only the service-role caller. It rechecks the enabled mapping under
  `FOR SHARE` before locking the feedback row, and commits the row update and
  its history event together. `submit_feedback` is reserved for the public and Provider Feedback
  adapters; review stays on the internal operator adapter. Reviewers and submissions referenced by
  history are `ON DELETE RESTRICT`, so deleting an Auth identity cannot erase
  review history.
- Feedback privacy (PR #105 review): redaction and purge are owner-run SQL only,
  never a browser, Provider, or service-role path. Each runs in one transaction
  that ends with `rollback;` by default. The privacy audit
  (`feedback_privacy_audit`) is append-only, with no client privilege and
  `service_role` `SELECT` only. The audit operations are `FEEDBACK_REDACTED`,
  `FEEDBACK_PURGED` and `FEEDBACK_PRIVACY_REVIEWED` (the kept mark, which changes
  no text). A redaction bumps `row_version` and fills the
  review stamp without overwriting it, so a triage form loaded before the
  redaction is rejected with `FEEDBACK_VERSION_CONFLICT` and cannot restore
  erased notes; the linked issue URL is retained. Routine access views stay `INTERNAL_ACCESS_VIEW` events
  with a null reason. Policy approval for redaction and purge is issue #87 and
  is not implied by this implementation.
- Feedback abuse budget: the durable limiter gains a `feedback_submit`
  operation (default 20 requests per 600 seconds), with its own
  `PUBLIC_ABUSE_FEEDBACK_*` overrides. Its counter is independent of the
  tracking and Repair Request counters.
- Feedback summary (issue #90): `get_feedback_count_summary(...)` is service-role
  only and rechecks the enabled operator mapping under `FOR SHARE`. It returns
  fixed count groups for a bounded Asia/Manila calendar window and never message, notes, nonce,
  identity, or row identifiers. Every internal Feedback read passes the operator
  guard and the required access audit before its privileged query.
- The current NEW feedback backlog uses the same operator guard and required
  audit, then a service-role exact-count HEAD query over retained `NEW` rows.
  It returns no row payload or identifiers and does not widen table grants.
  Missing counts and query failures are unavailable, not zero.
- The Feedback `feedback_submit` budget covers both public and Provider
  submissions. Provider membership is resolved before the budget, and the budget
  runs before any input is parsed.
- Participant feedback surfaces (issue #91): `/feedback` (anonymous) and
  `/dashboard/feedback` (Provider) read only `category`, `title`, `message`, and
  the submission nonce from the form. `source` and participant class come from
  the server (`PUBLIC_FEEDBACK` on the public page, derived from membership on the
  Provider page), so a forged value never reaches storage. Entry links from
  Tracking, the Request receipt, and the Provider nav carry no query string and
  no Tracking Code or Request Reference. The participant copy and privacy notice
  were owner-approved on 2026-10-30 (#87). Feedback is kept with a personal
  review within 90 days, through the runbooks in `docs/OPERATIONS.md`.
- Public privacy page (`/privacy`, owner decision on #87, decision 8 covers the
  feedback text): static, anonymous, and read-free. Section 1 renders the same
  `FeedbackPrivacyNotice` component as the feedback form, so the approved
  wording cannot drift between the two. The page is linked from the public
  feedback, Repair Request, `/track` and `/register` surfaces. The page shows
  the project contact address (owner decision on #87, 2026-10-31).
- Operational validation metrics (issue #93) independently require the operator
  guard and a successful access audit. The aggregate RPC rechecks the enabled
  mapping under `FOR SHARE` and is executable only by `service_role`. It returns
  fixed count/mean/date groups and a database read timestamp, never raw records
  or identifiers. The feature rejects unknown, duplicate or incomplete groups
  instead of turning failed reads into zero activity. Feedback unavailability
  is explicit; a Feedback authorization denial still denies the whole report.

## Public Provider and invitation projections

Anonymous users cannot read raw Provider rows. `public_provider_profiles`
allow-lists public identity, address/area, devices, Service Modes, and request
availability only for Providers accepting Requests. It excludes internal
contact fields and update timestamps.

Possessing a Staff invitation token permits a restricted lookup of the invited
email and public Shop identity. The lookup does not return the Provider's
private contact email or phone.

Choosing Staff at registration creates an Auth identity only; no invitation code
is required until onboarding. Membership and Provider access are granted only
after Providers verifies and atomically accepts a valid invitation for that user.
Codes supplied through shared registration links remain in the temporary
HttpOnly onboarding cookie, never in Auth metadata.

At most one active pending Staff invitation exists per Shop and normalized
recipient email: `create_staff_invitation` reuses an existing active pending
invitation instead of issuing a duplicate credential, so retries and
double-clicks cannot mint multiple simultaneously valid links. Reuse never
regenerates or exposes a raw credential; replacing an invitation requires an
OWNER to revoke it and invite again.

`create_staff_invitation` also enforces recipient eligibility: an email whose
account already holds an active Provider membership is refused (that link could
never be accepted), and the refusal is rechecked under a recipient-email
advisory lock shared with the other membership-establishing paths. Acceptance
(`accept_staff_invitation`) and Owner onboarding
(`create_provider_with_owner`, including the composite
`create_provider_with_owner_and_modes` wrapper) take the same recipient-email
lock followed by the per-User lock, so a create/accept race never leaves an
unusable active invitation, even if the recipient's Auth User is created
mid-create or the create is issued by a different Shop. Legacy duplicate active
invitations from before this policy are reconciled to the earliest
_currently-valid_ link per Shop + email (expired rows are left untouched; they
never resolve) by the migration (and by the service-role-only
`reconcile_staff_invitation_duplicates()` maintenance RPC); superseded links
stop resolving and raw credentials are never reconstructed.
The one-membership rule is per User across Providers, so once any Provider
membership is established every other currently-active pending invitation for
that normalized email — including invitations held by other Shops while the
recipient was still eligible — is superseded. Cross-Shop invitations remain
independent only while the recipient has no membership.

## Public health check

`GET /api/health` is a deliberate public exception for the uptime monitor. It
answers `{"status":"healthy"}` (200) or `{"status":"unavailable"}` (503) with
`Cache-Control: no-store`. It has no cookies, auth, redirects or other fields.
The probe is a deliberate, bounded exception to the service-role public-operation
client (`createPublicOperationClient`) scope: a read-only, head-only, single-row
query on `providers` with no table content, used only by `checkReadiness`,
bounded by a 3-second timeout. Its failure logs carry only a fixed message and
a SQLSTATE-shaped code.

## Server Actions and Route Handlers

Treat every mutation interface as externally callable.

Every write must:

1. resolve authenticated context;
2. validate input;
3. verify Provider/resource authorization;
4. invoke the relevant feature module;
5. expose only the necessary result.

## Input validation

Use Zod on the server for untrusted input.

Client-side validation improves usability but is not a security control.

## Public tracking

Tracking codes must be difficult to enumerate and should not equal sequential ticket numbers.

The public tracking feature returns only a safe `PublicRepairView` through
`lookup_public_repair(text)`, for example:

```text
provider name
device summary
current status
reported problem (customer's own description)
received/submitted date
customer-visible update
last updated timestamp
```

The reported problem is data the customer already provided, and the tracking
code is a bearer credential — anyone holding the code could submit it
themselves, so both are acceptable to return. Internal fields (diagnosis,
initial observation, internal notes) stay excluded.

The function bounds and validates RPC input, fixes its `search_path`, returns
explicitly declared columns, and caps nested Updates at 25 message/timestamp
pairs. Only the server-only service-role client may execute it; anonymous and
authenticated callers also have no direct read privilege on Provider, Repair,
Customer Update, or Status Event tables. Disabling new Requests does not hide
Tracking for existing Repairs.

The Tracking Module rejects raw input longer than 128 characters before
normalization or persistence, strictly validates the database row, and
constructs output field-by-field. Invalid, oversized, and unknown codes share a
neutral result, and the public form uses POST rather than a credential-bearing
URL.

Never expose customer identity/contact, Internal Notes, Diagnosis, serial
numbers/specifications, free-form Service Mode details, Ticket Number, echoed
Tracking Code, private identifiers, Update authors, audit history, or complete
Repair rows through the public Interface.

The public Server Action derives connection metadata, converts it to a keyed
HMAC digest, and atomically consumes the shared PostgreSQL Tracking budget
before the lookup. Malformed and unknown codes remain the same neutral result.

## Analytics telemetry

Successful Tracking observation uses the separate
`record_successful_tracking_view(text)` function. The function bounds and
normalizes input, resolves an existing Repair internally, stores only
`repair_id` and server time, fixes its `search_path`, and returns no existence or
Repair data.

`tracking_events` has RLS enabled with no anonymous/authenticated direct table
privileges or policies. Telemetry excludes Tracking Codes, customer/contact and
Provider snapshots, IP addresses, user agents, cookies, fingerprints, Auth ids,
tokens, and arbitrary metadata. Repeated views are not represented as unique
Customers. Analytics persistence errors are sanitized and do not fail an
otherwise successful public Tracking result. The `/track` Server Action keeps
the submitted code inside its server closure and uses Next.js `after()` so an
unresolved Analytics operation is outside the response path. The serialized
action result contains neither the credential nor Analytics state.

The observation function is service-role only. Observation explicitly inherits
the successful Tracking lookup budget: it is scheduled at most once, after one
successful budgeted lookup. Analytics remains post-response and non-fatal, so
it does not add a second blocking limiter to the Tracking response path.

## Public Repair Requests

Implemented controls:

- server-side Zod validation;
- bounded database checks matching Module limits;
- default Server Action request/body-size controls;
- no anonymous direct table read/write grants;
- one allow-listed `submit_repair_request` RPC returning only Reference and time;
- Provider availability and configured Service Mode rechecked under a Provider
  row lock;
- unpredictable `REQ-[A-F0-9]{16}` public Request References.

Public operations trust boundary:

- The application server invokes the public operation RPCs
  (`lookup_public_repair`, `record_successful_tracking_view`,
  `submit_repair_request`) with the server-only service-role credential via
  `src/lib/supabase/service.ts`; `anon`/`authenticated` EXECUTE is revoked
  (`20260825120000_restrict_public_rpc_grants.sql`). The publishable key alone
  cannot reach Postgres, so abuse control in the application layer cannot be
  bypassed by direct database calls.
- The Tracking and Repair Request Server Actions atomically consume isolated,
  configurable PostgreSQL budgets before invoking their owning features.
  Durable rows contain only the operation, an opaque server-keyed HMAC actor
  key, the bounded window/count, and expiry. Expiry ends a row's logical effect
  immediately. A later check physically prunes at most 100 expired rows; rows
  may remain while the service is idle, but idle periods create no new rows.

The final public trust boundary is:

```text
browser
-> trusted production ingress strips/overwrites internal headers and injects proof
-> Next.js Server Action verifies ingress proof and checks durable abuse control
-> service-role-only narrow public-operation RPC
```

Production ingress must strip incoming `x-tracknologia-proxy-secret` and
`x-tracknologia-client-ip` headers, overwrite the client-IP header, inject the
proof secret, and prevent direct access to the Next.js upstream. The action
accepts the client IP only after a constant-time proof check and fails closed
when proof or metadata is absent/invalid. `PUBLIC_ABUSE_HMAC_SECRET` and the
separate `PUBLIC_ABUSE_TRUSTED_PROXY_SECRET` are server-only, must each contain
at least 32 characters, and must be shared by the relevant app/ingress
instances. Never reuse one as the other.

The supported local Docker setup exposes Next.js directly and therefore does
not trust forwarding headers. Local development opts into one shared
abuse-control bucket by setting `PUBLIC_ABUSE_SHARED_DEV_BUCKET=true`; the
opt-in is explicit and environment-based, so a staging or production deployment
that forgets its ingress configuration fails closed instead of silently sharing
one bucket. Arbitrary forwarded values cannot create additional buckets.

### Vercel visitor IP source

On Vercel, `PUBLIC_ABUSE_CLIENT_IP_SOURCE=vercel` replaces the trusted-ingress
contract above. Vercel overwrites `X-Forwarded-For` and does not forward
external visitor IPs, which is why that header is never read in this mode
([Vercel request headers](https://vercel.com/docs/headers/request-headers)).
The application instead trusts only `x-vercel-forwarded-for`. Vercel documents
it as identical to `X-Forwarded-For`, but unlike that header it is not
overwritten when a proxy sits in front of Vercel. The first entry must be a
valid IP; otherwise the operation fails closed. The application ignores
`x-tracknologia-proxy-secret`, `x-tracknologia-client-ip`, `x-forwarded-for`
and `x-real-ip` in this mode, and `PUBLIC_ABUSE_TRUSTED_PROXY_SECRET` is not
required. `PUBLIC_ABUSE_HMAC_SECRET` is still required, and the visitor IP is
still stored only as the keyed HMAC actor key.

The explicit setting keeps the trusted-ingress contract as the default. The
`VERCEL=1` check is only a configuration sanity check. It makes the
configuration throw at startup when the setting is copied to a host that does
not set `VERCEL`. It is not proof of origin: anyone who controls a process's
environment can set that variable, so it cannot establish where a request came
from.

Vercel mode is safe only when the application is actually served by Vercel's
managed edge. There, Vercel overwrites `X-Forwarded-For` and does not forward
external IPs, so `x-vercel-forwarded-for` carries the visitor IP. Never copy
`PUBLIC_ABUSE_CLIENT_IP_SOURCE=vercel` together with `VERCEL=1` to a
self-hosted or other host. A caller there could send arbitrary
`x-vercel-forwarded-for` values, obtain a fresh abuse-control bucket on each
request and bypass throttling. Other hosts must use the trusted-proxy mode,
with its ingress proof.

Residual risk: a proxy placed in front of Vercel would make every visitor that
reaches the application through it appear with that proxy's IP, so they would
share one bucket. This over-throttles rather than bypasses the limit, but the
IP source must be revisited before such a proxy is introduced.

The public Server Actions deliberately consume their budget before validating
form input, so hostile traffic cannot obtain free schema validation probes from
the application.

Production exposure still needs:

- optional CAPTCHA/bot protection only when actual abuse warrants it.

## Staff offboarding

Only the authenticated `OWNER` can remove a `STAFF` membership, through the
`Providers.removeStaffMember` command and the narrow
`remove_staff_member(UUID)` transaction. The database function locks the target
membership row, removes exactly one same-Provider `STAFF` row, and refuses
`OWNER` targets. Not-found, cross-Provider, and non-STAFF targets collapse into
a neutral `false`, so membership existence in another Provider is never
revealed. Direct client writes to `provider_memberships` remain denied; RLS
denies removed Staff on their next request even if application UI is bypassed,
and the removed user's person profile is retained.

## Request decision integrity

Authenticated clients can read only Provider-owned Request/Repair/history rows.
Feature 03 Request rows remain read-only to clients. Narrow decision RPCs lock the Request
before checking `SUBMITTED`. Acceptance commits Request `ACCEPTED`, one
`CUSTOMER_REQUEST` Repair, and its initial `IN_PROGRESS` Status Event together.
Unique `repair_request_id` prevents duplicate Repair creation on retry.

Feature 04 grants only allow-listed Repair detail columns and Customer Update
insertion. Repair creation and lifecycle/history remain narrow transaction
surfaces rather than direct table writes. Service Mode detail editing remains a
single Repair update with a narrow changed-mode integrity trigger.

## Environment secrets

Browser-safe Supabase project configuration may use `NEXT_PUBLIC_*`.

Privileged service-role/secret keys must never use `NEXT_PUBLIC_*`, appear in browser bundles, or be committed to Git.

## Server-only implementation

Use server-only imports/structure around database and privileged implementation code so Client Components cannot accidentally depend on it.

## Security tests

At minimum test:

- Provider A can read Provider A Repair;
- Provider A cannot read/update Provider B Repair;
- Provider A cannot accept Provider B Repair Request;
- unauthenticated users cannot access Provider data;
- Provider Owners cannot rewrite Provider type or slug through profile updates;
- Staff cannot update Provider operating fields or Service Modes;
- Staff can update only their own person profile;
- failed configured onboarding and Service Mode replacement leave no partial state;
- concurrent Service Mode replacement leaves exactly one submitted set;
- direct profile writes cannot exceed durable database bounds;
- anonymous Provider/invitation projections exclude private contact fields;
- public tracking does not expose internal notes/contact data;
- invalid tracking identifiers reveal no sensitive information;
- public tracking caps Updates and returns message/timestamp pairs only;
- anonymous/authenticated callers cannot read or write `tracking_events`
  directly;
- malformed and unknown Tracking Codes create no telemetry;
- oversized direct observation input creates no telemetry or existence detail;
- successful-view telemetry contains only Repair correlation and observation
  time;
- Analytics latency/failure neither delays a successful Tracking response nor
  logs the credential/database detail;
- anonymous callers cannot read raw Repair/Update/Status Event tables;
- direct and Request-origin Repairs share one public projection;
- closing new Requests does not disable existing Repair tracking;
- accepted Repair Request cannot create multiple Repairs;
- concurrent acceptance creates one Repair and one initial Status Event;
- decline creates no Repair and cannot be repeated;
- Provider B cannot list, accept, or decline Provider A Request;
- anonymous callers cannot read Request contact/device/problem data;
- closed Provider and unsupported Service Mode public submissions fail;
- illegal Repair status transitions are rejected;
- direct Repair creation cannot leave a Repair without its initial event;
- direct authenticated status/identity edits and Status Event insertion fail;
- unrelated detail edits preserve removed historical Repair Service Modes;
- direct unsupported Repair Service Mode updates fail without changing durable
  state;
- concurrent Repair mode edits and Provider mode replacement serialize to a
  valid outcome;
- Customer Updates are Provider-scoped, append-only, and independent of status;
- concurrent lifecycle changes leave one consistent status/event outcome;
- completed Repairs cannot be reopened and have a matching completion time;
- internal access is denied to anonymous, Provider OWNER/STAFF, and any user
  without an enabled mapping, and the denial renders no internal data;
- ordinary clients cannot execute the internal admin or audit functions, and
  `service_role` can only read the private tables (no direct mutation);
- revoking an internal mapping denies the next guarded request and the next
  required audit append even for an existing session;
- an invalid audit actor rolls back the mapping change and the required audit
  event together;
- Auth identity deletion removes the live mapping and nulls the direct user
  references on retained audit events, leaving operation, reason and timestamp.
