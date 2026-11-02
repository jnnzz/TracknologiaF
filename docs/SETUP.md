# Development Setup

This is the canonical setup guide for Tracknologia developers.

## Supported workflow

Docker is the default development environment so Windows and Linux developers use the same Node/runtime environment.

## Prerequisites

Required:

- Git
- Docker
- Docker Compose plugin

Recommended on Windows:

- WSL2
- Docker Desktop using the WSL2 backend

Node.js on the host is optional once Docker is configured.

### Verify

```bash
git --version
docker --version
docker compose version
```

## Clone

```bash
git clone <REPOSITORY_URL>
cd tracknologia
```

## Environment configuration

```bash
cp .env.example .env.local
```

PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Required values:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
NEXT_PUBLIC_APP_URL=http://localhost:3000
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
PUBLIC_ABUSE_HMAC_SECRET=<at-least-32-random-characters>
```

`PUBLIC_ABUSE_TRUSTED_PROXY_SECRET` is also required as a different,
at-least-32-character random value when trusted ingress is in use. Local
development may leave it blank when `PUBLIC_ABUSE_SHARED_DEV_BUCKET=true`.

`SUPABASE_SERVICE_ROLE_KEY` is server-only. It is required because public,
accountless operations (Tracking lookup, Tracking observation, Repair Request
submission) run under the service-role credential so the publishable key cannot
reach Postgres directly. Never expose it through a `NEXT_PUBLIC_*` variable or a
browser bundle. For local Supabase, `supabase status` prints the value.

`PUBLIC_ABUSE_HMAC_SECRET` creates opaque actor keys for the shared PostgreSQL
abuse control. Keep it server-only and identical across application instances.
Optional validated overrides are
`PUBLIC_ABUSE_TRACKING_LOOKUP_MAX`,
`PUBLIC_ABUSE_TRACKING_LOOKUP_WINDOW_SECONDS`,
`PUBLIC_ABUSE_REPAIR_REQUEST_MAX`,
`PUBLIC_ABUSE_REPAIR_REQUEST_WINDOW_SECONDS`, `PUBLIC_ABUSE_FEEDBACK_MAX`
(default `20`), and `PUBLIC_ABUSE_FEEDBACK_WINDOW_SECONDS` (default `600`).

Production also requires a trusted ingress and a separate
`PUBLIC_ABUSE_TRUSTED_PROXY_SECRET`, unless `PUBLIC_ABUSE_CLIENT_IP_SOURCE=vercel`
on Vercel (see [Deploying on Vercel](#deploying-on-vercel)). The ingress must remove any incoming
`x-tracknologia-proxy-secret` and `x-tracknologia-client-ip` values, set the
client-IP header itself, inject the proof secret, and block direct access to the
Next.js upstream. Do not reuse the HMAC secret as the proxy proof secret. The
application rejects public operations in production when proof or client-IP
metadata is missing or invalid.

The local Docker setup exposes Next.js without that trusted ingress. Local
development opts into one shared abuse-control bucket by setting
`PUBLIC_ABUSE_SHARED_DEV_BUCKET=true` in `.env.local`; forwarding headers are
ignored, so spoofed values cannot evade the limit. Any environment without
that opt-in requires valid trusted-ingress proof and fails closed otherwise,
so staging must configure the same ingress contract as production.

### Production Configuration Seam & Startup Validation

The application validates server configuration centrally via `src/lib/config/server.ts`.

In `production` (when `APP_ENV=production` or `APP_ENV=staging`):

- `NEXT_PUBLIC_APP_URL` must use `https://` and cannot use `localhost` or loopback IP addresses.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are mandatory.
- `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD` are optional, but set all three or none: a partial set stops startup. When SMTP is configured, `EMAIL_FROM` is also required and must identify your verified sender. It never falls back to the SMTP login. With no SMTP settings, invitation email is disabled and invitations are shared with Copy Link.
- `PUBLIC_ABUSE_SHARED_DEV_BUCKET=true` and `NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION=false` throw validation errors at startup via Next.js `instrumentation.ts`.

