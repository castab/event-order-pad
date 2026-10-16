# Fiona's Order Pad

Touch-friendly order entry for an ice cream stand. Staff build each customer's order on a phone or tablet, a USB receipt printer attached to a Linux server prints a preparation ticket, and a second screen, **Now Scooping**, shows the build station which orders are still open. There are no prices or payments. Staff sign in with a username/password or an enrolled passkey; all users have equal order and queue access.

The app is a prerendered SvelteKit 3 / Svelte 5 PWA written in TypeScript. A small Node service on the Linux host serves it, prints through CUPS and uses PostgreSQL 18 as the source of truth for the whole station. The app service and database must run on the same machine. If the database is unavailable, order entry and printing are down.

> **Coding agents and new contributors:** start with [AGENTS.md](AGENTS.md). It lists the invariants that must not break, where each concern lives, and how to verify a change.

## How it fits together

```mermaid
flowchart TB
  subgraph Devices["Authenticated browsers"]
    B["Order builder /<br/>view state only, nothing stored in the browser<br/>except opaque authentication/browser cookies"]
    Q["Now Scooping /queue/<br/>live build queue"]
  end
  subgraph Host["One Linux machine"]
    TS["Cloudflare Tunnel<br/>public HTTPS hostname"]
    subgraph Svc["printer-service (Node) on 127.0.0.1:4174"]
      H["http.ts<br/>Session / Host / Origin / JSON guards, database gate,<br/>routing, static files from build/"]
      SR["Station repository<br/>workspaces, drafts, numbers,<br/>tickets, attempts"]
      PR["Printing + output (Cups or PdfOutput)<br/>one print at a time,<br/>PDF rendered with PDFKit"]
      OR["Orders + OrderStream<br/>order events, SSE snapshots"]
    end
    DB[("PostgreSQL 18, loopback only<br/>station, workspaces, tickets, print_attempts,<br/>print_dispatches, order_events, auth tables")]
    C["CUPS queue"]
    P["Star TSP143IIIU"]
  end
  B -- "page + GET/POST /api/station, GET /api/database,<br/>GET /api/printer, GET /api/features, POST /api/print" --> TS
  Q -- "page + GET /api/features, GET /api/orders/events (SSE),<br/>POST /api/orders/:id/done and /reopen" --> TS
  TS --> H
  H --> SR
  H --> PR
  H --> OR
  SR --- DB
  PR -- "dispatch claim and result" --- DB
  OR -- "append and read events" --- DB
  F["Development PDFs<br/>workspace-protected viewing"]
  PR -- "PDF mode: save file" --> F
  PR -- "CUPS mode: PDF via lp" --> C
  C -- USB --> P
```

The first print of an order crosses these boundaries in a fixed order. Nothing reaches the selected output until Postgres holds both the browser's intent and the service's own dispatch claim:

```mermaid
sequenceDiagram
  participant B as Browser (PrintSession)
  participant S as Service (http.ts)
  participant D as PostgreSQL
  participant C as Output (CUPS or PDF file)
  B->>S: POST /api/station startOrder (revision, attempt)
  S->>D: One transaction: number, immutable ticket, locked draft, pending attempt, submitted order event
  S-->>B: Snapshot with the committed ticket
  Note over B: A failed or uncertain commit stops here. Nothing is printed.
  B->>S: POST /api/print (ticket, attemptId)
  S->>D: Confirm the attempt belongs to this workspace, then insert the exclusive dispatch claim
  alt CUPS mode
    S->>C: Wait for an idle queue, then lp with the PDF
  else PDF mode
    S->>C: Save the receipt PDF atomically
  end
  C-->>S: Output accepted, or an error
  S->>D: Record the result on the dispatch
  S-->>B: accepted, failed or outcome-unknown
  B->>S: POST /api/station finishAttempt
  S->>D: Final attempt result and, if accepted, the next empty draft
```

- **Ordering device** opens the Linux host's HTTPS URL in a browser. Each signed-in user has a separate database-backed draft, last submitted ticket and print recovery state in each browser profile. An opaque browser cookie and authenticated user identity restore that workspace after login; switching users hides the previous user’s state. Browser API requests bind to the initially loaded user with `X-Order-Pad-User`; an old tab cannot write its draft into a different user’s workspace after a cookie change. Separate devices can take orders concurrently. No order data is persisted in the browser.
- **Linux host** runs `printer-service/`. It serves the static app from `build/`, renders each ticket as a PDF, submits it with `lp` to a local CUPS queue, and stores all station state and append-only order history in PostgreSQL 18 on the same host. Cloudflare Tunnel provides public HTTPS; application authentication protects access even through loopback or an alternative proxy. The docs call this machine the "Linux host", or "Mint" for the verified station.
- **Build station** opens `/queue/` on the same origin and receives live updates over Server-Sent Events (SSE).

The UI uses the same-origin service for CUPS printing or PDF development output. The repository also contains simulated and Android PassPRNT adapters; they are kept for unit tests and history and cannot be selected in the interface.

### Terms used throughout

| Term               | Meaning                                                                                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Serving**        | One cup or cone with its scoops, flavors and toppings.                                                                                                                  |
| **Order** / ticket | One customer's 1–30 servings. The immutable `OrderTicket` is the order; its ID is the order's identity everywhere.                                                      |
| **Workspace**      | The Postgres row for one user in one browser profile, resolved from the authenticated user and opaque browser cookie. Only order numbers are shared between workspaces. |
| **Attempt**        | One try at printing a ticket, first print or REPRINT. It ends as `accepted`, `failed` or `outcome-unknown`.                                                             |
| **Dispatch**       | The service's own exclusive claim on an attempt, committed before `lp`. A claim without a result is never replayed.                                                     |
| **Order event**    | An append-only `submitted`, `completed` or `reopened` row. The latest event for a ticket ID decides whether its queue card is open or done.                             |
| **Tracking**       | `ORDER_PAD_TRACKING_ENABLED`. It only decides whether the queue is visible. Orders are recorded either way.                                                             |
| **Capture cutoff** | `ORDER_PAD_CAPTURE_FROM`. Tickets created before it are excluded from the queue, and the service refuses to start new orders before it.                                 |
| **Accepted**       | CUPS queued the job. It does not prove paper came out.                                                                                                                  |

**Station status.** The verified station (2026-10-11) is Linux Mint 22.3 with Node 24, the CUPS queue `Star_TSP143` using the Star TSP100 Cutter driver, and a Galaxy S10e as the ordering device over Tailscale HTTPS. The owner reported a successful CUPS test page and successful Order Pad prints from that phone, including a built order. The detailed physical acceptance checklist (layout, REPRINT, interruptions and recovery) is not yet recorded as complete. See [docs/linux-printing.md](docs/linux-printing.md).

