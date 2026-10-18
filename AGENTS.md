# AGENTS.md

This guide is for AI coding agents and human contributors. [README.md](README.md) explains what the product does and how to operate it. This file explains how to change the code without breaking anything that matters.

## The project in brief

Fiona's Order Pad is an ice cream order builder that prints preparation tickets on a Star TSP143IIIU receipt printer. It has two parts:

- **Browser app** (`src/`): a SvelteKit 3 / Svelte 5 static PWA with two screens, the order builder at `/` and **Now Scooping** (the build queue) at `/queue/`. It keeps only transient view state and reads/writes its authenticated browser workspace through same-origin APIs.
- **Linux service** (`printer-service/`): a Node HTTP server with Prisma/Postgres order persistence. It serves `build/`, renders tickets to PDF with PDFKit, submits them to CUPS with `lp`, keeps drafts, counters, immutable tickets, attempts, dispatch claims and append-only events in required local PostgreSQL 18, and streams queue snapshots over SSE.

The service imports domain code from `src/lib/` directly, so the browser and the server share one ticket model and one validator. There are no prices or payments. There are no personal accounts: staff sign in with a shared 8-hour access code that only the station terminal or the optional tailnet admin page can mint. The service and PostgreSQL must run on the same machine; database unavailability blocks startup and all order work.

### Life of an order

README has the architecture diagram, a sequence diagram of the first print and a glossary (workspace, attempt, dispatch, order event, tracking, capture cutoff). In short:

1. `GET /api/station` checks the access-code session and resolves the opaque `__Host-order-pad-browser` cookie to an internal workspace and returns the workspace snapshot `{ revision, draft, saved? }`. Editing the draft is `saveDraft`, each carrying the expected `revision`.
2. **Print order** sends `startOrder` with a new pending attempt. One Postgres transaction allocates the next global number, creates the immutable ticket and locked draft, stores the attempt and appends the `submitted` order event. Only then does the browser call `POST /api/print`.
3. `Printing.print` commits an exclusive dispatch claim, waits for an idle CUPS queue, renders the PDF and runs `lp`. The result is stored on the dispatch.
4. The browser reports the outcome with `finishAttempt`; an accepted attempt also advances the draft to a new empty order. A reprint is `startAttempt` with `reprint: true` followed by the same print call.
5. The queue reads `order_events` (latest event per ticket ID) and receives SSE snapshots; Done and Undo append `completed` and `reopened` events.

Two server routes have no caller in the app: `POST /api/orders` and `GET /api/orders` (and `fetchOrders` and `parseRegistration` on the browser side). They exist for authorized same-origin clients and tests; keep them working, but do not assume the app exercises them.

## Setup and verification

Node 22.17 or later (CI uses Node 24) and npm. CUPS output requires Linux. PDF development output (`ORDER_PAD_PRINT_MODE=pdf`) and all other work run on Windows, macOS and Linux; PDF mode still requires local PostgreSQL 18 and an explicit readable TTF font.

```sh
npm ci
npm run db:generate               # Prisma client; `npm run check` and `build:printer` also run it
npx playwright install chromium   # once
```

`npm ci` does not generate the Prisma client. Until `npm run db:generate` has run, anything that imports `printer-service/station-database.ts` or `order-database.ts` fails to load, including `npm test`. The client is written to `printer-service/generated/` and is Git-ignored.

**Definition of done.** Run all of these and make sure they pass. Order matters: `test:e2e` serves `build/`, so `build` has to run first.

```sh
npm run test:postgres  # needs TEST_DATABASE_URL: a separate disposable *_test database on PostgreSQL 18; applies migrations
npm run test:postgres:volume # needs Docker: disposable PostgreSQL 18 volume recreation test
npm run check          # svelte-check (0 errors, 0 warnings) + tsc for printer-service and the service worker
npm run lint           # Prettier, including Markdown; fix with `npm run format`
npm test               # Vitest: src/**/*.test.ts and printer-service/**/*.test.ts, excluding *.postgres.test.ts
npm run build          # build/
npm run build:printer  # build-printer/server.mjs
npm run test:e2e       # Playwright, Chromium, vite preview on :4175
```