`.env.local` must be ignored by Git.

## Deploying on Vercel

Vercel hosts the Next.js app directly, so no separate ingress is needed. Vercel
keeps Production, Preview and Development environment variables separate. A
variable set only for Production is not available to Preview deployments, so
each environment you deploy needs its own complete set. `VERCEL=1` is a system
variable that Vercel sets on both Preview and Production deployments. Do not
add it yourself.

Each environment needs these variables, scoped to that environment:

- `APP_ENV=production`
- `NEXT_PUBLIC_APP_URL`: the deployed `https://` URL of that environment
- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY` for that environment's Supabase project
- `PUBLIC_ABUSE_HMAC_SECRET`: at least 32 random characters, unique to that environment
- `PUBLIC_ABUSE_CLIENT_IP_SOURCE=vercel`: reads each visitor's IP from Vercel's `x-vercel-forwarded-for` header. It is a configuration check, not proof of origin. Set it only on Vercel-served deployments, never on a self-hosted or other host; see the trust limit in `docs/SECURITY.md`.
- `SMTP_HOST=smtp-relay.brevo.com`, `SMTP_PORT=587`, `SMTP_USER` (the Brevo SMTP login), `SMTP_PASSWORD` (a Brevo SMTP key) and `EMAIL_FROM` (for example `Tracknologia <your-verified-sender-address>`). `EMAIL_FROM` is required when SMTP is configured; the technical SMTP login is not a sender address. `SMTP_PASSWORD` is a secret: never set it as `NEXT_PUBLIC_*`. Leave the SMTP credentials unset to keep invitations on Copy Link only. See [Brevo email setup](#brevo-email-setup).

Do not set `PUBLIC_ABUSE_TRUSTED_PROXY_SECRET`; this mode does not use it.
Never set `PUBLIC_ABUSE_SHARED_DEV_BUCKET` or
`NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION=false`. Production rules, which Preview
deployments also follow, reject both at startup.

Vercel bakes `NEXT_PUBLIC_*` values into the build, so redeploy after you change
them.

### Production: the pilot setup

Set the same variables with the **Production** scope. Point them at the pilot
Supabase project, and set `NEXT_PUBLIC_APP_URL` to the production URL. In the
pilot project's Supabase Authentication → URL Configuration, set the Site URL
to the production URL, and add `<app-url>/auth/callback` to the redirect URLs.

The pilot has no custom domain. The website can use its public Vercel deployment
URL. Invitation email is optional: while the SMTP variables are unset, the owner
shares each invitation with Copy Link on the Team page. Auth confirmation and
recovery email must still pass the acceptance checks below.

### Brevo email setup

Brevo delivers mail through the existing Nodemailer SMTP transport. No Brevo SDK,
new API endpoint, database migration, or application-managed Auth tokens are
needed. Other SMTP providers remain supported with an explicit `EMAIL_FROM`.

1. In Brevo, add a sender under Settings → Senders, Domains, IPs → Senders. Use
   `Tracknologia` as its name and an address your team controls. Complete the
   email verification code if requested. This does not require a Gmail App Password.
2. Confirm transactional sending is activated. New accounts may need support
   activation; a verified sender alone is not evidence that sending is enabled.
   If Brevo requires domain authentication for this account, stop the no-domain
   rollout until that requirement is resolved. Check the current account quota
   before inviting participants.
3. Under Settings → SMTP & API → SMTP, copy the SMTP login and generate an SMTP
   key. Use the SMTP key, not a Brevo API key, account password, or Gmail password.
   The SMTP login may end in `@smtp-brevo.com`; do not put it in `EMAIL_FROM`.
4. Set the following in `.env.local` for app invitation testing and in the
   appropriate Vercel environment for deployment. Replace every placeholder:

   ```env
   SMTP_HOST=smtp-relay.brevo.com
   SMTP_PORT=587
   SMTP_USER=<Brevo SMTP login>
   SMTP_PASSWORD=<Brevo SMTP key>
   EMAIL_FROM="Tracknologia <your-verified-sender-address>"
   ```

   Restart `pnpm dev` after editing local settings; redeploy after changing
   hosting variables. Never commit credentials. If all SMTP credentials are
   absent, local/test mode only logs recipient, sender and subject metadata and
   simulates success; production sends nothing and returns Copy Link.

5. Separately, in Supabase Authentication → SMTP Settings, enable Custom SMTP:

   | Field        | Value                                               |
   | ------------ | --------------------------------------------------- |
   | Host         | `smtp-relay.brevo.com`                              |
   | Port         | `587`                                               |
   | Username     | The Brevo SMTP login                                |
   | Password     | The Brevo SMTP key                                  |
   | Sender email | The verified sender address, without a display name |
   | Sender name  | `Tracknologia`                                      |

   Supabase sends confirmation/recovery mail; the app sends staff invitations.
   Configuring either one does not configure the other. Use separate keys for
   the two senders when practical so they can be rotated independently.

6. In Supabase Authentication → URL Configuration, set Site URL to the public app
   URL and allow `<app-url>/auth/callback`. Set `NEXT_PUBLIC_APP_URL` to the same
   origin. Keep Supabase's Confirm email setting enabled for the pilot and set
   `NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION=true` for deployed environments. The
   app flag cannot change Supabase's confirmation setting. For a local manual
   test, allow `http://localhost:3000/auth/callback` in the test project and use
   `http://localhost:3000` as the app origin.