## Quick start (development)

Requirements: Node 22.17 or later (CI uses Node 24) and npm.

```sh
npm ci
npm run dev
```

The dev server listens on port 5173 on all interfaces (`--host 0.0.0.0`), so other devices on your network can reach it.

There is no in-app printer simulator, and the dev server has no `/api` routes. Expect this during development:

- Protected screens stay behind “Checking sign-in” or a connection error because the dev server has no authentication/session API.
- Login pages can render, but real sign-in and Turnstile configuration require the service.
- Draft work requires the real service and database, or the API fixtures in tests.

Full print and queue flows run in the Playwright suite, which mocks the API or starts the real HTTP service with a stubbed CUPS. CUPS output requires Linux, a local USB CUPS queue and an HTTPS origin. PDF development output runs on Windows, macOS and Linux (see [PDF development printing](#pdf-development-printing)).

## Accounts and sign-in

The application has one permission level: every enabled account can build and print orders and manage Now Scooping. Authentication is mandatory; there is no public signup or browser-based account administration. A session lasts 16 hours, including browser restarts. Login, enrollment and recovery require server-verified Turnstile; a verification outage blocks new logins, including passkeys, while existing sessions continue to work.

After building the service and applying migrations, create the first account on the Linux host:

```sh
npm run auth -- bootstrap fiona
npm run auth -- invite staff-name
npm run auth -- recover staff-name
npm run auth -- disable staff-name
npm run auth -- enable staff-name
npm run auth -- list
npm run auth -- revoke staff-name
```

`bootstrap` prompts for a password without echo and only succeeds when no users exist. Usernames are case-insensitive, 3–32 ASCII letters/digits/dots/underscores/hyphens. Passwords contain 15–128 Unicode characters; spaces are preserved and there are no composition rules. Passwords are salted Argon2id hashes (19 MiB, two iterations, parallelism one).

`invite` reserves the chosen username and prints a single-use code and enrollment URL, valid for 24 hours. Hand the code or URL to the person directly; no email, SMS or account with another provider is required. Tokens are stored only as hashes, and URL tokens use fragments that the page immediately removes. Issuing another token replaces the previous one. `revoke` invalidates outstanding enrollment/recovery codes for that username.

`recover` immediately disables existing credentials, removes passkeys and revokes sessions. Its 30-minute code sets a new password and re-enables the account; passkeys must then be added again. Revoking or losing the recovery code leaves the account requiring another local recovery operation. `disable` and `enable` revoke sessions, retaining station/order history.

Enrollment and recovery links carry their code in the URL fragment, so the page shows “Invite code added from your link” (or “Recovery code…”) instead of an empty code field; **Enter a code instead** reveals the field. After setting a password, the page offers to add a passkey for this device before opening the order builder; skipping is fine and the account is already usable.

The username button in the builder, Now Scooping and account headers opens **Your account** and **Sign out**. The account page lets a user add/remove named passkeys, change their password, sign out, or sign out everywhere (which also ends the current session). Credential changes require authentication within five minutes; when the last sign-in is older, pressing **Add a passkey**, **Remove** or **Change password** opens a “Confirm it’s you” dialog (password or passkey, with Turnstile) and then continues into that action. **Lock now** only hides the unlocked state in that browser; the server keeps honouring the recent sign-in until its five minutes pass. Password changes revoke other sessions. Passkeys are bound to the exact configured HTTPS origin and hostname; choose the final hostname before enrolling them.

Turnstile renders in interaction-only mode, so Cloudflare's widget appears only when it needs a tap. Buttons stay enabled while a token is pending: pressing one shows “Checking…”, waits up to 15 seconds for the token, then submits or reports that the browser couldn't be verified. Each token is used once.

Authentication attempts have persistent per-IP, username/IP and username limits, with `429`/`Retry-After` responses and temporary cooldowns. Rejected usernames receive the same limits as existing ones. Turnstile is an additional check, not an account credential or a replacement for rate limiting. The only externally hosted script is the required Cloudflare Turnstile widget.

## Commands

| Command                                | What it does                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                          | Vite dev server for the UI (port 5173, all interfaces).                                                                                                                                   |
| `npm run db:generate`                  | Generates the server-only Prisma client into `printer-service/generated/` (Git-ignored). `check` and `build:printer` run it first.                                                        |
| `npm run db:migrate -- --name NAME`    | Creates/applies a development migration; requires a development database and shadow database privileges. All `db:*` commands read `.env`.                                                 |
| `npm run db:deploy`                    | Applies committed migrations to the configured database; run explicitly before deployment.                                                                                                |
| `npm run db:studio`                    | Starts Prisma Studio on `http://localhost:5555` for inspecting the database; see [Inspect the database](#inspect-the-database).                                                           |
| `npm run test:postgres`                | Applies migrations and runs integration tests against a separate `TEST_DATABASE_URL` ending in `_test`. Reads `.env`; never uses station data.                                            |
| `npm run test:postgres:volume`         | Starts a disposable Docker `postgres:18` container and volume, recreates the container and verifies the data survived. Needs Docker only.                                                 |
| `npm run check`                        | Generates Prisma, then `svelte-kit sync`, `svelte-check` for the app, `tsc -p tsconfig.printer.json` for `printer-service/`, and `tsc` for the service worker.                            |
| `npm run lint`                         | Prettier check of the whole repository. `npm run format` rewrites files.                                                                                                                  |
| `npm test`                             | Vitest unit and HTTP tests (`*.postgres.test.ts` files are excluded and run by `test:postgres`). `npm run test:watch` re-runs on change.                                                  |
| `npm run build`                        | Static app and service worker into `build/`.                                                                                                                                              |
| `npm run build:printer`                | Generates Prisma and bundles the Linux service into `build-printer/server.mjs`.                                                                                                           |
| `npm run auth -- <command> [username]` | Local account bootstrap, enrollment, recovery, enable/disable, listing and token revocation; uses `.env` and the bundled CLI.                                                             |
| `npm run start:printer`                | Runs the bundled service with `.env` loaded when present. CUPS output is Linux only; PDF output is cross-platform. Run it from the repository root (see [Configuration](#configuration)). |
| `npm run preview`                      | Serves `build/` with Vite on port 4173. Like `dev`, it has no `/api` routes.                                                                                                              |
| `npx playwright install chromium`      | One-time browser download for the end-to-end tests.                                                                                                                                       |
| `npm run test:e2e`                     | Playwright against `vite preview` on port 4175. **Run `npm run build` first**: both the preview server and the live-queue tests serve `build/`.                                           |

To run everything CI runs, in CI's order:

```sh
npm ci
npm run test:postgres  # needs TEST_DATABASE_URL for a separate *_test database
npm run test:postgres:volume  # needs Docker; uses its own disposable container
npm run check
npm run lint
npm test
npm run build
npm run build:printer
npx playwright install chromium
npm run test:e2e
```

CI ([.github/workflows/checks.yml](.github/workflows/checks.yml)) runs these against PostgreSQL 18 on Node 24 for every pull request and every push to `main`, with `--with-deps` on the Playwright install. To check a branch that has no pull request, start the workflow manually from the Actions tab. Browser tests run in desktop Chromium. They do not replace testing on the Android phone and printer. The lockfile pins the SvelteKit 3 toolchain.

## Project layout

```text
src/
  lib/auth/           Session clients, login/Turnstile widgets and safe-navigation holds
  lib/tickets/        Menu, draft editing, ticket validation, receipt layout (pure: no DOM, I/O or transport)
  lib/printing/       Print port, PrintSession (intent saved before every send), printer adapters
  lib/storage/        Database API client: station snapshots, revisions and durable writes
  lib/orders/         Queue order model, API client, SSE feed, column packing
  lib/app-update.ts   Applies service-worker updates only when it is safe to reload
  lib/builder.css     Global component styles and local Poppins @font-face rules
  routes/+layout.*    Session gate, prerendering, design-token injection, update checks
  routes/+page.svelte         Order builder (/)
  routes/queue/+page.svelte   Now Scooping (/queue/)
  routes/{login,enroll,recover,account}/  Sign-in and credential management
  service-worker/     Versioned static asset cache; HTML and APIs always use the network (own tsconfig; excluded from the root project)
printer-service/      Linux Node service: HTTP API, static hosting, CUPS, PDF, Postgres dispatch journal, Prisma station/order stores, authentication, SSE; auth-cli.ts bundles the local account command.
                      Its Prisma client is generated into printer-service/generated/ (Git-ignored); `*.postgres.test.ts` need a real database.
prisma/               Schema and committed PostgreSQL migrations (prisma.config.ts at the root loads .env for the db:* commands)
compose.yaml          Local PostgreSQL 18 with a persistent named volume, bound to loopback
deploy/               Cloudflare Tunnel example configuration
tests/                Playwright specs: auth.spec.ts (login, virtual passkeys, account switching, offline protection and print-session expiry), app.spec.ts (builder, mocked API), queue.spec.ts (queue, mocked API and EventSource), queue-live.spec.ts and stations-live.spec.ts (real HTTP service with in-memory repositories and stubbed CUPS); helpers/ holds the in-memory test doubles
scripts/              test-postgres.mjs and test-postgres-volume.mjs, the runners behind the two Postgres test commands
.env.example          Template for the Git-ignored .env (service, Docker Compose and test variables)
.github/workflows/    CI (checks.yml)
static/               Poppins fonts, logo, icons, web app manifest
design/               Design handoff (brief, reference screens, tokens). tokens/tokens.css ships in the app.
docs/                 Station setup, hardware notes, verification log
```

## Using the order builder

### Menu and rules

A **serving** is one cup or cone.

- **Flavors:** Chocolate, Vanilla, Strawberry, Chocolate Chip. Flavors can be mixed in one serving.
- **Scoops:** 1–5 per serving, counted across all its flavors. Every count starts at zero.
- **Container:** exactly one of Cup, Cake Cone or Sugar Cone. Nothing is preselected.
- **Toppings (optional):** any combination of Whipped cream, Gummy Bears, Caramel Sauce, Chocolate Sauce, Sliced Almonds, Maraschino Cherries, Rainbow Sprinkles and Chocolate Sprinkles.

An **order** has 1–30 servings, as long as the ticket fits the receipt limits (240 text lines and 2000 mm, with room reserved for a REPRINT banner). An order that is too long blocks printing with a message. The customer name is optional, up to 80 printable characters, with control characters removed. A blank name becomes a stable two-word label derived from the order number, such as **Sunny Caramel** for #0043. The label is resolved once and stored on the ticket.

The menu is defined in [src/lib/tickets/ticket.ts](src/lib/tickets/ticket.ts). The design brief in [design/IMPLEMENTATION.md](design/IMPLEMENTATION.md) has the full ordering rules.

### Building and printing

1. Use the **+ / −** buttons to set scoops for one or more flavors. At five scoops every **+** is disabled until you remove one.
2. Choose a container and any toppings.
3. For a one-serving order, tap **Print order**. Printing includes the serving you are still editing.
4. For more servings, tap **Add serving** after each one, then print after configuring the last. The button reads **Print order · N servings** when there is more than one.

You can tap a saved serving to edit it. While editing, **Add serving** becomes **Save serving** and **Cancel serving** becomes **Cancel edit**. If you print while editing, the edited serving replaces the original; it is never duplicated. A serving with no scoops or no container blocks printing until you finish or cancel it. Tapping a saved serving while a new one is half-built does nothing, so the unfinished serving is not lost.

The header shows **New order** until the service assigns a number when committing print intent, then shows the assigned order number and a **Reprint last order** button. **Order tools**, collapsed by default, contains:

- the **Now Scooping** link, when order tracking is on;
- **Printer settings**: the CUPS queue, a readiness message, **Check printer** and setup notes;
- a ticket preview for the current draft;
- the last submitted order, its receipt and its print attempts;
- **New order**, which clears the current draft.

Opening or closing Order tools never changes the draft. The app checks printer readiness when it loads and when Order tools opens. No printer selection or setup confirmation is needed.

### The prep ticket

Each ticket has a header with the date and time (`Sun 10/11 · 7:42 PM`), a large `#0043` order number, the display name, and totals (`3 SERVINGS | 7 SCOOPS`). One block follows per serving, then `END OF TICKET` and the ticket ID. Each serving block has `SERVING 1 OF 3`, a black scoop-count tag beside the container (`[3] SCOOPS · CUP`), one line per flavor (`2 × Chocolate Chip`), and its toppings or **No toppings**. Flavors and toppings always print in menu order. For example, a cup with 2 Chocolate Chip and 1 Strawberry is one serving: `[3] SCOOPS · CUP`, then `1 × Strawberry`, then `2 × Chocolate Chip`. Reprints start with an inverse **REPRINT** banner reading "Check for the first copy before building".

The Linux service renders the PDF, so printed times use **the Linux host's local time zone**. The ticket preview in Order tools uses the browser's time zone and a plain-text layout (`3 SCOOPS - CUP`, `1 x Strawberry`).

### After printing

- **Accepted:** the next empty order opens immediately with the next number. A toast such as "Order #0043 sent to the printer · Maria · 3 servings · 7 scoops" offers **Reprint** and disappears after six seconds.
- **Failed** (nothing was submitted) or **outcome unknown** (the job may or may not have printed): the order stays locked with a recovery panel offering **Reprint saved order** and **New order**, and an error toast stays until you dismiss it. An unknown outcome requires checking the physical output and pending CUPS jobs, then ticking **I checked the output and am ready to continue**, before you can reprint or start a new order. Nothing is ever resent automatically.
- **Reprint last order** prints the previous ticket again with the same ticket ID, number, name and timestamp, plus the REPRINT banner. It never changes the draft you are currently building.

## Now Scooping (build queue)

Open **Now Scooping** from Order tools, or browse to `/queue/` on the same HTTPS origin from the build-station tablet. The queue depends on the Linux service. A static host or the dev server cannot show it.

- Open orders appear oldest first. The header shows counts of open orders, servings to build and the oldest wait.
- Each card shows the order number, display name, time placed and a wait badge: moss under 5 minutes, olive from 5 to 10, rust at 10 or more. Ages refresh at least every 30 seconds.
- Each serving lists its flavors as rounded chips with a count bubble, and its toppings as separate outlined chips with a `+` icon. A serving without toppings shows a dashed **No toppings** chip.
- **Mark #0043 done** takes one tap with no confirmation. The **Recently done** strip keeps the latest eight completed orders with **Undo**.
- Cards are packed into 1, 2, 3 or 4 columns depending on the content width (below 640, 1000 and 1500 px, otherwise 4). Each card goes into the currently shortest column by measured height, leftmost on ties, so short cards leave no gaps. Cards re-pack only when the set of open orders or the column count changes, never on the 30-second refresh. `aria-posinset` and `aria-setsize` keep screen readers in age order.

**Live updates.** On connect, the service sends `retry: 3000` and a complete snapshot, then a new snapshot after every saved change, and a `ping` every 15 seconds. If the browser receives nothing for 45 seconds, it reconnects and shows a warning. There is no event replay and no polling fallback. Each service process has an instance ID (renewed after uncertain database writes) and each snapshot a revision, so a delayed snapshot or action response cannot overwrite newer state. On a connection error the last list stays visible with **Reconnecting…** and **Refresh queue**. A failed first load never shows the empty state. Done and Undo are disabled while the stream is disconnected; reconnect or refresh to confirm database state before continuing. Action errors stay visible until a later action succeeds or you refresh.

**What creates a card.** An order is registered on its **first** print submission, even if that print then fails or its outcome is unknown, so a card is not proof that a ticket printed. Orders are keyed by the immutable ticket ID. Repeat registrations are no-ops, reprints never add or reopen a card, and only **Undo** reopens a done order. Completed events remain in Postgres after orders leave the Recently done strip. Orders at or after the fixed capture cutoff are recorded even when tracking is off; older history is not imported.

The browser commits the first order through `POST /api/station`. One Postgres transaction saves the immutable ticket, locked draft, counter, pending attempt and submission event before `POST /api/print` is called. A failed or uncertain commit blocks printing; once the database answers again the builder reloads committed state from Postgres without resending. There is no browser outbox or delayed publication.

## Optional order tracking

Tracking is on by default. For an event that only needs printed tickets, start the service with tracking off:

```sh
export ORDER_PAD_TRACKING_ENABLED=false
npm run start:printer
```

The value must be exactly `true` or `false`; anything else stops the service at startup. Restart the service and reload open tabs after changing it. No rebuild is needed.

While tracking is off:

- the builder hides Now Scooping and `/queue/` shows "Order tracking is turned off";
- queue GET routes (`/api/orders` and its SSE endpoint) return 404 with code `ORDER_TRACKING_DISABLED`;
- order submission, Done, and Undo POST routes still persist events;
- printing, reprints, drafts, recovery and order numbers work normally;
- saved order history and the print journal remain durable.

Tracking settings affect queue visibility only. All draft and print-intent writes still require Postgres; a database outage blocks work even with tracking off. The builder learns visibility on its next printer check or reload; an open queue stops its stream when it detects the change. Set `true` (or unset the variable), restart and reload to resume the queue, including orders captured while it was hidden. No completion is inferred from print acceptance: staff must explicitly mark Done, or an authorized same-origin client must call the Done API.

## Printing and reliability

Every print attempt ends in one of three results:

| Result            | Meaning                                                                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accepted`        | CUPS accepted the job into its queue. This is not proof of physical output: paper, cover or cable problems can still happen afterwards, and a queued job may print later. |
| `failed`          | Rejected before submission, for example by an invalid ticket, a pending CUPS job, a busy service or an unsuitable queue. No job was sent.                                 |
| `outcome-unknown` | The send was interrupted, its response was lost or malformed, or its result could not be saved. The ticket may or may not have printed.                                   |

These rules hold across the browser and the service:

- **Intent before send.** The browser commits the ticket and pending attempt to Postgres before calling the print endpoint. The service commits an exclusive dispatch record in the same database before running `lp`. If either commit fails, nothing is submitted.
- **Explicit pre-submit rejections.** Recognized service 400/403/413 validation/origin errors and database-unavailable 503 errors are reported as failed with “No job was submitted.” Unexpected HTTP errors, malformed replies, and lost responses remain unknown. Deploy and restart the service together with the app to avoid ticket-version mismatches.
- **No automatic retries.** A pending attempt without a durable service result found after a reload or service restart becomes `outcome-unknown` and is never replayed. A recorded service result is authoritative even when its browser reply was lost. Repeating an attempt ID returns the saved result. Reusing an attempt ID with different content is rejected.
- **Final results are final.** A late or repeated report cannot change a completed attempt.
- **Tickets are immutable.** A reprint is a new attempt for the same ticket, marked REPRINT. It is never a new ticket.
- **One submission at a time.** The service serializes print requests in arrival order, allowing up to eight waiting requests. Waiting for a slot expires after 30 seconds without submission. An admitted request waits up to another 30 seconds for pending CUPS jobs to clear, checking once per second; if they remain, nothing is submitted for that attempt. Inspect the printer and `lpstat -o` before deliberately reprinting. Waiting requests are never replayed after restart.
- **One active ordering tab per browser profile.** Separate profiles/devices have independent drafts and recovery state. Tabs in one profile share a workspace; revision checks reject stale writes with 409, and the stale tab shows “Open in another tab” (distinct from “Database needs attention”) until it reloads. The queue can be open on any number of devices.

There is no background print queue or exactly-once print guarantee. Postgres centralizes order history; backups remain the operator’s responsibility. Other applications that print through CUPS bypass the service's lock.

## PDF development printing

Set these values in a development `.env`, using a separate local PostgreSQL 18 database such as `order_pad_dev`:

```dotenv
DATABASE_URL=postgresql://order_pad:YOUR_PASSWORD@127.0.0.1:5432/order_pad_dev
ORDER_PAD_PRINT_MODE=pdf
ORDER_PAD_ORIGIN=http://localhost:4174
ORDER_PAD_PROXY=direct
ORDER_PAD_TURNSTILE_SITE_KEY=YOUR_LOCALHOST_SITE_KEY
ORDER_PAD_TURNSTILE_SECRET_KEY=YOUR_LOCALHOST_SECRET_KEY
ORDER_PAD_PDF_DIR=.receipt-pdfs
ORDER_PAD_FONT=C:/Windows/Fonts/consola.ttf
ORDER_PAD_CAPTURE_FROM=2026-10-13T00:00:00.000Z
```

Authentication remains mandatory in PDF mode. Configure Turnstile for localhost, use direct proxy mode, and bootstrap a development account on the separate database. Passkeys enrolled for localhost do not transfer to your public hostname.

Create that database first with your local PostgreSQL administrator. Retain the cutoff across restarts and ensure it is not in the future. Choose a readable TTF: Windows can use the path above; macOS and Linux can use an installed or copied TTF via its absolute path. For matching typography, copy the station's DejaVuSansMono.ttf to the development machine and point `ORDER_PAD_FONT` to it. Different fonts change text widths. The same PDF renderer and 72 mm receipt geometry are used, with a minimum height of 30 mm; the real driver may select longer stock.

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run build
npm run build:printer
npm run auth -- bootstrap developer
npm run start:printer
```

Open [the local service](http://localhost:4174). Sign in with the development account. Chromium supports Secure cookies on localhost; keep using the same hostname for its user/browser workspace. The app shows **PDF development mode — no physical printing**. **Print order** creates a normal numbered order and queue event in the development database, then saves a PDF instead of sending paper. Open Order tools → Last submitted order → **View PDF** to view or download it. Reprints create separate files with REPRINT marking. Saved files are named by attempt ID, excluded from Git in the default directory, and survive service restarts. Choose an output directory outside `build/` so static serving cannot expose it.

The dispatch journal still records intent and outcomes. Lost replies or interrupted saves require acknowledgment and are never retried automatically. Viewing reads an existing file; it does not regenerate missing receipts. PDF mode still requires the service and local Postgres; `npm run dev` alone has no APIs. PDF inspection does not verify physical output or cutting.

## Configuration

The service reads environment variables once at startup. `npm run start:printer` loads `.env` when it exists (`node --env-file-if-exists=.env`); variables already exported in the shell take precedence over `.env`. Copy [.env.example](.env.example) to start. Every variable is validated, and an invalid or missing required value stops startup:

| Variable                         | Default                                               | Notes                                                                                                                                                                                                                      |
| -------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                   | _required_                                            | Postgres URL using `127.0.0.1`, `localhost` or `[::1]`. Remote hosts and connection-host overrides are rejected. Never supplied to the browser.                                                                            |
| `ORDER_PAD_CAPTURE_FROM`         | _required_                                            | Fixed ISO UTC timestamp with milliseconds, e.g. `2026-10-13T00:00:00.000Z`. Set it once to the rollout time and keep it across restarts. See below.                                                                        |
| `ORDER_PAD_ORIGIN`               | _required_                                            | Root HTTPS origin the browsers use, such as `https://orders.example.com`. Use `https:` with no path, query or credentials; PDF mode also accepts loopback HTTP origins.                                                    |
| `ORDER_PAD_PROXY`                | `direct`                                              | `cloudflare` trusts valid `CF-Connecting-IP` only from loopback cloudflared ingress. Missing/malformed headers reject public authentication operations. `direct` uses the socket address and ignores forwarded IP headers. |
| `ORDER_PAD_TURNSTILE_SITE_KEY`   | _required_                                            | Public Turnstile widget key, configured for the exact application hostname.                                                                                                                                                |
| `ORDER_PAD_TURNSTILE_SECRET_KEY` | _required_                                            | Server-only Turnstile verification secret. Never put this in a browser build or Git.                                                                                                                                       |
| `ORDER_PAD_QUEUE`                | `OrderPad`                                            | Name of the local USB CUPS queue: letters, digits, `_` and `-`, up to 80 characters. The default is not a real queue name; set this. The verified station uses `Star_TSP143`.                                              |
| `ORDER_PAD_PORT`                 | `4174`                                                | Loopback port (1024–65535). The service binds to `127.0.0.1` only.                                                                                                                                                         |
| `ORDER_PAD_FONT`                 | `/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf` | Font embedded in receipt PDFs (`apt install fonts-dejavu-core`). PDF mode requires an explicit readable TTF path.                                                                                                          |
| `ORDER_PAD_TRACKING_ENABLED`     | `true`                                                | Exactly `true` or `false`. See [Optional order tracking](#optional-order-tracking).                                                                                                                                        |
| `ORDER_PAD_PRINT_MODE`           | `cups`                                                | Exactly `cups` or `pdf`; PDF mode saves receipt files and never calls CUPS.                                                                                                                                                |
| `ORDER_PAD_PDF_DIR`              | `.receipt-pdfs`                                       | PDF output directory, resolved from the working directory; only used in PDF mode. Files remain until manually removed.                                                                                                     |

**Capture cutoff.** `ORDER_PAD_CAPTURE_FROM` separates old history from the live station. A ticket created before it is never added to the queue (`POST /api/orders` answers `{ excluded: true }`), and the service rejects `startOrder` when its own clock is earlier than the cutoff, so a cutoff in the future blocks all new orders until that time. The service uses its own clock for ticket timestamps, so keep the host clock accurate. Do not change the value after rollout, and never lower it to backfill history; events already stored are not removed or re-evaluated.

**Variables used outside the service.** Docker Compose and the tests read these from `.env` too; the service ignores them:

| Variable                                            | Used by                                                                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `compose.yaml` creates the local database with them. Keep `DATABASE_URL` consistent with them (the example uses `order_pad`). |
| `POSTGRES_PORT`                                     | Host loopback port Compose publishes (default `5432`). Keep `DATABASE_URL` consistent with it.                                |
| `TEST_DATABASE_URL`                                 | `npm run test:postgres`. Must name a separate disposable database ending in `_test`; the tests clear its tables.              |

**Start the service from the repository root.** It serves `./build` and checks the migrated database before listening. An unreachable database or missing schema stops startup. Keep environment configuration stable across restarts.

Requests must use the configured origin. The `Host` header must match `ORDER_PAD_ORIGIN`, `127.0.0.1:PORT` or `localhost:PORT`. POST requests must send `Origin` equal to `ORDER_PAD_ORIGIN` and `Content-Type: application/json`. Request bodies are limited to 128 KiB, and no CORS headers are sent. Every operational API requires a valid session, including printer status, printing, explicit order registration and SSE. Unauthenticated API calls return JSON `401` with `code: "authentication-required"`; protected pages redirect to `/login/`. Authentication database failures return `503`. Station setup, Cloudflare Tunnel, CUPS options and the physical acceptance checklist are in [docs/linux-printing.md](docs/linux-printing.md).

## HTTP API

All `/api` responses use `Cache-Control: no-store`. Responses are JSON except the SSE stream and receipt PDFs. Shared types live in [src/lib/printing/port.ts](src/lib/printing/port.ts), [src/lib/tickets/ticket.ts](src/lib/tickets/ticket.ts) and [src/lib/orders/](src/lib/orders/).

| Endpoint                           | Request                                                                      | Response                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/database`                | none                                                                         | 200 `{ ready: true }` after checking the required schema; 503 when unavailable.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/station`                 | none                                                                         | `{ revision, draft, saved?: { ticket, attempts } }`, the browser workspace’s state; resolves the signed-in user/browser workspace and issues the opaque browser cookie when needed.                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/station`                | `{ revision, operation, draft?, ticket?, attempt? }`                         | Updated workspace snapshot. A valid workspace cookie is required. `startOrder` accepts only `{ revision, operation: "startOrder", attempt }`; the service prepares the saved draft, allocates the number and timestamp, and returns the committed ticket before printing. Operations: `saveDraft`, `saveTicket`, `startOrder`, `startAttempt`, `finishAttempt`. 400 invalid input, 409 stale revision or invalid state transition, 503 unavailable/uncertain write.                                                    |
| `GET /api/printer`                 | none                                                                         | 200 `{ ready, queue, message }` when the database is available. Includes `mode: "cups"                                                                                                                                                                                                                                                                                                                                                                                                                                 | "pdf"`. PDF mode checks its output directory and font; CUPS mode checks that the queue exists, is enabled, uses `usb://` and offers the Star variable-length and cut options. |
| `POST /api/print`                  | `{ ticket, attemptId, reprint }`; `attemptId` matches `[A-Za-z0-9_-]{1,100}` | 200 `{ attemptId, result }`, where `result` is a `PrintAttemptResult`. Print failures are 200 with `result.status` of `failed` or `outcome-unknown`; 400 means invalid input; 503 with `code: "database-unavailable"` means the database gate rejected the request before printing. A matching saved pending intent owned by the browser workspace is required. 409 rejects missing workspaces or foreign intents without submission. The browser waits up to 240 seconds for the result; lost replies remain unknown. |
| `GET /api/features`                | none                                                                         | `{ trackingEnabled }`, the setting the service is running with. Requires the database.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST /api/orders`                 | schema 2 ticket                                                              | `{ order, created }`: 201 when first created, 200 when the ID already exists (unchanged), or 200 `{ excluded: true, ticketId }` for a pre-cutoff ticket.                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/orders`                  | optional `?status=open` or `?status=done`                                    | `{ orders }`: open orders oldest first, then the eight most recently done. `status` filters to one of the two lists.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/orders/events`           | none (`EventSource`)                                                         | SSE. `orders` events carry `{ orders, instanceId, revision }`; `ping` events every 15 s.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /api/orders/:id/done`        | `{}`                                                                         | `{ order, instanceId, revision }`. Idempotent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /api/orders/:id/reopen`      | `{}`                                                                         | `{ order, instanceId, revision }`. Idempotent; keeps the original submission time.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /api/receipts/:attemptId.pdf` | Authenticated session and browser cookie                                     | PDF mode only: existing receipt PDF with inline disposition and no-store. Requires ownership of the recorded dispatch; missing or foreign receipts return 404. Database unavailability returns 503. Viewing never regenerates a PDF.                                                                                                                                                                                                                                                                                   |

A queue order is `{ ticket, submittedAt, status: 'open' | 'done', doneAt? }`. `submittedAt` is the ticket's own `createdAt`, so a delayed publication does not reset its wait time.

**Who calls what.** The builder calls `/api/database` (health check), `/api/station`, `/api/printer`, `/api/features` and `/api/print`. The queue calls `/api/features`, `/api/orders/events` and the Done/Undo POSTs. The app itself never calls `POST /api/orders` or `GET /api/orders`: the first order commits through `POST /api/station`. Those two routes remain for diagnostics and authorized same-origin clients, and they obey the same cutoff, tracking and database rules.

**Request rules and failures:**

- **Every `/api` route requires the database.** A failed schema check returns 503 with `code: "database-unavailable"` before CUPS is touched, and queue visibility cannot bypass this gate.
- **Host and Origin.** A wrong `Host` returns 403. A POST to `/api/station`, `/api/print` or `/api/orders*` with the wrong `Origin` or a non-JSON `Content-Type` returns 403. The SSE endpoint rejects a foreign `Origin` or `Sec-Fetch-Site: cross-site` with 403.
- **Tracking off.** Only the queue GET routes (`/api/orders`, `/api/orders/events`) return 404 with `code: "ORDER_TRACKING_DISABLED"`. Every order POST stays available.
- **Other errors.** Unknown order IDs return 404, an unknown `/api` path returns 404, and a request body over 128 KiB returns 413. An unavailable order database returns 503.
- **No automatic retries.** Done and Undo are not retried. After an ambiguous response, refresh the queue before trying again.
- **Static files.** Any other GET or HEAD outside `/api` serves a file from `build/`. Protected files require a session. Authentication pages and their static dependencies are public. Files under `/_app/immutable/` are cached for a year; other files are `no-store`. HTML scripts receive per-response CSP nonces.

### Authentication HTTP API

All POST routes below require the configured Origin and JSON; all responses use `no-store`. Only config and login/enrollment/recovery operations are public. Credential management requires an authenticated session. `response` is the standard WebAuthn JSON response; options replies contain `{ options }`. Successful POSTs return `{ ok: true }` and set/clear secure cookies as applicable.

| Endpoint                                                                       | Input / response                                                                                     |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `GET /api/auth/config`                                                         | `{ sitekey }`; no secrets.                                                                           |
| `GET /api/auth/session`                                                        | `{ user: { id, username }, expiresAt, authenticatedAt }`.                                            |
| `POST /api/auth/login`                                                         | `{ username, password, turnstile }`.                                                                 |
| `POST /api/auth/enroll`, `/api/auth/recover`                                   | `{ token, password, turnstile }`; reserved username comes from the token.                            |
| `POST /api/auth/passkey/login/options`                                         | `{ turnstile }`; issues a single-use, five-minute browser-bound challenge after verification.        |
| `POST /api/auth/passkey/login/verify`                                          | `{ response }`; consumes the approved challenge.                                                     |
| `POST /api/auth/logout`, `/api/auth/logout-all`                                | `{}`; revoke current/all sessions.                                                                   |
| `POST /api/auth/reauthenticate`                                                | `{ username, password, turnstile }`; refresh recent authentication without extending session expiry. |
| `POST /api/auth/passkey/reauth/options`, `/api/auth/passkey/reauth/verify`     | `{ turnstile }` / `{ response }`; session-bound passkey confirmation.                                |
| `POST /api/auth/password`                                                      | `{ password }`; recent authentication required; rotates the session and revokes other sessions.      |
| `GET /api/auth/passkeys`                                                       | `{ passkeys: [{ id, name, createdAt }] }`; no public keys or secrets.                                |
| `POST /api/auth/passkey/register/options`, `/api/auth/passkey/register/verify` | `{}` / `{ response, name }`; recent authentication and a session-bound challenge required.           |
| `POST /api/auth/passkey/remove`                                                | `{ id }`; recent authentication required.                                                            |

Limits are 120 authentication-page requests/IP/minute, 10 unauthenticated authentication operations/IP/minute, five password failures/username/IP per 15 minutes, and 20 password failures/username per 15 minutes. Username failure budgets reserve a slot before verification and refund it on successful authentication. At most two password hashes run concurrently; excess work receives `429` instead of queuing. IPv6 addresses are canonicalized. No account is permanently locked by failed login attempts.

## Data and persistence

**PostgreSQL 18 on the app host is the only durable application store.**

| Table              | Contents                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `station`          | One global increasing reference counter; numbers allocated only within committed first-order intent.                  |
| `workspaces`       | Independent drafts, revisions, latest ticket IDs and internal workspace keys; legacy anonymous records are preserved. |
| `tickets`          | Immutable schema 2 tickets, keyed by ticket ID.                                                                       |
| `print_attempts`   | Pending intents and final attempt outcomes.                                                                           |
| `print_dispatches` | Exclusive service dispatch claims, results and completion timestamps. Pending claims are never replayed.              |
| `order_events`     | Append-only submission, completion and reopening events, with full immutable tickets.                                 |

Prisma also maintains migration metadata. First submissions commit the ticket, locked draft, attempt and queue event atomically. Finalizing an accepted attempt commits its outcome and next draft together. Stored data passes through shared validators. One service process owns writes and SSE versions; multiple printer services and direct database writes are unsupported.

The browser holds transient view state and two opaque `Secure; HttpOnly; SameSite=Strict; Path=/` cookies: `__Host-order-pad-session` (16 hours) and `__Host-order-pad-browser` (one year). A five-minute `__Host-order-pad-challenge` cookie binds a passkey ceremony to its browser. No order data is stored in IndexedDB, localStorage, sessionStorage or an outbox. `auth_workspaces` resolves each user/browser pair to an internal workspace key; the old anonymous cookie is not accepted for authenticated authorization. Clearing browser cookies creates a new workspace without deleting history.

Authentication tables are `auth_users`, `auth_sessions`, `auth_passkeys`, `auth_challenges`, `auth_tokens`, `auth_rates`, `auth_events` and `auth_workspaces`. Sessions, enrollment/recovery tokens and challenges store only opaque token hashes. Passkeys retain public keys, counters and authenticator metadata. Authentication events record event type, optional user ID and hashed client IP, without credentials or tokens. Minute-by-minute cleanup removes up to 100 expired rows per transient table and up to 100 security events older than 90 days.

A failed draft write or database health check blocks editing and printing until Postgres answers again. Authentication loss blocks interaction immediately, waits for active saves/prints to settle, and returns to login. After login, saved state is reloaded without replaying mutations or prints. A structured authentication rejection before print dispatch means nothing was submitted; a lost or ambiguous reply remains unknown. SSE checks authorization before snapshots and on 15-second heartbeats and closes exactly at session expiry.

Queue projections select the latest event before filtering. A partial unique submission index and per-order advisory transaction locks prevent duplicate registrations. Workspace mutations use a transaction lock plus an expected revision to reject stale tabs in the same workspace. Edits in other workspaces do not invalidate that revision. A shared counter assigns unique numbers at first-order intent commit, above preserved counters and existing Postgres history. Abandoned editable drafts consume no numbers; committed failed/unknown prints retain their number. Reprints reuse the original number. The blank-name label is resolved only after number assignment; draft previews display “Assigned when printed”.

Database waits are bounded (1 s service-operation queue, 1 s connection/acquisition, 2 s statements, 3 s driver queries, 4 s transactions). Missing/invalid configuration, an unreachable database, or missing schema stops startup. Failed post-commit broadcasting disconnects streams without changing a successful write result. Uncertain writes retire stream versions so reconnects discover commits with lost replies. No browser or print request is automatically retried.

### Set up Postgres and upgrade the station

1. Before switching, finish or reconcile drafts and all pending/ambiguous attempts. Close ordering tabs, stop the old service and back up PostgreSQL and legacy data. Apply the new `authentication` migration explicitly with `npm run db:deploy`; startup never migrates. Existing tickets, attempts, events and anonymous workspaces remain intact but are not automatically assigned to an account. New authenticated workspaces start empty. Changing domains creates new browser cookies/workspaces; retain the old history and settle pending work before moving. Legacy IndexedDB and `.print-data/` remain untouched archives.
2. Copy `.env.example` to `.env` (Git-ignored). Choose a local database password and update `DATABASE_URL` with its URL-encoded value. Set the real HTTPS origin and CUPS queue. Set `ORDER_PAD_CAPTURE_FROM` once to the rollout time in UTC; keep device clocks accurate and retain this cutoff across restarts.
3. Install Docker with Compose, or run PostgreSQL 18 directly on this same app host. Remote database deployment is unsupported. For local Docker, run `docker compose up -d --wait`. Postgres binds only to loopback and uses a named volume mounted at `/var/lib/postgresql`, the PostgreSQL 18 image’s versioned data layout. Container recreation preserves it; `docker compose down --volumes` deletes database history.
4. Run `npm ci`, `npm run db:deploy`, `npm run build`, and `npm run build:printer`. Migrations are explicit; startup never applies them. Client generation needs no database connection and runs automatically before checks and the printer build.
5. Set both Turnstile keys and `ORDER_PAD_PROXY`, build the service, run `npm run auth -- bootstrap <username>`, and configure the Cloudflare Tunnel as described in [Linux printing](docs/linux-printing.md). With no print attempt or CUPS job pending, stop the old service and start `npm run start:printer` from the repository root. Reload ordering and queue tabs together. A direct Node launcher such as `start-printer.local` must use `node --env-file=.env build-printer/server.mjs` or export all required configuration variables. For an existing systemd service, configure `EnvironmentFile=/absolute/path/to/order-pad/.env`, run `sudo systemctl daemon-reload`, then `sudo systemctl restart order-pad.service` instead of starting a second process. The verified Mint station uses this systemd service; its process must restart after rebuilding the service.

`npm run test:postgres:volume` creates its own disposable container and volume, verifies persistence after container recreation, and cleans them up. Docker access is required; it does not touch the station database.

For integration tests, create a separate disposable database ending in `_test`, set `TEST_DATABASE_URL`, and run `npm run test:postgres`. The script applies migrations and clears only that test database’s station and authentication tables between tests. With the example Docker configuration, create it using `docker compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" order_pad_test'`. CI provisions its own PostgreSQL 18 service. Do not point tests at station history.

Back up all Postgres tables together, for example with `pg_dump` through the container. Keep the volume intact across updates. Database loss includes drafts and print history, so never reset or restore it while a print may be unresolved. A restore to an earlier backup cannot establish whether a newer physical ticket printed; reconcile paper and CUPS first.

### Inspect the database

`npm run db:studio` starts Prisma Studio, which ships with the Prisma CLI, at `http://localhost:5555` and opens it in your browser. It listens on loopback only and reads `DATABASE_URL` from `.env`. Add `-- --port 5556` to choose another port.

Use Studio to look, not to edit. Studio can change and delete rows, and every hand edit is a direct database write the service does not expect:

- `order_events` is append-only, and the latest event decides an order’s state. Changing or deleting a row can reopen a completed order or hide an open one.
- Tickets are immutable and re-validated on every read. A hand-edited ticket the menu rejects makes the station return 503.
- Changing a workspace draft or revision causes conflicts in open browsers.
- Changing an attempt or dispatch can hide an unknown print outcome, so staff may reprint a ticket that already printed.

On the station database, connect with a read-only role so a stray click cannot write. Create it once (with the example Docker configuration, run `docker compose exec postgres psql -U order_pad order_pad`):

```sql
CREATE ROLE order_pad_readonly LOGIN PASSWORD 'choose-a-password';
GRANT CONNECT ON DATABASE order_pad TO order_pad_readonly;
GRANT USAGE ON SCHEMA public TO order_pad_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO order_pad_readonly;
ALTER DEFAULT PRIVILEGES FOR ROLE order_pad IN SCHEMA public GRANT SELECT ON TABLES TO order_pad_readonly;
```

Then pass its URL instead of the service’s:

```sh
npm run db:studio -- --url="postgresql://order_pad_readonly:choose-a-password@127.0.0.1:5432/order_pad"
```

Edits in Studio then fail with a permission error. Never use Studio to repair a print record; reconcile paper and CUPS first.

## Updates and offline use

After one online visit, the service worker caches static assets. HTML navigations always use the network and never fall back to a cached page; activation purges previous page caches. Authentication and operational `/api` requests are never cached. The client checks its session before rendering protected screens, including after browser history restoration. Offline navigation shows a connection error. Drafts, recovery and printing require the app host and its local database.

An open tab checks for a new version on load, when you return to the tab, when the device comes back online, and every five minutes. A downloaded update is applied with an automatic reload when the tab is hidden, within ten seconds of loading, or after a minute without input. It is held back while a print is in flight, an unknown outcome awaits acknowledgment, database access is blocked, a draft write is pending, or the draft is still loading. The draft and queue recover after the reload. See [src/lib/app-update.ts](src/lib/app-update.ts) and [src/service-worker/index.ts](src/service-worker/index.ts).

## Upgrading a station with old browser data

The Postgres-backed app never opens `order-pad-v1`. It does not rename, migrate, clear or reset v1/v2 browser records, and it no longer reads or writes `.print-data/` print journals. Preserve both archives for manual reconciliation, and inspect pending output before rollout. Previous browser drafts, last receipts, attempts and unpublished outbox entries are not automatically transferred to Postgres; complete or reconcile them with the old version first. Existing centralized queue events remain available. See the [station upgrade steps](#set-up-postgres-and-upgrade-the-station).

## Known limits and deferred work

- Independent order-taking sessions are supported across browser profiles/devices. Tabs in the same profile share a workspace and stale tabs must reload. One Linux service owns the shared printer and SSE versions. Ticket IDs remain queue identity.
- `accepted` means queued in CUPS. The app has no live hardware sensors.
- The npm launcher runs in the foreground. The verified Mint station uses `order-pad.service`; configure its environment file and restart it after service updates. The cloudflared service keeps the tunnel running, not Node. Check host sleep settings before event use (see [docs/linux-printing.md](docs/linux-printing.md)).
- Physical acceptance of the current receipt layout, REPRINT, hardware errors and interruption recovery is still open.

## Documentation

| Document                                                         | Read it for                                                                                                            |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                                           | Guide for coding agents and contributors: invariants, code map, change recipes and testing.                            |
| [docs/linux-printing.md](docs/linux-printing.md)                 | Setting up, updating and restarting the Linux station, CUPS options, the verified setup, and the acceptance checklist. |
| [docs/verification.md](docs/verification.md)                     | Dated log of automated checks and owner-reported hardware results.                                                     |
| [docs/printing-compatibility.md](docs/printing-compatibility.md) | Background on the earlier Android PassPRNT route and official Star sources.                                            |
| [docs/hardware-test.md](docs/hardware-test.md)                   | Device evidence and the earlier PassPRNT hardware checklist.                                                           |
| [design/IMPLEMENTATION.md](design/IMPLEMENTATION.md)             | The original design brief for the builder, prep ticket and queue: ordering rules and layout specs.                     |
