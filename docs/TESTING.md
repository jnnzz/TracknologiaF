# Testing Strategy

Tracknologia prioritizes tests around business invariants and critical user flows.

## Layers

### SMTP configuration and delivery

`src/lib/config/server.test.ts` covers Brevo settings with distinct login and
sender addresses, missing/blank `EMAIL_FROM` rejection in every runtime, partial
SMTP settings, and the existing disabled-email behavior. A configured SMTP
transport always requires an explicit sender; no test or CI fixture may rely on
the old fallback to `SMTP_USER`.

`src/app/(provider)/dashboard/team/actions.production-no-email.test.ts` exercises
the real configuration parser, Providers invitation command and mail client,
with only the SMTP transport and persistence/auth boundaries faked. It checks
Brevo sender selection, success/failure copy, one-time Copy Link, duplicate-send
prevention and credential/token log redaction. Existing SMTP wire and stall
tests continue to check TLS refusal, timeouts and Copy Link recovery using local
socket servers. These tests do not contact Brevo.

For live delivery, follow [Brevo email setup](SETUP.md#brevo-email-setup) and the
pre-launch acceptance check in `SETUP.md`: test confirmation, password recovery
and staff invitations with separate Gmail/Outlook mailboxes. Record the deployed
SHA, date and pass/fail only. Check Brevo logs and actual inbox/spam placement;
provider acceptance is not proof of receipt. Hosted Supabase SMTP and templates
must be configured separately from the app. Keep real SMTP keys and live sends
out of automated tests. Local Auth E2E uses Mailpit, not Brevo; never point its
destructive fixtures at the hosted project.

### Module tests — Vitest

Test feature interfaces directly without rendering UI where possible.

High-value examples:

- new Repair starts `IN_PROGRESS`;
- Provider cannot mutate another Provider's Repair;
- accepted Repair Request creates at most one Repair;
- declined Request creates no Repair;
- `COMPLETED` Repair rejects unsupported transitions;
- public tracking projection excludes private fields;
- successful Tracking records one minimal analytics observation;
- the Tracking action returns before an unresolved deferred Analytics task;
- Analytics failure does not log the credential/database detail;
- the internal-operator guard denies missing/disabled mappings and Provider
  roles, fails closed on Auth/database/audit faults, and the sensitive audit
  path re-runs the guard and appends only the fixed category for the verified
  operator.

### Rendered UI contracts — Vitest

`tests/contracts/brand-ui.contract.test.tsx` uses the installed React DOM server
renderer to check status illustrations, accessible names, current navigation,
tracking outcomes and URL prefill, Request receipts, and native account radios.
It supplies action results at the rendering seam; it does not exercise browser
events, real Server Action transport, responsive layout, or computed styles.

Page trees containing async Server Components (such as `PublicHeader`) use
`renderToReadableStream` and consume the stream before asserting on the HTML.
`renderToStaticMarkup` remains suitable for synchronous component trees.

`tests/contracts/feedback-ui.contract.test.tsx` applies the same method to the
participant feedback form: category radios and prompts, field-error wiring,
pending, alert and receipt states, the plain `/feedback` links from Tracking and
the Request receipt, the Provider nav Feedback item, and the public and Provider
page nonce and context wiring.

`src/app/(internal)/internal/activity/page.test.tsx` renders the operator
validation metrics page with `getValidationMetrics` and the access guard mocked
at the feature seam. It checks that values render, that `null` ratios and
unavailable Feedback show as N/A and Unavailable rather than 0, that each
`MetricsError` code and the unauthenticated redirect map to their outcome, that
URL params map to the window input with a 7-day default, and that no raw
identifiers appear in the HTML. It needs no database.

Avoid testing implementation details or Tailwind class strings unless they are functionally significant.

### End-to-end tests — Playwright

Run with `pnpm test:e2e` (or `pnpm exec playwright test`). The suite lives under
`tests/e2e/` and drives the real UI against the supplied Supabase project. It
sits on top of the module, contract, and integration layers; it does not replace
them.

Environment (see `.env.example` and the fixtures in `tests/e2e/helpers/`):

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` — the
  public Supabase credentials of a **local** Supabase stack.
- `SUPABASE_SERVICE_ROLE_KEY` — required so fixtures can seed and clean up test
  actors/tenants. The fixtures refuse any host other than
  `localhost`/`127.0.0.1`/`::1`: destructive seeding is local/disposable-only,
  never production or shared mutable data. Start the stack with `supabase
start` and run `pnpm db:reset` before the suite.
- `E2E_BASE_URL` — the app URL. Defaults to the Playwright `webServer`
  (`http://localhost:3000`), which starts the app in dev mode (some flows, such
  as E2E-06 registering staff through the live form, require `runtime=local`).

