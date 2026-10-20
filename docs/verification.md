# Order Pad verification

A dated log of automated check results and owner-reported hardware evidence, **newest first**. Each entry describes the code as it was on that date; later entries supersede earlier ones. For current behavior, read [README](../README.md). Automated checks use mocked printer commands and API responses and never prove physical output.

## Station releases and automatic updates — 2026-10-19

Pushing a `v*` tag now runs the full Checks suite and publishes a station release. The release is a self-contained linux-x64 tarball with its Node runtime, production dependencies and migrations, plus build provenance. Each station's `order-pad-update.timer` installs new releases inside its own window, and only after `QUIET_MINUTES` of unchanged database activity with an empty CUPS queue. It backs up first, then migrates, switches and checks health, and returns to the previous release on failure. On SIGTERM the service now refuses new prints and waits for a job already sent to `lp` to record its outcome. `prisma` moved to `dependencies`, and the version is 0.2.0.

All required checks passed in order:

- 30 integration tests on a disposable PostgreSQL 18 container (port 55432, not the station database), including the new activity-fingerprint and applied-migration tests, and volume recreation.
- Type checks with zero errors and warnings. Formatting is clean for every tracked file; the only warnings are in an untracked `.claude/worktrees/` copy.
- 329 unit/HTTP tests, including the updater state machine (install, busy, outside the window, manual migrations, failed backup, failed migration, health-check rollback, verification and staging) and the real command runner and probe.
- Both builds, and 159 Chromium tests.
- `npm run package:release -- v0.2.0` produced a 149 MB tarball. `scripts/smoke-release.mjs` unpacked it, migrated a fresh database with the bundled Prisma, started the packaged server in PDF mode, got 200 from `/api/auth/config`, loaded `ops.mjs` and stopped the server cleanly.
- cosign v3.1.3 `verify-blob-attestation` accepted a public `actions/attest` bundle (from the GitHub CLI's own v2.102.0 release) with the flags the updater uses. It rejected that bundle under a different workflow identity, and rejected a modified file.
- actionlint 1.7.12 and shellcheck 0.10.0 reported nothing for the workflows and `deploy/install-station.sh`.
- A read-only probe of the live station confirmed `/api/auth/config` answers 200 on loopback with `CF-Connecting-IP` and 403 without it.

Not yet run: the Release workflow on GitHub, `install-station.sh`, systemd units, the `order-pad` service user and the timer on a real machine, and the move of this station to releases. No station data was changed.

## One-time access codes, one per device — 2026-10-19

The shared shift code is replaced by one-time codes. A mint makes 1 to 5 codes, with at most 10 unused at once. Each code must be used within 60 minutes, works once, and opens one 8-hour session. A unique `auth_sessions.code_id` enforces the single use. Minting no longer signs anyone out. The tailnet admin page asks how many codes to mint in a field capped at 5. It lists unused codes (**Void**) and signed-in devices (**Sign out**), and has **Sign out everyone**. Each code prints its own slip, and printing stops after the first failed slip without voiding any code. The `device_access_codes` migration voids existing codes and sessions. The unmerged station-approval branch was not used.

All required checks passed in order:

- 28 integration tests and volume recreation on a disposable PostgreSQL 18 database. The local `order_pad_test` database was recreated because it held the unmerged approval migration.
- Type checks with zero errors and warnings, and formatting.
- 311 unit/HTTP tests.
- Both builds, and 159 Chromium tests, including the capped count field, per-code slips, voiding, signing out and lost replies.
- `access-cli.mjs` in PDF mode against the test database: `mint 3` saved three slip PDFs, `mint 6` and an 11th unused code were refused with nothing minted, and `revoke` voided all unused codes.

No station data was touched and no physical slip was printed. Slip cutting and sign-in on real devices remain owner checks.

## Sign-in and access-code admin redesign — 2026-10-18

The sign-in screen and the tailnet admin page now follow the Order Builder & Ticket design canvas.

- **Sign-in:** the code field drops characters the code alphabet never uses, capitalises and adds the dash as you type, and shows a live character count. **Start shift** stays disabled until all 10 characters are in. A rejected code now points staff to the latest slip. A “Where’s the code?” card replaces the footer note.
- **Admin page:** it has the app’s olive header, logo and Poppins font, which the listener serves from the static build under `img-src`/`font-src 'self'`. The status card shows a state badge, expiry, time left and signed-in devices, with one state-matched main action. Revoke appears only while a code is active. Confirmations name the devices that will be signed out. The new code appears in a large card with Copy and Hide, the slip result is styled separately, and a lost reply gets its own warning card.
- **Service:** mint and revoke results include `signedOut`, and a successful login returns the session expiry.
- **Cleanup:** removed the unused password/passkey icons, enrollment styles and per-user workspace wording left from personal accounts.

All required checks passed in order:

- 27 integration tests on a disposable PostgreSQL 18 container (since removed), and volume recreation.
- Type checks with zero errors and warnings, and formatting.
- 301 unit/HTTP tests.
- Both builds, and 158 Chromium tests, including new admin-page layout, replacement and lost-reply checks.

No station data was touched and no slip was printed. The admin page and sign-in on real devices remain owner checks.

## Tailnet-only access-code admin page — 2026-10-18

Added an optional second listener (`printer-service/admin-http.ts`) for minting, checking and revoking access codes from a browser. It listens on a private Unix socket, meant to be published only with Tailscale Serve on `:8443`. It requires the admin host and the Tailscale app capability named in `ORDER_PAD_ADMIN_CAPABILITY`, which the tailnet policy grants to tagged devices. An allowlist of user logins came first and was replaced the same day, because Serve sends no login for tagged devices and the owner wants per-device, revocable access. POSTs also need the admin `Origin`, JSON, explicit confirmation and a once-only `requestId`, and only one change runs at a time. The main `createApp` still has no admin route. The uncommitted Android/SSH shortcut was withdrawn before commit.

A browser test found that Chromium silently resends a POST when a reused connection closes before any reply. Without the request ID this minted two codes. The station now refuses the resend with 409, and the page tells the owner a code may already be valid.

Verification passed:

- 27 integration tests on a separate disposable PostgreSQL 18 container, and volume recreation.
- Type checks with zero errors and warnings, and formatting.
- 300 unit/HTTP tests, including the admin listener’s capability and host checks, socket permissions and configuration.
- Both builds, and 156 Chromium tests, including the admin page.

A bundled PDF-mode service also ran against the disposable database on a temporary socket. Requests without the required identity were refused, the database mint saved a slip PDF, the resend got 409, the public port answered 401, the journal recorded the login without the code, and shutdown removed the socket.

On the station, the systemd runtime directory and Tailscale Serve `:8443` were then configured. The first request through Serve was refused, because Serve sends `Host: localhost` to Unix-socket backends (tailscale v1.104.1 `serve.go`). The listener now checks Serve’s `X-Forwarded-Host` in that case. Access then moved from a login allowlist to a tag-granted app capability. The admin page moved from `:8443` to the tailnet’s port 443, replacing the old Serve route to the staff app, which had stopped working once the service origin became the public hostname. After the owner saved the policy grant, tagged the Galaxy S10e `tag:order-pad-admin` and restarted the service, the station checks passed. Serve published only `:443` with `AcceptAppCaps`, and `tailscale whois` showed the phone holding the capability. The untagged station was refused with 403 through Serve, `:8443` no longer answered, and the public hostname returned 401. A physical slip and tailnet sign-in remain untested; see [Tailnet admin page](linux-printing.md#tailnet-admin-page).

## Shared access codes replace personal accounts — 2026-10-16

Replaced usernames, passwords, passkeys, enrollment and recovery with one shared access code minted on the station terminal (`npm run access -- mint|status|revoke`). A code lasts 8 hours; every session it opened ends with it, and minting a new code voids the old one and its sessions. Workspaces now follow the browser cookie, so a device keeps its draft and recovery across codes. The `access_codes` migration drops the account tables and reattaches workspaces for browsers that had exactly one account.

All required checks passed in order: 27 PostgreSQL integration tests against a disposable PostgreSQL 18 container (separate from the station database), volume persistence, type checks (zero errors/warnings), lint, 234 unit/HTTP tests, both builds and 150 Chromium runs. A Turnstile browser test that could read its reset counter before the mocked widget loaded now waits for the widget; it then passed 30 of 30 repeated runs under parallel load. The bundled CLI was exercised in PDF mode against the disposable database (status, mint with a saved slip, mint `--no-print`, revoke, unknown command); the slip PDF rendered legibly. No station data was touched, and no physical slip or receipt was printed. Printing the slip on the Star printer and live Cloudflare/Turnstile sign-in remain owner checks.

## Turnstile widget lifecycle — 2026-10-15

Removed the reset immediately after widget creation. A successful token now stays ready for submission; subsequent attempts explicitly refresh the widget, with third-party callbacks and bound token updates excluded from reactive dependency tracking. A browser regression checks zero initial resets, token submission and exactly one refresh after rejection. PostgreSQL coverage explicitly checks the Siteverify endpoint, submitted token and visitor IP.

The new browser check failed on the previous build because the widget reset before submission, then passed with the fix. All required checks passed in order: 30 PostgreSQL integration tests against a disposable PostgreSQL 18 database, volume persistence, type checks (zero errors/warnings), lint, 233 unit/HTTP tests, both builds and 145 Chromium runs. The temporary database container was removed. A deliberately invalid token sent through the public login API was rejected, and a direct Siteverify connectivity check returned HTTP 200 with `invalid-input-response`. No real account credentials were used, no sessions were created and no print was submitted. A successful widget challenge still requires the owner’s interactive browser; password recovery remains available through the local account CLI.

## Authentication page deployment fix — 2026-10-15

The public tunnel reached the service, but `/login/` returned 404 because authentication pages were built as `login.html` while the service serves page directories with `index.html`. The root layout now builds all pages with trailing slashes, and missing static files report “Not found” instead of suggesting a CUPS failure. A regression check runs the actual Node HTTP server against the production build, covering login, enrollment, recovery and the authenticated account page.

Verification used a disposable PostgreSQL 18 container and test database. All required checks passed in order: 30 PostgreSQL integration tests, volume persistence, type checks (zero errors/warnings), lint, 233 unit/HTTP tests, both production builds and 144 Chromium runs. The temporary database container was removed afterward.

Live HTTPS checks through the configured Cloudflare Tunnel returned 200 HTML with `no-store` for login, enrollment and recovery, 200 for the login page’s linked scripts/styles, and a login redirect for an unauthenticated account request. CUPS had no pending jobs and the station database had no unfinished print attempts or dispatches. The rebuilt pages are active; restarting the Node service to load the revised error messages requires the owner’s sudo password. No print was submitted. Interactive Turnstile, real-device passkeys and physical printing remain owner checks.

## Authentication and PDF development integration — 2026-10-15

Merged the PDF development printing changes from main into the authentication branch, retaining both verification histories and features. Saved receipt downloads now resolve the authenticated user/browser workspace before checking dispatch ownership; unauthenticated requests are rejected before receipt lookup or file reads. The bundled account CLI shares the service’s origin validator so PDF development supports localhost HTTP. Development instructions retain mandatory authentication and specify direct proxy mode and localhost Turnstile keys.

Checks ran on Linux with Node 24.21.0 in the required sequence. PostgreSQL integration used a fresh disposable PostgreSQL 18 container and a separate `_test` database; no station data was changed. The bundled account CLI was smoke-tested with `list` using PDF mode and a localhost HTTP origin.

| Check                        | Result                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| npm run test:postgres        | Passed; 30 tests across 4 files.                                                                              |
| npm run test:postgres:volume | Passed; disposable volume survived container recreation.                                                      |
| npm run check                | Passed; svelte-check 0 errors / 0 warnings and both TypeScript checks clean.                                  |
| npm run lint                 | Passed.                                                                                                       |
| npm test                     | Passed; 232 tests across 20 files, including PDF ownership, authentication gates and output persistence.      |
| npm run build                | Passed.                                                                                                       |
| npm run build:printer        | Passed; service and account CLI bundled.                                                                      |
| npm run test:e2e             | Passed; 143 Chromium runs, including PDF printing/viewing/reload/reprint and authentication/session recovery. |

No physical printer was used. Public Cloudflare, real Turnstile, physical-device passkeys and physical-print acceptance remain deployment/owner checks.

## Application authentication and Cloudflare Tunnel readiness — 2026-10-15

Added mandatory application sessions, username/password and optional discoverable passkeys, server-verified Turnstile, persistent login rate limits, credential management and a bundled terminal-only account command. All enabled accounts have the same ordering/printing/queue access. Local bootstrap creates the first account; single-use enrollment and recovery codes need no messaging provider. Each user/browser pair gets an isolated workspace, and browser requests bind to the initially loaded user so an old tab cannot write into another account after a cookie change. Existing anonymous workspaces and order history remain untouched.

Protected HTML and operational APIs require authentication. HTML uses per-response CSP nonces and is never served from the service-worker cache. SSE rechecks authorization before snapshots and on heartbeats and closes at expiry. Session loss waits for active saves/prints to settle before returning to login; durable outcomes recover without another print call. Account navigation uses Order tools and the queue header to preserve the fixed-height ordering layout.

Checks ran on Linux with Node 24.21.0, in the AGENTS.md sequence. PostgreSQL checks used a dedicated temporary PostgreSQL 18 container on loopback port 55438 and a disposable `_test` database, removed afterward. No station database was migrated or changed. The bundled account CLI was also smoke-tested with `list` against that test database.

| Check                        | Result                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm run test:postgres        | Passed; 30 tests across 4 files, including atomic bootstrap/enrollment, expiry/revocation/recovery, persistent rate limits, user/browser isolation, signed WebAuthn registration/authentication, origin/UV/replay/counter rejection and bounded cleanup. |
| npm run test:postgres:volume | Passed; disposable PostgreSQL 18 volume survived container recreation.                                                                                                                                                                                   |
| npm run check                | Passed; svelte-check 0 errors / 0 warnings and both TypeScript checks clean.                                                                                                                                                                             |
| npm run lint                 | Passed.                                                                                                                                                                                                                                                  |
| npm test                     | Passed; 222 tests across 19 files, including protected routes, authentication POST guards, trusted proxy IP handling, secure cookies, CSP nonces, old-tab user binding, SSE revocation and structured pre-dispatch print rejection.                      |
| npm run build                | Passed.                                                                                                                                                                                                                                                  |
| npm run build:printer        | Passed; emits both server.mjs and auth-cli.mjs.                                                                                                                                                                                                          |
| npm run test:e2e             | Passed; 140 Chromium runs, including virtual-authenticator passkeys, enrollment, logout/history/offline protection, account switching, session loss during printing without replay and existing responsive ordering/queue scenarios.                     |

Automated Turnstile checks use injected verification responses and browser widgets; passkey browser checks use a virtual authenticator. Live Cloudflare Tunnel/DNS/HTTPS configuration, real Turnstile on the final hostname, physical-device passkeys, SSE through the public tunnel and the physical-printer acceptance checklist remain deployment/owner checks. No physical print was sent and no hardware result is claimed. Configure the final origin and Turnstile keys, explicitly deploy the new migration, bootstrap an account and configure the tunnel before public use; see [Linux deployment](linux-printing.md).

## PDF development printing — 2026-10-14

Added explicit PDF-only service output, cross-platform startup, atomic receipt files, workspace-protected PDF viewing and browser links restored after reload. CUPS remains the default. No database migration is required.

Verification ran on Windows with Node 26.9.0. Unit/HTTP and browser tests ran outside the sandbox because its temporary-file and loopback restrictions prevented normal execution. Unit and browser suites passed when run separately; running both simultaneously caused the existing exhaustive menu test to exceed its timeout.

| Check                          | Result                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run test:postgres`        | Unavailable: no `TEST_DATABASE_URL` or disposable PostgreSQL 18 test database configured.                                                                                                                    |
| `npm run test:postgres:volume` | Unavailable: Docker Desktop Linux engine was not running.                                                                                                                                                    |
| `npm run check`                | Passed; svelte-check 0 errors / 0 warnings and both TypeScript checks clean.                                                                                                                                 |
| `npm run lint`                 | Passed.                                                                                                                                                                                                      |
| `npm test`                     | Passed; 216 tests across 19 files, including actual receipt PDFs, page dimensions, distinct reprints, dispatch-before-save, interrupted saving without replay, workspace ownership and PDF response headers. |
| `npm run build`                | Passed.                                                                                                                                                                                                      |
| `npm run build:printer`        | Passed.                                                                                                                                                                                                      |
| `npm run test:e2e`             | Passed; 137 Chromium runs, including PDF mode, viewing, reload recovery of the link and reprinting at all three builder viewport sizes.                                                                      |

No physical print job was sent and no hardware result is claimed. Real PostgreSQL checks remain required in an environment with the test database and Docker available.

## Independent browser workspaces and database-assigned numbers — 2026-10-13

Each browser profile now receives an anonymous `__Host-order-pad-workspace` cookie and owns its own Postgres draft, revision, latest ticket and recovery state. Editable drafts have no number; the service allocates the next global number atomically with print intent and returns the authoritative ticket. The `20261015000000_browser_workspaces` migration preserves the existing station draft, latest ticket, attempts and dispatches for the first browser after upgrade and seeds the counter above all stored references. Print requests queue FIFO (eight waiting, 30-second slot limit), then wait up to 30 seconds for pending CUPS jobs before submitting once. Revision conflicts now show “Open in another tab” instead of “Database needs attention”.

Checks ran on Linux with Node 24.21.0, in the AGENTS.md order. `npm run test:postgres` used a newly created disposable PostgreSQL 18 container on a random loopback port, removed afterward; the station database was not touched.

| Check                        | Result                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm run test:postgres:volume | Passed; disposable PostgreSQL 18 volume survived container recreation.                                                                                                                                                      |
| npm run test:postgres        | Passed; 18 tests across 3 files, including concurrent number allocation, rollback without consuming numbers, workspace ownership, same-workspace revision conflicts and migration of editable, accepted and unknown states. |
| npm run check                | Passed; svelte-check 0 errors / 0 warnings and both TypeScript checks clean.                                                                                                                                                |
| npm run lint                 | Passed.                                                                                                                                                                                                                     |
| npm test                     | Passed; 204 tests across 18 files, including FIFO order, eight-waiter capacity, slot timeout, CUPS queue clearing and timeout, duplicate coalescing and attempts finalized while waiting.                                   |
| npm run build                | Passed.                                                                                                                                                                                                                     |
| npm run build:printer        | Passed.                                                                                                                                                                                                                     |
| npm run test:e2e             | Passed; 128 Chromium runs, including a two-browser-context scenario covering independent editing, serialized concurrent prints, authoritative numbers and isolated recovery.                                                |

No physical print job was sent and no hardware result is claimed. Steps 7 and 8 of the acceptance checklist in [Linux printing](linux-printing.md) remain owner-run checks. Deployment requires `npm run db:deploy` for the new migration and a coordinated app/service restart.

## PWA station endpoint diagnosis — 2026-10-13

The reloaded PWA showed “Database needs attention.” Read-only inspection found local PostgreSQL 18 healthy and both committed migrations already applied to the station database. The managed `order-pad.service` process started before the new build and returned 404 for `/api/database` and `/api/station`, confirming an app/service version mismatch. CUPS reported no pending jobs.

An orderly service-manager restart was attempted but required the owner's administrator password. The service remains on its older process pending `sudo systemctl restart order-pad.service`, followed by a PWA reload and endpoint verification. No database migration, data deletion or physical print was performed during this diagnosis.

## Required local Postgres station persistence — 2026-10-12

Postgres now owns the shared draft, reference counter, immutable tickets, print attempts, exclusive dispatch claims and order events. Browser order persistence and the publication outbox are removed, along with the `fake-indexeddb` dependency. First-order intent and queue capture commit atomically; stale tabs cannot overwrite newer revisions. Recorded service results recover lost replies, while unresolved pending attempts remain unknown and never replay. The app service requires a loopback database on the same machine, checks the migrated schema before listening, and rejects API work during database outages. Idle browser health checks block editing until recovery and reload.

Checks ran on Linux with Node 24.21.0. Real database checks used a newly created disposable PostgreSQL 18 container on a random loopback port; no station migrations or data changes were performed.

| Check                        | Result                                                                                                                                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm run test:postgres:volume | Passed; disposable PostgreSQL 18 volume survived container recreation.                                                                                                                                      |
| npm run test:postgres        | Passed; 12 tests covering atomic rollback, cross-client revisions, dispatch durability, lost-response recovery, restart reads, full API client/session flow, tracking-disabled capture and outage blocking. |
| npm run check                | Passed; svelte-check 0 errors / 0 warnings and both TypeScript checks clean.                                                                                                                                |
| npm run lint                 | Passed.                                                                                                                                                                                                     |
| npm test                     | Passed; 195 tests across 18 files.                                                                                                                                                                          |
| npm run build                | Passed.                                                                                                                                                                                                     |
| npm run build:printer        | Passed.                                                                                                                                                                                                     |
| npm run test:e2e             | Passed; 127 Chromium runs including unavailable browser persistence APIs, database outages, shared drafts and stale-tab protection at all builder viewport sizes.                                           |
| Bundled service readiness    | Passed; starts against local test Postgres and answers `/api/database`, refuses startup against an unavailable database before listening. No CUPS calls made.                                               |

No physical print job was sent and no new hardware result is claimed. Rollout requires the committed station migration, coordinated app/service deployment and reconciliation of old browser drafts, unpublished orders and unresolved attempts. Legacy IndexedDB and `.print-data/` are preserved as archives and are not automatically imported. Existing Postgres queue events remain intact. See [README’s upgrade steps](../README.md#set-up-postgres-and-upgrade-the-station).

## Print rejection diagnosis and station restart — 2026-10-12

The browser’s generic “The Linux service did not return a matching result” message hid explicit service validation/origin rejections. The Linux adapter now recognizes the service’s known 400/403/413 error bodies as failed before submission, with actionable “No job was submitted” copy. Unexpected errors, malformed responses, timeouts, wrong attempt IDs, and non-success responses containing apparent accepted results remain unknown. No print retry or historical result rewrite was added.

Inspection found that the Mint systemd service was still the pre-Postgres process, while rebuilt files were already served. `.env` also contained a misspelled HTTPS hostname. Corrected the hostname to the observed Tailscale Serve origin, updated the ignored local launcher to load `.env`, and prepared a systemd environment-file drop-in. The owner installed it and restarted `order-pad.service`; verified the new process loads the repository’s `.env`. Read-only HTTPS checks reported a ready Star queue and a working empty Postgres order projection. Deliberately invalid empty POST requests returned 400 without submitting anything; CUPS reported no pending jobs. A temporary alternate-port service used only for readiness checks was stopped.

| Check                 | Result                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| npm run check         | Passed; svelte-check 0 errors / 0 warnings and both TypeScript checks clean                                   |
| npm run lint          | Passed                                                                                                        |
| npm test              | Passed; 205 tests across 19 files, including recognized pre-submit errors and ambiguous-response preservation |
| npm run build         | Passed                                                                                                        |
| npm run build:printer | Passed                                                                                                        |
| npm run test:e2e      | Passed; 124 Chromium runs                                                                                     |

The owner reloaded the app and confirmed “Print now works” after the service restart. This is owner-reported evidence that printing resumed; receipt layout, cut quality, and interruption recovery were not separately checked. No valid print request was sent by the agent. Previous unknown attempts remain immutable and still require operator acknowledgment.

## PostgreSQL 18 order history — 2026-10-12

Implemented Prisma 7.10.0 and PostgreSQL 18 as the primary order store, using one append-only `order_events` table and latest-event queue projection. Capture is independent of queue visibility. Pre-cutoff submissions receive explicit exclusion acknowledgments; browser storage stays at version 2 and local order files remain archives. Checks ran on Linux with Node 24.21.0 and real PostgreSQL 18 in a disposable Docker container.

| Check                        | Result                                                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm run test:postgres        | Passed; 6 real database integration tests, including migrations, cross-client concurrent submission/completion, immutable history, restart reads, latest-state filtering, tracking-disabled capture, cutoff exclusion, and database outages with stubbed printing |
| npm run test:postgres:volume | Passed; PostgreSQL 18 named-volume data survived container removal and recreation; disposable container and volume cleaned up                                                                                                                                     |
| npm run check                | Passed; svelte-check 0 errors / 0 warnings, printer-service and service-worker TypeScript clean                                                                                                                                                                   |
| npm run lint                 | Passed                                                                                                                                                                                                                                                            |
| npm test                     | Passed; 194 tests across 19 files                                                                                                                                                                                                                                 |
| npm run build                | Passed                                                                                                                                                                                                                                                            |
| npm run build:printer        | Passed                                                                                                                                                                                                                                                            |
| npm run test:e2e             | Passed; 124 Chromium runs including disabled capture, outbox reload recovery, cutoff acknowledgment, and live-queue recovery after a lost commit reply                                                                                                            |
| npm install audit            | 0 vulnerabilities after pinning patched `deepmerge-ts` and `mysql2` CLI dependencies through package overrides                                                                                                                                                    |

Read-only runtime smoke check: the bundled service served `/api/orders` from the real Postgres test database on an isolated loopback port. The browser service fixture explicitly closes raced keepalive connections during teardown. Queued order operations time out without executing expired writes, and failed snapshot delivery disconnects SSE while preserving successful mutations. Uncertain write failures retire old stream versions and force snapshots that discover commits with lost replies.

No physical print job was sent and no hardware result is claimed. Station rollout still requires a configured `.env`, an explicitly chosen fixed capture cutoff, migration deployment, and coordinated service/browser reloads; see README’s Postgres setup steps. Test database storage is disposable and separate from station history.

## SvelteKit 3 migration — 2026-10-12

Upgrade from SvelteKit 2 to SvelteKit 3.0.1 (Vite 8.3.4, vite-plugin-svelte 7.3.1, adapter-static 4.0.0, TypeScript 6.0.3) on top of `main` at `0df5798`, uncommitted at the time of the run. After `sv migrate sveltekit-3`, the manual steps were: the service worker moved to `src/service-worker/index.ts` with its own `tsconfig.json` and reads `version` from `$app/env` and the precache list from `$app/manifest` through `$app/paths`; the root `tsconfig.json` excludes it, and `npm run check` now type-checks it separately; the obsolete `cookie` override was removed so SvelteKit gets the `cookie` 2.x it declares; the documented Node floor is now 22.17 (SvelteKit 3 requires it). Checks ran locally on Windows 11 with Node 26.9.0, npm 11.19.1 and Playwright 1.64.0.

| Check                 | Result                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------ |
| npm run check         | Passed; svelte-check 0 errors / 0 warnings, printer-service and service-worker `tsc` clean |
| npm run lint          | Passed                                                                                     |
| npm test              | Passed; 187 tests across 19 files                                                          |
| npm run build         | Passed                                                                                     |
| npm run build:printer | Passed                                                                                     |
| npm run test:e2e      | Passed; 120 Chromium runs                                                                  |

Manual check against `vite preview` in Chromium: the worker registered and took control, its cache held 31 root-absolute entries (18 immutable assets, 11 static files, `/` and `/queue/`), and with the server stopped `/queue/` still loaded from the cache while `/api/features` failed on the network instead of being served from it. The immutable list gains SvelteKit 3’s new `payload` entry. No print job was sent, and no hardware result is claimed.

## Current branch check — 2026-10-12

Documentation pass on `design/order-builder` at `1eda67b`. This branch adds the phase 1–3 work since the entries below: schema 2 structured tickets and the one-time v1 browser reset, the redesigned prep ticket, the responsive order builder, the persistent build queue with SSE, the `ORDER_PAD_TRACKING_ENABLED` flag, automatic service-worker updates, and the Rainbow and Chocolate Sprinkles toppings. All checks were run locally on Windows 11 with Node 26.9.0, npm 11.19.1 and Playwright 1.64.0.

| Check                 | Result                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------- |
| npm run check         | Passed; svelte-check 0 errors / 0 warnings, printer-service `tsc` clean                   |
| npm run lint          | Passed                                                                                    |
| npm test              | Passed; 187 tests across 19 files                                                         |
| npm run build         | Passed                                                                                    |
| npm run build:printer | Passed                                                                                    |
| npm run test:e2e      | Passed; 120 Chromium runs (builder spec at 390×844, 820×1180, 1280×800, plus queue specs) |

No print job was sent, and no hardware result is newly claimed. Physical acceptance of the redesigned prep ticket, REPRINT and recovery flows remains open; follow the checklist in [linux-printing.md](linux-printing.md).

## Mixed flavors and scoop counts — 2026-10-11

Each serving now has a list of flavors with positive integer scoop counts, capped at **5 scoops total per cup or cone**. Touch-sized +/− controls start at zero, show each flavor’s count and the shared total, disable additions at five, and remove a flavor when its count reaches zero. Container and toppings apply to the whole serving. Printing still includes the complete current serving or edit automatically.

New tickets keep one item per serving (`quantity: 1`), with a heading such as **Ice cream (3 scoops)** and separate modifier lines for **2 scoops Chocolate Chip**, **1 scoop Strawberry**, the container, and toppings. The existing ticket API and receipt renderers need no schema change. Saved single-flavor drafts convert to one-scoop portions during recovery; submitted tickets remain unchanged for deliberate reprinting. No IndexedDB version bump or data clearing is needed.

> Superseded: the later phase 1 domain upgrade replaced this `items`/`quantity` shape with schema 2 `servings` and reset v1 browser data once (IndexedDB version 2). See README.

| Check                 | Result                                                            |
| --------------------- | ----------------------------------------------------------------- |
| npm run check         | Passed; zero Svelte errors/warnings and service TypeScript errors |
| npm run lint          | Passed                                                            |
| npm test              | Passed; 73 tests across 8 files                                   |
| npm run build         | Passed                                                            |
| npm run build:printer | Passed                                                            |
| npm run test:e2e      | Passed; 22 Chromium tests                                         |
| git diff --check      | Passed                                                            |

Coverage includes every flavor/container with 1 and 5 scoops, combinations across all four flavors, mixed totals, duplicate/invalid/decimal/zero counts, aggregate limits, add/edit without duplication, frozen canonical drafts, legacy draft conversion, durable print/reset, reload recovery, and preserving scoop distributions during reprints. Browser tests explicitly exercise 2 Chocolate Chip + 1 Strawberry in one serving, reaching the shared cap, removing to free capacity, deleting the last scoop, editing/reloading mixed flavors, and old-draft recovery.

Responsive checks at 360×780, 390×844, 768×1024, and 1024×768 report no horizontal overflow and a visible Print action. Phone and desktop mixed-flavor screenshots were visually inspected. Automated checks use mocked transport responses; no physical ticket was printed. Close all cached Order Pad tabs and reopen the station to activate the new client before recovering/editing drafts. Follow the updated [physical acceptance checklist](linux-printing.md) to inspect per-flavor counts, serving grouping, legibility, and cut on the printer.

## USB-only ordering UX — 2026-10-11

Implemented Order and Printer settings tabs, automatic use of the server’s local USB queue, live startup/readiness checks, and read-only queue details. Printer selection, simulation controls, recurring setup acknowledgment, and PassPRNT launching are removed from the ordering interface. Historical adapters remain available. The later phase 1 domain upgrade resets v1 browser records once, as documented in README.

Print includes a complete pending serving or edit; incomplete selections block submission without dropping them. An accepted result and the next empty draft save in one IndexedDB transaction. Older accepted locked drafts advance safely on reload. Failed/unknown outcomes remain locked for deliberate recovery. Reprinting the previous ticket preserves another active draft. Flavor and container remain unselected by default.

| Check                 | Result                                                            |
| --------------------- | ----------------------------------------------------------------- |
| npm run check         | Passed; zero Svelte errors/warnings and service TypeScript errors |
| npm run lint          | Passed                                                            |
| npm test              | Passed; 71 tests across 8 files                                   |
| npm run build         | Passed; static app and service worker                             |
| npm run build:printer | Passed; Linux printing service                                    |
| npm run test:e2e      | Passed; 17 Chromium tests                                         |

Unit coverage includes pure addition/edit preparation, incomplete/empty orders, 30-serving boundaries, durable intent before send, repeated submission protection, atomic result/next-draft persistence and rollback, storage failure, accepted legacy-draft advancement, and reprinting during another draft.

Browser coverage uses mocked USB status/print responses and checks automatic readiness, settings/draft preservation and keyboard tab navigation, printing without Add, editing without duplication, explicit serving actions, next-order reset, blank-name stability, reprints, unavailable service, failed submissions, lost responses, pending request locks, interruption/reload recovery, older accepted drafts, offline recovered drafts with printing blocked, and IndexedDB failure.

Screenshots at 390×844, 768×1024, and 1024×768 show no horizontal overflow and a visible print action. Phone order/settings and desktop order screenshots were visually inspected. The first browser run passed 16 tests; one test used a partial heading match that selected both Submitted order and Last submitted order. An exact selector fixed the harness; all 17 final tests passed. Local HTTP/browser checks required loopback access outside the sandbox. No physical print jobs were submitted by automated checks.

Both production outputs have been rebuilt. The existing station service was restarted with its unchanged launcher/configuration after confirming no pending CUPS jobs and no unfinished journal intents. Live Tailscale HTTPS verification returned `ready: true`, `queue: Star_TSP143`, and the new Order/Printer settings tabs with no printer selector. No print job was sent. Cached browser tabs must close/reopen to activate the updated app shell. Follow the updated [physical acceptance checklist](linux-printing.md) on the printer; this UX update’s receipt/cut and recovery behavior have not yet been physically verified. Before committing, `git diff --check` passed using a temporary extracted Ubuntu Git package; Git is not installed system-wide.

## Order builder — 2026-10-11

Implemented explicit flavor/container selection, any combination of eight toppings, separately configured servings with add/edit/remove, optional names and stable two-word fallback labels. New orders and their first intents commit atomically; serialized draft writes restore unfinished editor selections independently from the latest submitted receipt. Reprints preserve the original ticket while a new draft is being built. Existing IndexedDB version/records and both real printer routes are retained.

| Check                 | Result                                                            |
| --------------------- | ----------------------------------------------------------------- |
| npm run check         | Passed; zero Svelte errors/warnings and service TypeScript checks |
| npm run lint          | Passed                                                            |
| npm test              | Passed; 64 tests across 8 files                                   |
| npm run build         | Passed; static app and service worker                             |
| npm run build:printer | Passed; Linux printing service                                    |
| npm run test:e2e      | Passed; 14 Chromium tests                                         |

Checks ran on Linux with Node 24.21.0, locked project dependencies and Playwright Chromium 156. Browser binaries were downloaded into `/tmp/order-pad-browsers` for verification. Local HTTP/browser tests required loopback access outside the sandbox; no production printer commands were issued by these tests. Git CLI was unavailable, so `git diff --check` could not run.

New unit coverage includes every menu choice, all/no toppings, multiple and identical servings, 30-serving boundaries, name limits/control characters/whitespace, stable labels, HTML escaping and PDF layout, serialized drafts, atomic first intent and duplicate-ID rollback, storage failure before send, successive ticket identities, preserving a draft during reprint, unknown-outcome acknowledgment and legacy-ticket recovery.

Browser coverage adds named multi-serving construction, edits/removal, incomplete editor and name recovery, blank-name fallback stability, new-order reset, reprinting a previous receipt while building the next order, and unknown-outcome gating. Existing Linux HTTP intent ordering, no automatic retry, PassPRNT callbacks and offline reopening checks pass. Phone/tablet checks at 390×844, 768×1024 and 1024×768 report no horizontal overflow. Phone form and embedded PassPRNT HTML screenshots were visually inspected; screenshots remain in ignored `test-results/`.

The order-builder receipts have not yet been physically accepted on the owner's printer. Follow the named-order, unnamed-order and REPRINT checklist in [Linux printing](linux-printing.md). The earlier phone-to-USB sample success below remains valid evidence for the transport, not acceptance of the new builder. Rebuild/restart the service and reopen cached browser tabs together so client and service both accept the longer name limit.

## Printing transport foundation — 2026-10-09 to 2026-10-11

Updated **2026-10-11** for **TSP143IIIU / Galaxy S10e / Android 12**, adding the owner-selected **Mint 22.3 Cinnamon 64-bit** USB host. Local implementation checks run on Windows, Node 26.9.0, npm 11.19.1, Playwright 1.64.0 / Chromium 156.0.8078.4. The implementation agent has no physical printer access.

| Check                 | Result                                                |
| --------------------- | ----------------------------------------------------- |
| npm run check         | Passed; Svelte 0 errors/warnings and service tsc      |
| npm run lint          | Passed                                                |
| npm test              | Passed; 52 tests across 6 files                       |
| npm run build         | Passed; static app, manifest/icons and service worker |
| npm run build:printer | Passed; bundled Linux service                         |
| npm run test:e2e      | Passed; 11 Chromium tests                             |
| npm audit             | 0 vulnerabilities                                     |
| git diff --check      | Passed                                                |

Unit checks cover immutable structured servings, menu validation, canonical ordering, sanitized names, numeric references, printable-length limits, the v1 browser-data reset, URI/HTML escaping, USB parameters, partial cut, disabled retry pop-up, unsupported runtimes, structured callback outcomes, intent before handoff, overlap prevention, callback correlation, immutable final outcomes, storage failures and unknown recovery without resend. The old IV adapter and SDK tests were replaced by IIIU PassPRNT coverage; the attempt model retains IV identifiers, while the phase 1 upgrade resets v1 browser history once.

Browser checks cover simulation, reload/reprint, offline shell reopening, duplicate acknowledgment, unsupported real mode, missing IndexedDB, interrupted sends, and no horizontal overflow at 1024×768, 768×1024 and 390×844. New checks cover a pending PassPRNT link after saved intent, matching callback completion through an offline cached shell, repeated callback protection and missing-return recovery. The HTTPS test uses Android user-agent metadata and maps static assets to local production output; it does not open PassPRNT or send USB data.

Screenshots of the 390-pixel phone handoff flow and the actual embedded receipt HTML were visually inspected. Browser rendering checks confirm the sample fits the 576-pixel width and is below the HTML length limit. These do not prove Android density, fonts, StarGraphic raster output or physical cutting. Screenshots remain in ignored test-results/.

The first HTTPS callback test failed because its page-only routing omitted service-worker requests. Context-level routing corrected the harness; all nine final tests passed. No application workaround was needed. Earlier foundation checks on 2026-10-09 passed against the assumed IV model; that integration has been superseded.

Physical acceptance is **PARTIAL, OWNER-REPORTED**: the owner reports working PassPRNT printing (with app switching), a successful CUPS test receipt, and a successful Order Pad receipt from the Galaxy S10e over Mint Tailscale HTTPS on 2026-10-11. The first Linux browser test's readability, end marker and partial cut were owner-confirmed. CUPS independently reported job `Star_TSP143-2` completed with one sheet and no pending jobs afterward. The installed driver is Star TSP100 Cutter with PPD FileVersion 2.1; its package and printer firmware versions remain unrecorded. Reprint, hardware errors, interruptions, offline and PWA routing are still unverified. Use [hardware-test.md](hardware-test.md) and [Linux acceptance](linux-printing.md).

Linux unit coverage verifies input validation, installed media/Star option checks, rejection of network/disabled/pending queues, flushed intent before lp, one-copy stdin submission, documented partial-cut options, duplicate ID/content rejection, concurrency locks, persisted unknown recovery without replay, renderer failure before send, and one-page PDF. HTTP checks exercise live noncached status, correlated same-origin submissions, foreign Host/Origin rejection, JSON and size limits and file traversal protection. Commands are stubbed; they do not prove Linux lp/driver operation.

New browser checks confirm Linux selection/readiness, IndexedDB intent before HTTP, staying in the app, recovery, explicit REPRINT with original ID, unavailable service blocking and lost-response ambiguity without automatic retry. The first new test looked up the wrong database name; changing the harness to the actual order-pad-v1 database fixed it. The production preview for tests uses 4175 so it does not interrupt the running Tailscale preview on 4173.

Temporary sample/reprint PDFs from the actual renderer were checked with Poppler and pypdf: one page, embedded font, complete content, clear reference/REPRINT, no clipping or overlap. The Windows visual check used Cascadia Mono; the Mint runtime embeds DejaVu Sans Mono. Target glyph coverage, CUPS rasterization, variable-length trimming and physical cut still need testing. Temporary PDFs/screenshots are ignored in test-results/.

The Linux service is now running on the owner's Mint machine with Node 24.21.0 and the verified `Star_TSP143` USB queue. The installed PPD exposes `0Variable`, `0NoCutPage`, `1PartialCutDoc`; selecting these advertised values fixed the initial driver mismatch. Prepared jobs carry their selected options independently of concurrent readiness checks. Type checks, 53 unit/HTTP tests, formatting and both production builds passed on Mint. Live Tailscale HTTPS app loading and printer readiness passed, CUPS `abort-job` policy was confirmed, and the first phone-to-printer smoke test succeeded as described above. See [verified Mint setup](linux-printing.md) for the origin, driver, journal IDs and foreground launcher. Boot startup has not been configured. At that point the full order-building workflow was deferred; the order builder entry above implements it. GitHub Actions status is separate from these local checks.