7. Install/check the hosted Auth templates below, then run the delivery checks.
   Retain the existing app invitation template and inline logo. Brevo only
   transports these messages; no Brevo automation or template rebuild is needed.

Without a custom domain, Brevo may allow an individually verified free-email
sender but replaces the outgoing address with a Brevo-managed address. This is
a temporary pilot arrangement, not a guarantee of account approval or inbox
placement. Authenticate a team-owned domain when available. Do not use
`onboarding@resend.dev` or an address you do not control as the Brevo sender.

References: [SMTP setup](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP),
[sender verification](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email),
[activation troubleshooting](https://help.brevo.com/hc/en-us/articles/115000188150-Troubleshooting-Issues-with-Brevo-SMTP),
and [free-sender address replacement](https://help.brevo.com/hc/en-us/articles/14925263522578-Comply-with-Gmail-Yahoo-and-Microsoft-s-requirements-for-email-senders).

### Supabase Auth email templates

Supabase Auth sends both sign-up confirmation and password recovery emails.
Do not assume the application's SMTP settings or email templates configure it:

- **Sign-up confirmation template**: use `supabase/templates/confirmation.html`.
  Local Supabase reads it through `supabase/config.toml`. In each hosted project's
  Authentication → Emails → "Confirm sign up", paste the template and set the
  subject to "Confirm your Tracknologia email". Keep `{{ .ConfirmationURL }}`
  intact in the button and fallback; it lands on `/auth/callback?next=/confirmed`.
  This uses the same public logo and hosted
  rollout steps described for recovery below. Local email confirmations remain
  disabled by default; installing the template does not change that setting.
- **Redirect allow list**: Supabase → Authentication → URL Configuration must
  allow `<app>/auth/callback` for each environment (local, preview, production),
  where `<app>` is the value of `NEXT_PUBLIC_APP_URL`. The recovery link lands
  on `/auth/callback?next=/reset-password`; a missing entry shows Supabase's
  own "redirect not allowed" error instead of the app.
- **Recovery email template**: the branded template is
  `supabase/templates/recovery.html` (local Supabase reads it through
  `supabase/config.toml`). For each hosted project, paste it into Supabase →
  Authentication → Emails → "Reset password" and set the subject to "Reset your
  Tracknologia password". It must keep `{{ .ConfirmationURL }}`; the app
  routes the exchange itself.
  The logo loads from `{{ .SiteURL }}/email/wordmark.png`, using the public
  asset in this repo. Deploy that asset before saving the template, and check
  that the configured Site URL serves it without a sign-in or deployment
  protection prompt. A protected preview can instead use an absolute URL to
  the same logo on the public production deployment; change only the image
  `src`, never the recovery links. Image blocking still leaves a text logo
  alternative and the full reset link. Apply the updated template separately
  to staging and production; an app deployment does not update hosted Auth
  templates. See [Supabase's template documentation](https://supabase.com/docs/guides/auth/auth-email-templates).
- **Email sending**: uses the Supabase SMTP settings above, not the app's
  `SMTP_*` variables. Password recovery therefore still works when the app's
  invitation `SMTP_*` settings are intentionally unset and staff invitations
  run on Copy Link only.
- Each environment needs its own check: request a reset for a test address in
  that environment and open the link end to end (see the pre-launch check
  step 4 below).

### Production: pre-launch acceptance check

Run this check on the production deployment **before the pilot opens**, against
the pilot Supabase project. That project holds no participant data before
launch. The owner approved running the check here (#109, 2026-10-30).

1. Open the Vercel deployment page and confirm it shows the exact merged commit you expect. Record that SHA.
2. Put the marker `SMOKE-TEST` in every test title or message you submit. Create the test Provider account through the normal registration UI, with `SMOKE-TEST` in its name.
3. Run the checklist on the production URL:
   - A Tracking lookup with the tracking code of a `SMOKE-TEST` Repair shows the Repair.
   - A Repair Request submitted from the test Provider's public page succeeds.
   - Feedback submission succeeds.
   - **Throttle:** from one device, the 21st feedback submission within 10 minutes is throttled (default `PUBLIC_ABUSE_FEEDBACK_MAX=20`).
   - **Spoof:** repeat the throttle check with a browser header extension, such as ModHeader, adding forged `x-vercel-forwarded-for`, `x-forwarded-for`, `x-real-ip` and `x-tracknologia-client-ip` values. It must still throttle at the 21st submission.
   - **Isolation:** from a second device on a different network, such as a phone on mobile data, a submission still succeeds while the first device is throttled.
4. Check hosted Auth email (Supabase Auth through the Brevo SMTP settings above):
   - Confirm the Supabase custom SMTP settings are saved and enabled.
   - Sign up with a test address **not** on the Supabase organization team. Confirm the confirmation email arrives and its link opens the app.
   - Request a password reset for that address. Confirm the reset email arrives and its link works.
   - Note the Supabase Auth email rate limit and Brevo's current account quota. If either blocks a flow, record that flow as failed. Check the inbox, spam folder and Brevo transactional logs; SMTP acceptance alone does not prove inbox delivery.
   - **A failure is NO-GO for the pilot.** Do not fix it by turning off email confirmation in production; the app rejects `NEXT_PUBLIC_REQUIRE_EMAIL_CONFIRMATION=false` at startup.
   - If Brevo rejects the sender or has not activated transactional sending, resolve that requirement with Brevo before launch. Do not bypass confirmation to work around the failure.
5. Check app staff-invitation email. This uses the app's own `SMTP_*` settings, separate from Supabase Auth:
   - If `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` and `EMAIL_FROM` are set on Vercel for this deployment, a test Shop OWNER invites a **non-team** test mailbox from the Team page. Confirm the invitation email arrives, uses the intended sender, and its link allows registration/onboarding with the invited email address.
   - If the SMTP settings are intentionally unset, do not claim email invitations work. Confirm the Team page shows "Invitation created" with a Copy Link button, and record that the pilot runs on Copy Link only.
   - If delivery fails, the invitation must still show its Copy Link. Record the failure, and do not advertise email invitations until this check passes.
   - Repeat the three email flows with separate Gmail and Outlook test mailboxes. Verify real confirmation/recovery links, never `code=PREVIEW`, and confirm they use the deployed origin rather than `localhost`. Existing pending invitations are reused without another send: revoke and create a fresh invitation for a new delivery test.
6. Record pass or fail for each check, including both hosted Auth flows and the app invitation check, the deployed SHA and the date only. Do not record IP
   addresses, tracking codes, message bodies, links or credentials.

### Test data cleanup

Delete all `SMOKE-TEST` data before you invite anyone. Use this order, because
feedback has no link to a Provider and cannot be removed by deleting one:

1. **Feedback:** the owner runs the feedback-purge runbook in `docs/OPERATIONS.md` ("Feedback redaction and deletion") for each `SMOKE-TEST` submission. It is owner-only, irreversible and needs an approval reference.
2. **Test Provider:** in the Supabase dashboard, delete the `SMOKE-TEST` Provider. This cascades to its Repairs, Repair Requests, status events, updates and tracking observations.
3. **Test user:** in Supabase Authentication, delete the `SMOKE-TEST` user.

### Preview deployments (optional)

Preview deployments are not needed for the pre-launch check. If you use one,
give it its own Preview-scoped variables, following the list above. A Preview
must never hold real participant data.

## Start the application

First run:

```bash
docker compose up --build
```

Normal runs:

```bash
docker compose up
```

Application:

```text
http://localhost:3000
```

Stop:

```bash
docker compose down
```

## Dependency commands

Install repository dependencies from the lockfile:

```bash
pnpm install
```

Add a runtime dependency:

```bash
pnpm add <package>
```

Add a development dependency:

```bash
pnpm add -D <package>
```

Commit both `package.json` and `pnpm-lock.yaml` when dependencies change.

## Quality commands

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:run
pnpm build
```

## End-to-end (Playwright) testing

E2E runs on the host machine and in GitHub Actions only — not inside the Docker
dev container (the Alpine development image does not install Playwright
Chromium/system dependencies).

Run the suite with `pnpm test:e2e`. Before running it:

1. Install the Chromium browser once:
   ```bash
   pnpm exec playwright install --with-deps chromium
   ```
2. Start a **local** Supabase stack and point `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` at it
   (`supabase start` prints the local values). Reset the database first:
   ```bash
   supabase start
   pnpm db:reset
   ```
   The committed `supabase/config.toml` starts only the services the test
   suites need (Postgres, Auth, REST, gateway; issue #80), so no extra flags
   are required.
   The fixtures seed and delete actors/tenants via the service-role key, so
   they refuse to run against anything but a local `localhost`/`127.0.0.1`
   stack — never production or shared mutable data.
3. Optionally set `E2E_BASE_URL` to the app URL. When omitted, Playwright's
   `webServer` starts the app in dev mode at `http://localhost:3000`.

The suite must stay deterministic: no arbitrary sleeps, each scenario owns and
cleans up its data, retries are disabled by policy, and a flaky
release-critical test is a defect rather than something to normalize with
reruns.

## Supabase & Database Migrations

Each development environment connects to the Tracknologia Supabase project.

The application uses:

- Supabase Auth;
- PostgreSQL;
- Least-privilege RLS policies;
- `@supabase/supabase-js`;
- `@supabase/ssr`.

### Applying Migrations

1. Link to the development project (one time):
   ```bash
   npx supabase link --project-ref <project-ref>
   ```
2. Push migrations:
   ```bash
   npx supabase db push
   ```

Do not place service-role/secret keys in public browser environment variables.

Never commit `supabase/.temp/` CLI state.

### Internal operator access

`20261029090000_add_internal_operator_access.sql` creates private
`internal_operators` and `internal_access_audit` tables plus service-role-only
functions. It seeds no identities: after migration, ordinary accounts, Provider
OWNERs, and staff still have no `/internal` access.

Provisioning and revocation are manual, owner-approved operations documented in
`docs/OPERATIONS.md`. Use the service-role credential locally only with
disposable test identities; the E2E/DB fixtures create and delete those
identities themselves.

## Native Node fallback

Docker is canonical. If a developer temporarily needs to run the application directly on the host, use the Node major version documented by the repository and run:

```bash
pnpm install
pnpm dev
```

A problem that occurs only outside the Docker environment is not sufficient evidence that the repository's canonical setup is broken.