Mandatory release scenarios (one spec file each under `tests/e2e/`):

1. `direct-repair.spec.ts` — Provider login, create Repair, `IN_PROGRESS`,
   tracking code, public customer tracking, status updates, `READY`,
   `COMPLETED`.
2. `customer-request.spec.ts` — public Provider page, submit Request, Provider
   accepts, exactly one `CUSTOMER_REQUEST` Repair starting `IN_PROGRESS`,
   tracking code, public Tracking through the real `/track` UI, and replay
   resistance (acceptance action is not available again and creates no second
   Repair).
3. `one-person-shop.spec.ts` — a single SHOP OWNER completes the full Repair
   workflow with no artificial technician requirement.
4. `independent-repairer.spec.ts` — Independent Provider registers and onboards
   through the real UI with Service Area + Meetup/Home Service, no mandatory
   shop address, then operates a normal non-shop-mode Repair.
5. `cross-tenant.spec.ts` — Provider A cannot read **or mutate** Provider B's
   protected data; B's durable Repair state is unchanged after A's attempts.
6. `staff-lifecycle.spec.ts` — OWNER invites, Staff registers via an invitation
   link or enters the code during onboarding, accepts, gets permitted
   access, owner-only controls are denied, OWNER removes Staff, access is
   denied.
7. `password-recovery.spec.ts` (#126) — real forgot-password request with the
   full neutral copy → captured recovery email → callback exchange → reset form
   naming the account by masked email → new password. A reused link lands on
   the recovery error state, and the old password is refused while the new one
   signs in. Account & Security keeps the read-only sign-in email separate from
   the customer contact email, using its own account. A recovery link opened
   while signed in as another account recovers that account and ends signed in
   as it. An unauthenticated bare `/reset-password` visit shows the recovery
   screen. Each scenario seeds its own accounts; only the serial recovery flow
   shares one account. Retries stay at zero and there is one worker.

Password recovery mail is read from the local stack's mail capture, which the
Supabase CLI runs as Mailpit. The repo default keeps capture off:
`supabase/config.toml` `[local_smtp]` has `enabled = false`. The E2E workflow
switches it on with a `sed` step before `supabase start`, so only the
disposable E2E stack captures mail. The helper, `tests/e2e/helpers/mail.ts`,
calls the Mailpit v1 API on `[local_smtp] port` (default `54324`):
`GET /api/v1/search?query=to:"<address>"` lists the recipient's messages, and
`GET /api/v1/message/{ID}` reads one. The helper takes the newest matching
message, checks its `To` list, and extracts the recovery link from its `Text`
or `HTML`. Purging uses `DELETE /api/v1/search` with the same query. Override
the URL with `E2E_MAILPIT_URL` if the port moves. Like every destructive
fixture, it refuses non-local hosts. The local app callback is
`http://localhost:3000/auth/callback`; `site_url` and
`additional_redirect_urls` in `supabase/config.toml` allow it.

Participant feedback has its own spec, `tests/e2e/feedback.spec.ts` (E2E-10),
outside the numbered release list. It drives the real public and Provider forms
and asserts stored rows through the service client. The `feedback_submit` limiter
is one shared dev bucket (20 per 600 seconds across public and Provider
submissions), so every scenario deletes that limiter row through trusted SQL
before and after it runs. The throttle scenario sends 20 accepted submissions,
then a 21st that is refused. Each scenario also writes titles with a per-run marker,
scopes its reads to that marker, and deletes its rows through `runLocalSql` before
its actors are removed.

`provider-settings.spec.ts` checks the settings layout at desktop and phone
widths, consistent panel widths, orientation-appropriate arrow-key navigation,
and the conditional Other arrangement field. It uses the same local-only
Provider fixtures as the release scenarios.

It also saves device checkbox selections and the request-acceptance switch,
checks persistence after reload, and checks for the uncontrolled Switch warning.
`public-recovery.spec.ts` checks that an unknown route retains HTTP 404 and offers
working navigation back home. Rendered contracts cover the unavailable-request
copy and the available Provider form path.

Reliability rules:

- Never use arbitrary sleeps; wait on observable application states.
- Each test owns and deterministically cleans up its data (fixtures seed and
  remove every actor/provider it creates).
- A flaky release-critical test is a defect, not something to normalize with
  rerun-until-green. Retries stay disabled (`retries: 0`); failure artifacts
  (trace/video/screenshot under `test-results/` plus the HTML report) are
  retained on the failing run itself and uploaded by the `E2E` workflow.

## Commands

```bash
pnpm test:e2e
```

Before merging a substantial change also run:

```bash
docker compose run --rm web npm run lint
docker compose run --rm web npm run build
```

In CI the `Verify` build step also scans the browser bundle (`.next/static`)
for its placeholder server secrets and fails on any match; see
`docs/SECURITY.md`.

## UAT pilot data pack (Plan 11)

Manual UAT runs against repeatable seed data, never production personal data.
The pack is seeded by `scripts/uat/seed.mjs` (refuses non-local hosts; lives
alongside the E2E fixture contract):

```bash
node scripts/uat/seed.mjs                                                # seed
node scripts/uat/seed.mjs --cleanup scripts/uat/outputs/<manifest>.json  # one run
pnpm db:reset                                                       # hard reset
```

Cleanup uses only the user and Provider identities in the generated manifest. Old manifests without identities are refused; reset the disposable stack instead. The database suite runs a two-pack seed and cleanup isolation check (`tests/integration/uat.db.test.ts`); it requires the local Supabase JWT secret as well as the standard test credentials.

It prints a credential manifest for the four personas (one-person Shop,
multi-Staff Shop, Independent Provider, closed-intake Shop). The pilot record
lives in `docs/release/v0.1.0-hardening/evidence/11-UAT-PILOT.md`.

## Real PostgreSQL / RLS integration tests

Run `supabase db reset` before `pnpm test:db` when working against a local
Supabase stack. `pnpm test:db` runs `vitest run tests/integration`, executing
all `*.db.test.ts` files:

```text
tests/integration/
  auth.db.test.ts              — Auth & public-operation RPC permissions
  providers.db.test.ts         — Provider isolation, onboarding, settings
  service-modes.db.test.ts     — Service Mode CRUD & Provider isolation
  invitations.db.test.ts       — Invitation lifecycle & staff offboarding
  repair-requests.db.test.ts   — RepairRequest lifecycle & Provider isolation
  repairs.db.test.ts           — Repair lifecycle & Provider isolation
  tracking.db.test.ts          — Public tracking & observation
  internal-operations.db.test.ts — Internal operator grants, audit, denials
  internal-operations-overlap.db.test.ts — Overlapping audit/revoke and grant sessions
  internal-metrics.db.test.ts  — Aggregate grants, fixed past-window snapshot/deltas, nonempty baselines, database as_of, future bounds and representative EXPLAIN timing
  feedback.db.test.ts          — Private Feedback grants, constraints, nonce retry, reviews, feedback budget, old-state upgrade check, count-summary grants, denials, windows, and exact counts
  feedback-projection.db.test.ts — Feedback persistence through PostgREST: keyset paging, detail/history bounds, null clearing
  feedback-summary-manila.db.test.ts — Manila-aligned summary bounds and day buckets, one REPEATABLE READ snapshot, rolled back
  feedback-review-flow.db.test.ts — Feedback review keeps stored notes and link; explicit null clears
  readiness.db.test.ts         — Public readiness probe healthy on the real database and unavailable on an unreachable URL
  load-stress.db.test.ts       — Burst invariants (Plan 10)
  helpers/
    supabase-test-context.ts   — client setup, user/fixture lifecycle
    shared-test-utils.ts       — reusable DB fixture helpers
tests/helpers/
  local-postgres.ts            — loopback-guarded local psql via Docker (test-only)
```

Any shared fixture logic lives in `tests/integration/helpers/` as a small test-only
seam, not a generic testing framework.

In CI, the database job pins the Supabase CLI, overrides only the generated
database port to `55432` to avoid runner collisions, retries startup once after
cleaning stale local Supabase state, and always stops the stack. This does not
change the normal local Supabase ports.

Feature 06 database coverage verifies `tracking_events` direct-access denial,
including over-128-byte neutral observation input, exact stored column shape,
repeated raw views versus distinct-Repair adoption, and both Repair origins. Apply
`20260825010000_add_tracking_analytics.sql` through a fresh reset before running
that coverage.

Plan 02 database coverage also verifies the durable public-operation limiter's
exact concurrent threshold, shared state across separate service clients,
operation isolation, expiry reset, bounded cleanup, opaque stored actor keys,
and denial of limiter/public-operation RPC execution to both `anon` and
authenticated roles.

Issue #88 database coverage verifies that `anon`, authenticated, and
`service_role` clients cannot directly insert/update/delete the private internal
tables (service_role reads only), that the admin and audit functions are not
executable by ordinary clients, that grant/revoke is atomic and idempotent,
that an invalid actor rolls back the mapping plus required audit, that the audit
RPC rechecks the enabled mapping so revocation wins over a delayed append, and
that Auth deletion removes the mapping while nulling the direct user references
on retained audit rows (not full anonymization).

`src/features/feedback/feedback.test.ts` mocks the real auth, limiter, Supabase, and
audit seams to prove limiter-first ordering, forged-field rejection, Provider class
derivation, no-query denials, audit-failure withholding, review preconditions, and
schema bounds. It needs no database.

Current feedback-backlog coverage checks exact HEAD counts, zero, malformed or
failed counts, operator denial, and audit failure. The overview rendering tests
separate a current backlog of two from a period NEW count of one, and exercise
unavailable and revoked-access outcomes.

`tests/e2e/internal-feedback-inbox.spec.ts` also seeds older NEW, recent NEW, and
older RESOLVED feedback through the disposable database. It checks that the
Overview count grows by two, the seven-day NEW metric by one, and the NEW inbox
contains both unresolved fixtures. It verifies that count pages expose no
fixture content and that revoked operators lose access. Baseline-relative
assertions use the existing single-worker E2E configuration.

`src/features/feedback/form.test.ts` calls `submitFeedbackForm` directly with a
real `FormData` and a fake submit function, with no mocks of the adapter. It
proves acceptance and nonce rotation, that only the four form fields reach
submit, the field-error copy, malformed-nonce replacement, the fixed
rate-limit, forbidden, and unavailable copy, and that unexpected errors never
reveal their text. It needs no database.

`src/features/feedback/contact-details.test.ts` checks the pure personal-details
hint: emails, Philippine mobile numbers and `+` numbers are flagged, while device
names, years, quantities and 15-digit IMEIs are not. It needs no database.

`tests/integration/feedback.db.test.ts` uses the same live psql sessions for
same-nonce submissions and same-version reviews, the review/revocation overlap,
and a rolled-back history-trigger fault. The fault exists only inside an open
transaction and is removed by its `ROLLBACK`.

`tests/integration/internal-operations-overlap.db.test.ts` uses live psql
sessions through the running local Supabase database container (matched by the
host port bound to the API container, after loopback and local Docker endpoint
checks). It holds an audit append open while a
revoke waits on the observed `pg_blocking_pids` state, and it overlaps two
first grants for one operator. Both assert one consistent outcome. Sessions
carry lock, statement, and idle-transaction timeouts and close in `finally`.

`tests/e2e/internal-operations.spec.ts` covers anonymous return-to-login,
successful auth-only operator login to `/internal`, non-indexable rendering, a
real `/internal` visit that persists a new `INTERNAL_ACCESS_VIEW` event, responsive
navigation-drawer selection and account-menu sign-out, a
temporary actor-scoped audit failure that shows only the unavailable state and
persists no view event (the fault is dropped in `finally`), immediate denial
after revocation, and 404 for Provider OWNER/STAFF/INDEPENDENT accounts that
have no internal mapping. The E2E fixture reaches the local database through
`tests/helpers/local-postgres.ts`, which refuses non-loopback Supabase URLs and
non-local Docker endpoints before any SQL runs.

The same spec also covers the `/internal/activity` surface: anonymous return to
login; 404 for Provider OWNER, STAFF and INDEPENDENT accounts and for a revoked
operator; and an enabled operator who sees the period picker and round-trips a
chosen period through the GET form, resets the filters, and expands grouped
reference numbers without phone overflow. The feedback inbox E2E also checks
side-by-side desktop submission/triage panels, phone stacking, and review saving
from the phone layout. A `/api/health` test checks the anonymous
contract: 200, body exactly `{"status":"healthy"}`, `no-store`, and no
`set-cookie`. A privacy test seeds canary customer name, phone and internal
notes on a Repair Request and Repair, plus a canary Feedback message. It asserts
that no canary appears in the rendered `/internal/activity` HTML or in any
app-origin response body, for the default window and a 30-day window. It then
confirms the feedback canary is shown on the authorized
`/internal/feedback/<id>` page, so the absence check is meaningful. The test
deletes its rows and operator through the fixtures and `runLocalSql`.

## Backup and restore drill

`scripts/drill-backup-restore.sh` (`pnpm drill:backup-restore`) is the CI proof
for the manual backup routine in
[OPERATIONS.md](OPERATIONS.md#manual-backups-free-plan). The Database integration
job runs it only in GitHub Actions, after the DB suite passes, on the same
disposable local Supabase stack, with `DRILL_DISPOSABLE=1`.

It seeds a fixed fixture: a Provider with an OWNER, an accepted Request, a
Repair with status history, a Feedback submission with a review event, and an
internal operator mapping. It then:

1. dumps roles, schema and data with `supabase db dump --local`;
2. wipes the restored scope in place (public schema, every Auth table except
   `schema_migrations`, the whole `supabase_migrations` schema);
3. removes the default privileges for `anon`, `authenticated` and
   `service_role` before the restore. Without this, restored tables silently
   regain the grants that the migrations revoked, because `pg_dump` does not
   record revocations. It then restores in one transaction with
   `psql --single-transaction` (stopping on the first error), in the order
   schema, replica mode, data, and puts the default privileges back afterwards;
4. verifies with SQL and fails on the first mismatch: fixture rows and values,
   RLS on the Provider-owned and feedback tables, `anon` denial on
   `feedback_submissions` and `repairs`, `authenticated` denial on
   `feedback_submissions`, RPC EXECUTE grants unchanged, the migration history
   count equal to the number of files in `supabase/migrations/`, and the
   operator mapping.

The script refuses any API host other than `127.0.0.1` or `localhost`. It
refuses to run without `DRILL_DISPOSABLE=1`, and it refuses outside GitHub
Actions (`GITHUB_ACTIONS=true`), so a local run stops before it touches
anything. There is no manual override. Dumps go to a temporary directory that
is deleted on exit. They never enter the repository or CI artifacts.

Scope: the drill proves the dump-and-restore mechanics on the local stack. It
does not replay `roles.sql`, because the roles already exist in that cluster.
Restoring into a fresh Supabase project is covered by the runbook steps in
OPERATIONS.md, not by this drill.

## Load & resilience harness

Plan 10 adds a zero-dependency load harness under `scripts/load/` that runs
against a real stack outside Vitest/CI. Runner CLI contract tests exercise
selection, local page preconditions, and failure/denial exit status in CI. The
live load runs are separate from the automated suite; the burst _invariants_ it would validate are asserted in CI by
`tests/integration/load-stress.db.test.ts` (same-Repair and same-Request races
serialize to one durable outcome; public-operation abuse bursts are denied
above the durable budget).

Prerequisites and usage live in `docs/DEVELOPMENT.md`. Corrected baselines and
public-action measurements are still pending; see
`docs/release/v0.1.0-hardening/evidence/10-LOAD-RESILIENCE-BASELINES.md`.