CI ([.github/workflows/checks.yml](.github/workflows/checks.yml)) provisions PostgreSQL 18 and runs this same sequence, in this order, on Node 24 for every pull request and every push to `main`. Branch pushes are deliberately not triggers, because the pull request run already covers them; use `workflow_dispatch` to check a branch with no PR. Unit/HTTP and browser suites use injected order repositories; Postgres integration tests separately cover real durability and concurrency.

Faster loops:

```sh
npx vitest run src/lib/tickets                 # one area
npx playwright test tests/queue.spec.ts        # one spec
npx playwright test --project=builder-390x844  # app.spec.ts at phone size only
```

`tests/app.spec.ts` runs three times, once per viewport project: `builder-390x844`, `builder-820x1180` and `builder-1280x800`. The other specs run in the `chromium` project.

`npm run dev` and `npm run preview` have no `/api` routes, so the sign-in gate/connection error and disabled order editing/printing are expected there. That is not a bug. There is no in-app simulator. Use the tests to exercise print and queue flows.

The `db:*` scripts, `test:postgres` and `start:printer` read `.env` (copy [.env.example](.env.example)); variables already exported in the shell win. `npm test`, `check` and `test:e2e` need no database or `.env`.

## Code map

| Path                                                                             | Responsibility                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/tickets/ticket.ts`                                                      | The menu (`FLAVORS`, `CONTAINERS`, `TOPPINGS`), limits, `OrderTicket`/`Serving` types, `parseTicket`, `parseServing`, `blankNameLabel`, `sampleTicket`.                                                                                                                                                                                                           |
| `src/lib/tickets/order.ts`                                                       | `OrderDraft` and pure editing operations: `commitServing`, `editServing`, `removeServing`, `cancelServing`, `prepareDraftForPrint`, `draftTicket`, `newDraft`.                                                                                                                                                                                                    |
| `src/lib/tickets/format.ts`                                                      | Receipt layout. `formatTicket` gives text lines (preview and the 240-line limit); `prepTicketLayout` gives absolute geometry for PDF and HTML (576 px at 8 px/mm, 2000 mm cap); `assertPrintable` runs both.                                                                                                                                                      |
| `src/lib/printing/port.ts`                                                       | `TicketPrinter`, `PrintAttempt` and `PrintAttemptResult` (`accepted` / `failed` / `outcome-unknown`), plus `PrintHandoff` for PassPRNT.                                                                                                                                                                                                                           |
| `src/lib/printing/session.ts`                                                    | `PrintSession`: the transient browser state machine (`loading → ready → saving → printing → ready`, or `blocked`). It saves intent before every send, serializes draft writes and recovers pending attempts as unknown.                                                                                                                                           |
| `src/lib/printing/adapters/linux-cups.ts`                                        | `LinuxCupsPrinter` (`POST /api/print`) and `linuxPrinterStatus` (`GET /api/printer`). This is the **only** adapter the UI uses.                                                                                                                                                                                                                                   |
| `src/lib/printing/adapters/{simulated,passprnt}.ts`                              | Kept for unit tests and history. They cannot be selected in the UI.                                                                                                                                                                                                                                                                                               |
| `src/lib/storage/ticket-store.ts`                                                | `DatabaseTicketStore`, station snapshot/command validators and revision-aware API client. No browser persistence or outbox.                                                                                                                                                                                                                                       |
| `src/lib/orders/order.ts`                                                        | `QueueOrder`, `parseOrder`, `sortOrders`, and wait-time helpers (`waitMinutes`, `waitTone`).                                                                                                                                                                                                                                                                      |
| `src/lib/orders/{live,client,stream,features,registration}.ts`                   | `live`: snapshot and version parsing. `client`: REST client; only Done/Undo (`changeOrderStatus`) have an app caller. `stream`: `QueueFeed` (EventSource with a 45 s watchdog). `features`: the tracking flag. `registration`: `parseRegistration` for `POST /api/orders` replies, used by no app code today.                                                     |
| `src/lib/orders/pack.ts`                                                         | `columnCount` and `packColumns`: shortest-column card packing for the queue.                                                                                                                                                                                                                                                                                      |
| `src/lib/app-update.ts`, `src/service-worker/index.ts`                           | Static asset caching only (no HTML/API cache) and update reloads that wait until `holdUpdates()` is released.                                                                                                                                                                                                                                                     |
| `src/routes/+page.svelte`                                                        | Order builder UI. It wires `PrintSession`, `LinuxCupsPrinter`, database health checks, the toast, recovery and Order tools together.                                                                                                                                                                                                                              |
| `src/routes/queue/+page.svelte`                                                  | Now Scooping UI: measured column packing, chips, Done and Undo, and handling of the tracking-disabled state.                                                                                                                                                                                                                                                      |
| `src/routes/+layout.svelte`, `+layout.ts`                                        | Injects `design/tokens/tokens.css` (with `@font-face` stripped), loads `src/lib/builder.css`, starts update checks, and sets `prerender = true`.                                                                                                                                                                                                                  |
| `printer-service/server.ts`                                                      | Entry point. Reads and validates the `ORDER_PAD_*` environment variables, resolves `./build` **from the current working directory**, checks the migrated local database before listening, and listens on `127.0.0.1`. Selects CUPS (Linux/HTTPS) or PDF development output (cross-platform; loopback HTTP permitted).                                             |
| `printer-service/http.ts`                                                        | `createApp()`: routing, Host/Origin/Content-Type guards, the 128 KiB body limit, static file serving and the tracking gate.                                                                                                                                                                                                                                       |
| `printer-service/printing.ts`                                                    | `Printing`: Postgres dispatch journal, busy lock, exclusive intent committed before `lp`, and unknown recovery without replay.                                                                                                                                                                                                                                    |
| `printer-service/output.ts`                                                      | `PrintOutput` interface and `PdfOutput`: validated attempt filenames, atomic PDF saving, readiness and existing-file reads. No CUPS commands.                                                                                                                                                                                                                     |
| `printer-service/cups.ts`                                                        | `Cups`: `lpstat` and `lpoptions` readiness checks, Star option detection, media selection and `lp` submission. External commands are injected through `Command`.                                                                                                                                                                                                  |
| `printer-service/admin-http.ts`                                                  | `createAdminApp`: the optional tailnet-only access-code page and `/api/admin/access` (status, mint, revoke) with Host/capability/Origin guards, single-flight changes and once-only request IDs; `listenAdmin` binds its private Unix socket.                                                                                                                     |
| `printer-service/receipt.ts`                                                     | PDF rendering from `prepTicketLayout`, plus the access-code slip, using the configured TTF font.                                                                                                                                                                                                                                                                  |
| `printer-service/orders.ts`, `order-database.ts`, `order-stream.ts`, `config.ts` | `Orders`: serialized event repository with instance ID, revision and the capture cutoff; `order-database.ts`: Prisma client factory with the database time limits, transactions and latest-event projection. `OrderStream`: one SSE client with backpressure and heartbeat. `config.ts`: strict parsing of tracking, `DATABASE_URL` and `ORDER_PAD_CAPTURE_FROM`. |
| `printer-service/station-database.ts`                                            | `PostgresStationRepository`: transactional browser workspaces, per-workspace revisions, global numbering, immutable tickets, attempts and exclusive dispatch records. It is also the `PrintJournal` that `Printing` uses.                                                                                                                                         |
| `prisma/`, `prisma.config.ts`, `compose.yaml`                                    | Schema, the committed migrations (`order_events`, `station_persistence`, `browser_workspaces`, `authentication`, `access_codes`), Prisma CLI config that loads `.env`, and the loopback-only PostgreSQL 18 container.                                                                                                                                             |
| `scripts/test-postgres.mjs`, `test-postgres-volume.mjs`                          | Runners behind `npm run test:postgres` (generate, migrate, run `*.postgres.test.ts` against `TEST_DATABASE_URL`) and `npm run test:postgres:volume` (disposable Docker volume).                                                                                                                                                                                   |
| `tests/app.spec.ts`                                                              | Builder end-to-end tests. `/api/*` is mocked with `page.route` (see `mockUsb`).                                                                                                                                                                                                                                                                                   |
| `tests/queue.spec.ts`                                                            | Queue UI tests. `EventSource` is replaced through `addInitScript`, and REST calls are mocked with `context.route`.                                                                                                                                                                                                                                                |
| `tests/queue-live.spec.ts`                                                       | Runs the real `createApp` with a persistent injected in-memory order repository and stubbed CUPS and printing on a random loopback port, serving `build/`.                                                                                                                                                                                                        |
| `tests/stations-live.spec.ts`                                                    | Real `createApp` with in-memory station and order repositories and stubbed CUPS: two explicitly authenticated browser contexts edit independently, print through the FIFO and recover their own tickets.                                                                                                                                                          |
| `tests/admin.spec.ts`                                                            | Tailnet admin page on loopback TCP with stubbed access operations and Serve’s identity header: confirmation, single request, slip failure, browser resend and lost replies.                                                                                                                                                                                       |
| `tests/helpers/`                                                                 | Playwright and service test doubles: `MemoryStationRepository`/`MemoryPrintJournal` (`station.ts`), `MemoryOrderRepository`, `MemoryTicketStore`, and `mockStationApi` (`station-api.ts`). Fixtures only; durability is tested against Postgres.                                                                                                                  |

## Invariants: do not break these

Each rule exists to prevent a duplicate or lost ticket during service. Tests enforce most of them, so if a change makes one of those tests fail, fix the change, not the test.

1. **Intent before send.** A ticket and its pending attempt must be committed to Postgres with its locked draft and submission event before any adapter call (`PrintSession.send`, `PostgresStationRepository.mutate`). The service must commit an exclusive dispatch claim in Postgres before `lp` (`Printing.print`). If the save fails, send nothing.
2. **Never resend a print automatically.** Never add retries around `/api/print` or `printer.print`. A pending attempt without a durable service outcome found after a reload or restart becomes `outcome-unknown` and stays that way. Recorded service outcomes win over lost browser replies. There is no browser outbox or automatic mutation retry.
3. **Three outcomes, final once written.** `failed` means nothing was submitted. Anything ambiguous (timeouts, lost or malformed responses, a result that could not be saved) is `outcome-unknown`. A completed attempt is never overwritten (`finishAttempt` aborts if `before.result` exists).
4. **Unknown outcomes need acknowledgment.** After `outcome-unknown`, reprinting and **New order** stay disabled until the operator confirms they checked the output (`requiresConfirmation`, `outputConfirmed`).
5. **Tickets are immutable, and reprints reuse them.** A reprint is a new attempt with `reprint: true` for the same ticket ID, number, name and `createdAt`. `saveTicket` aborts if stored content differs. Reprints never create, duplicate or reopen a queue order.
6. **One validator.** All ticket input passes through `parseTicket`: HTTP bodies, Postgres station/ticket/dispatch/event reads and browser API responses. It returns deeply frozen objects in canonical menu order, rejects anything except `schema: 2` (including v1 `items`), and calls `assertPrintable`, so every accepted ticket can also be printed as a REPRINT. Apply the same pattern to new data: write `parseX(unknown)` that either throws a user-facing `Error` or returns a frozen value.
7. **Queue identity is the ticket ID.** `Orders.upsert` is idempotent and never changes an existing record. Only `POST /api/orders/:id/reopen` reopens. `submittedAt` is the ticket's `createdAt`. All events remain in Postgres; only the latest event projects current state.
8. **Queue visibility is optional; the database is mandatory.** Tracking only gates queue visibility. The first order event commits atomically with station print intent regardless of tracking. Database failure blocks startup and every API operation, including printing. The browser blocks editing on failed writes or health checks, and recovers only by reloading state from Postgres (`PrintSession.recover`, never while a send is in flight) once the database answers again. Service and Postgres must share a machine; reject remote DATABASE_URL hosts/host overrides.
9. **No caching of `/api`, and no reload mid-send.** The service worker ignores `/api/*`. `+page.svelte` holds updates while working, awaiting acknowledgment, loading or blocked. Any new long-running UI operation must take a `holdUpdates()` hold too.
10. **Same-origin only.** The service accepts only its configured Host values. POSTs to `/api/station`, `/api/print` and `/api/orders*` require `Origin === ORDER_PAD_ORIGIN` and JSON. Do not add CORS. **A new POST route must be added to the guard in `http.ts` explicitly**, because the guard matches paths and new routes are not covered automatically.
11. **Shared modules stay portable.** `src/lib/tickets/*`, `src/lib/orders/{order,live,features}.ts` and `src/lib/printing/port.ts` are bundled into the Node service. Use relative imports there, not the app's `#lib` import alias (the shared code must not depend on app-level aliases), and do not touch the DOM, `window` or SvelteKit modules at import time. `src/lib/tickets/` stays pure: no I/O, transport or prices.
12. **Postgres is station data.** Never introduce browser order persistence. Legacy `order-pad-v1` and `.print-data/` remain untouched archives; do not automatically import, reset or delete them. New durable shapes require committed SQL migrations and a README upgrade note. Workspace draft mutations require expected revisions; reject stale same-workspace tabs instead of overwriting data. An opaque persistent browser cookie identifies the workspace (behind a valid session), and it survives access-code rotation; no order data is stored in the browser. Numbers are allocated only by the service, atomically with first-order intent.
13. **Accessibility and touch.** Use real `<button>` toggles with `aria-pressed`, keep the `aria-live` scoop total, keep touch targets of at least 44 px, keep DOM order equal to reading order (layout uses `grid-template-areas`, not CSS `order`), and keep `aria-posinset`/`aria-setsize` on queue cards. The Playwright tests find elements by role and accessible name, so renaming a label means updating the tests.

14. **Authenticate before operational work.** `createApp` requires an injected Authentication implementation; production always constructs PostgresAuth. There is no environment bypass. Public routes are the login page, required static assets and the explicit authentication endpoints. New operational routes must stay behind the session gate. A session never outlives or survives its access code. Session loss must wait for `holdActivity()` work before navigation; never replay a mutation or print. Minting, inspecting and revoking access codes belong only to the bundled local CLI and the optional tailnet admin listener (`createAdminApp`). That listener uses a private Unix socket behind Tailscale Serve, requires the admin host (Serve sends `Host: localhost` to socket backends, so it checks the `X-Forwarded-Host` that Serve overwrites), the configured Tailscale app capability (granted to tagged devices by the tailnet policy and forwarded by Serve’s `--accept-app-caps`), and the admin `Origin` plus JSON on POSTs, and handles each confirmation `requestId` at most once. Never add access administration to `createApp`, the public origin or any TCP listener, and never retry a mint.

## Authentication code

`printer-service/auth.ts` owns PostgreSQL-backed access-code sign-in, sessions, rate limits and Turnstile. `access-admin.ts` owns the `mint`/`status`/`revoke` operations and the access-code slip. `access-cli.ts` is bundled alongside `server.mjs`; run `npm run access -- <mint|status|revoke>`. `admin-http.ts` exposes the same operations to devices granted the configured Tailscale app capability when `ORDER_PAD_ADMIN_*` is configured (see invariant 14). The slip is printed with `Cups`/`PdfOutput` directly and never enters `Printing` or the dispatch journal. `src/lib/auth/` contains `parseAccessCode`, validated clients, activity holds, the login form and `AccessMenu`. Browser fixtures explicitly mock sessions; real-service tests inject `tests/helpers/auth.ts`. Rotation, expiry and concurrency tests use the disposable PostgreSQL suite. Live Cloudflare and physical-device checks remain owner-run.

## Data shapes

```ts
// src/lib/tickets/ticket.ts
interface OrderTicket {
  schema: 2;
  id: string; // 1–100 printable chars; new tickets get 32 hex chars from crypto.getRandomValues
  createdAt: string; // ISO UTC with milliseconds, e.g. 2026-10-11T19:42:00.000Z
  reference: string; // zero-padded order number, e.g. "0043"
  customerName?: string; // ≤ 80 printable chars
  displayName: string; // customerName or blankNameLabel(reference)
  servings: Serving[]; // 1–30
}
interface Serving {
  flavors: { flavor: Flavor; count: number }[]; // menu order, unique, total 1–5
  container: Container;
  toppings: Topping[]; // menu order, unique, may be empty
}

// src/lib/orders/order.ts
interface QueueOrder {
  ticket: OrderTicket;
  submittedAt: string;
  status: 'open' | 'done';
  doneAt?: string;
}

// src/lib/printing/port.ts
type PrintAttemptResult =
  | { status: 'accepted'; simulated: boolean; message: string }
  | {
      status: 'failed' | 'outcome-unknown';
      code: PrintErrorCode;
      simulated: boolean;
      message: string;
    };
```

All of these are `readonly` in the source. Result `message` strings are shown to staff word for word, so keep them short and actionable, and say whether anything was sent.

## Recipes for common changes

### Add a flavor, container or topping

1. Append the value to the relevant array in `src/lib/tickets/ticket.ts`. Array order is the UI order and the print order.
2. **Adding is safe. Renaming or removing is not.** Stored tickets, drafts, dispatches and Postgres events are re-validated, so an unknown value blocks the database-backed station and makes reads return 503. Plan a migration or a deliberate reset first.
3. Longer names lengthen receipts. Run the 30-serving and overlength tests in `src/lib/tickets/ticket.test.ts` and `tests/app.spec.ts`.
4. Update the tests that list the menu (`ticket.test.ts`, `app.spec.ts`), plus README "Menu and rules", `design/IMPLEMENTATION.md` "Ordering rules", and the acceptance steps in `docs/linux-printing.md` if they count toppings.

### Change the printed ticket

Edit `prepTicketLayout` (geometry in 8 px/mm units on a 576 px width) and/or `formatTicket` in `src/lib/tickets/format.ts`. The PDF (`printer-service/receipt.ts`) and the PassPRNT HTML (`adapters/passprnt.ts`) both render from `prepTicketLayout`. Keep `assertPrintable` reserving REPRINT space. Physical output can only be confirmed on the printer, so add an item to the acceptance checklist in `docs/linux-printing.md` and do not claim the layout was verified.

### Add or change an HTTP endpoint

1. Route it in `printer-service/http.ts`. Put it before the static-file fallback and decide whether the tracking gate applies.
2. If it is a POST, add the path to the Origin/Content-Type guard (invariant 10). Read bodies with `readJson` to get the size limit.
3. Validate input with a `parseX` function. Return `json(status, body)`, which sets `no-store`.
4. Cover it in `printer-service/http.test.ts`: real loopback server, stubbed `cups`/`printing`/`orders`.
5. Add a browser client in `src/lib/` with `cache: 'no-store'` and an `AbortSignal.timeout`, and document it in README's HTTP API table.

### Add a service setting

Read it in `printer-service/server.ts`, and validate strictly so that typos stop startup (see `parseTrackingEnabled` in `config.ts`). Document it in README "Configuration" and in `docs/linux-printing.md`. If the browser needs to know the value, expose it through `/api/features`, as `trackingEnabled` is.

### Change the queue screen

Use `src/routes/queue/+page.svelte`. Packing logic lives in `src/lib/orders/pack.ts` and has unit tests. The page measures card heights in a hidden row and re-packs only when the set of open IDs or the column count changes. Keep that behavior so cards never move on the 30-second age refresh. Live data flows through `QueueFeed`; apply action responses with `feed.applyChange` so version checks still apply.

### Change station persistence

Follow invariant 12. Update `station-database.ts` and committed SQL migrations. First-order and outcome/draft writes must remain atomic. Test real rollback, revision conflicts, exclusive dispatch claims and reload recovery in `station-database.postgres.test.ts`. Test transient session logic with injected repositories; never add browser storage.

## Postgres event storage

- Target PostgreSQL 18. `prisma/schema.prisma` defines the global counter, workspace, ticket, attempt and dispatch tables plus append-only `order_events`; committed SQL migrations add event-type/identity checks and a partial unique submission index. There is no completion boolean: latest `event_type` supplies state.
- Keep full immutable tickets on every event. Latest-event selection precedes status filtering, or historical rows can resurrect completed/open orders. Per-order advisory transaction locks make concurrent submissions and transitions safe. No-op writes append nothing.
- Generate the client with `npm run db:generate` (also before check and printer build). `printer-service/tsconfig.json` gives the generator a Node config instead of the browser’s `$app/tsconfig`. Generated files are ignored. Run `npm run db:deploy` explicitly; startup must not migrate.
- Require validated `DATABASE_URL` and fixed `ORDER_PAD_CAPTURE_FROM`. Explicit order registrations before the cutoff return `{ excluded: true, ticketId }`; new station intents before the cutoff are rejected. Never backfill archived files or acknowledged history. Keep cutoff stable across restarts. Tickets take the service's own clock, so a cutoff in the future (or a host clock set before it) makes `startOrder` fail until that time.
- Capture first submissions regardless of `ORDER_PAD_TRACKING_ENABLED`; the flag gates UI and queue GET/SSE only. Done/Undo POSTs remain guarded and available. Station capture never depends on feature discovery and never retries prints. Legacy IndexedDB remains untouched.
- Bounded database waits must prevent print submission when intent cannot commit. Failed or uncertain writes block the browser until the database answers and `PrintSession.recover` reloads saved state, as a page reload would; stale-tab conflicts still need a reload. No outbox exists. Failed post-commit broadcasting disconnects streams and never changes a successful write result. Uncertain writes renew the instance ID and disconnect streams to discover commits with lost replies. One Linux writer process owns SSE versions; multi-service synchronization is out of scope.
- `npm run test:postgres` requires a separate disposable `TEST_DATABASE_URL` database whose name ends in `_test`; it migrates the database and clears its workspace, counter, attempt, ticket and event tables between tests. Never use station data. Docker Compose mounts the PostgreSQL 18 volume at `/var/lib/postgresql` and binds loopback only.

## Testing notes

- Test layers, from fastest to most realistic: Vitest unit tests with in-memory doubles (`tests/helpers/` and per-file fakes); `printer-service/http.test.ts` against a real loopback server with stubbed `cups`/`printing`/`orders`/`station`; `*.postgres.test.ts` against a real PostgreSQL 18 (durability, rollback, locks, migrations); Playwright with a mocked `/api` (`app.spec.ts`, `queue.spec.ts`); and Playwright against the real `createApp` with in-memory repositories (`queue-live.spec.ts`, `stations-live.spec.ts`). Nothing automated touches CUPS or a printer.
- Vitest runs in the `node` environment. Test-only memory repositories cover session behavior; real Postgres tests cover durability and transactions. Time and IDs are injected through constructor parameters (`now`, `id`, `send`, `run`, `render`), so prefer injection over global mocks. `stream.test.ts` uses fake timers.
- `printer-service/http.test.ts` opens real sockets on `127.0.0.1`. In a sandbox without loopback access, those tests time out rather than fail cleanly.
- CUPS is never invoked by tests. `Cups` takes a `Command` runner and `Printing` takes a `render` function. No test touches a physical printer.
- The Playwright specs use `page.clock` for wait ages and toast timers. They inspect the mocked central station repository to assert that intent was saved before the mocked `/api/print` responded. Keep that ordering assertion if you change `mockUsb`.
- Test-result screenshots go to the Git-ignored `test-results/`.

## Conventions

- **TypeScript strict** everywhere. Svelte 5 runes only (`$state`, `$derived`, `$derived.by`, `$effect`, `$props`); there are no Svelte stores.
- **Prettier** settings: single quotes, trailing commas, `endOfLine: auto`, and `prettier-plugin-svelte`. Markdown is formatted too. `design/` is excluded.
- **Dependencies:** the service uses `pdfkit`, Prisma 7, the Postgres adapter, and `pg`. Exact versions are pinned for the SvelteKit toolchain and Prisma/pg. Package overrides pin patched Prisma CLI transitive dependencies; preserve them until upstream incorporates the fixes. Avoid adding packages, especially anything the service would load. Authentication uses @node-rs/argon2 for code hashes; keep its version pinned.
- **Styling:** use the design-token CSS variables (`--cream-200`, `--radius-card`, and so on) from `design/tokens/tokens.css`. Shared classes go in `src/lib/builder.css`; page-only styles go in the component's `<style>`. Fonts and the logo are self-hosted in `static/` for offline use. The required Cloudflare Turnstile widget is the sole remote-script exception; other app assets remain self-hosted.
- **Comments:** sparse. A one-line `/** … */` on a class or function states the guarantee it provides, and inline comments explain _why_, not what.
- **Copy:** sentence case, with curly quotes and apostrophes in UI text (“ ” ’). Say plainly what happened to the print, for example "No job was submitted" or "Nothing will be resent automatically".
- **Commits:** short imperative sentence-case subjects with no type prefix, for example `Pack build queue cards into measured columns with chip servings`. `main` is the default branch.

## Gotchas

- `design/tokens/tokens.css` **ships in the app**: `+layout.svelte` imports it with `?raw`. The rest of `design/` is reference only. The `.dc.html` screens use a design-canvas template syntax and cannot render on their own; do not import them.
- The attempt mode `'star-usb'` and the session phase `'handoff'` exist only so old histories and the PassPRNT adapter still type-check and parse. Nothing in the UI constructs the simulated or PassPRNT adapters; only tests do.
- The service resolves `./build` with `realpath` at startup. Run it from the repository root after `npm run build`, or it exits.
- Printed ticket times use the **service host's** time zone, because the PDF is rendered there. The browser preview and the queue use the browser's time zone.
- `ORDER_PAD_ORIGIN` must be HTTPS. POSTs from `http://localhost:4174` are rejected by the Origin guard, even though GETs from that address are allowed.
- Order numbers are global; each browser profile has an independent Postgres workspace, kept across access codes. Its automatic cookie restores drafts and recovery across reloads. Use one active ordering tab per profile; same-profile edits invalidate stale revisions. Authentication never adopts existing anonymous workspaces automatically. Queue identity uses ticket IDs.
- Print requests use an in-process FIFO (eight waiting, 30-second slot timeout), then wait up to 30 seconds for CUPS to clear. Never replay after restart or retry a print. Browser print timeout is 240 seconds; keep update holds throughout.
- Editable drafts have no reference. Locked drafts retain their assigned reference and ticket ID. `startOrder` takes an attempt and returns the server-created ticket; missing-cookie POSTs fail without creating a workspace.
- On Windows, `.gitattributes` (`text=auto`) and Prettier's `endOfLine: auto` keep line endings from causing lint failures.

## Keep the docs in sync

| When you change…                                    | Update                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Menu, limits or ordering behavior                   | README "Using the order builder", `design/IMPLEMENTATION.md`, tests                                 |
| HTTP routes, status codes or payloads               | README "HTTP API"                                                                                   |
| Environment variables or startup                    | README "Configuration", `docs/linux-printing.md`                                                    |
| Browser or service storage layout                   | README "Data and persistence" and, if a migration is involved, "Upgrading a station…"               |
| Receipt layout, or anything needing physical checks | `docs/linux-printing.md` acceptance checklist                                                       |
| Results of a verification run or hardware test      | Add a dated entry at the top of `docs/verification.md`                                              |
| Request flow, tables or service structure           | README architecture and sequence diagrams (check they parse with Mermaid), "Life of an order" above |
| npm scripts, CI steps or test layout                | README "Commands" and "Project layout", this file's "Setup and verification" and code map           |
| Commands, layout or invariants in this file         | This file                                                                                           |

Never record a hardware result the owner has not reported. Automated checks use mocks and do not prove physical output, cutting or USB behavior.
