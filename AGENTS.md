# AGENTS.md

This guide is for AI coding agents and human contributors. [README.md](README.md) explains what the product does and how to operate it. This file explains how to change the code without breaking anything that matters.

## The project in brief

Fiona's Order Pad is an ice cream order builder that prints preparation tickets on a Star TSP143IIIU receipt printer. It has two parts:

- **Browser app** (`src/`): a SvelteKit 2 / Svelte 5 static PWA with two screens, the order builder at `/` and **Now Scooping** (the build queue) at `/queue/`. It saves drafts, tickets and print attempts in IndexedDB.
- **Linux service** (`printer-service/`): a dependency-light Node HTTP server. It serves `build/`, renders tickets to PDF with PDFKit, submits them to CUPS with `lp`, keeps a durable print-attempt journal and order store, and streams queue snapshots over SSE.

The service imports domain code from `src/lib/` directly, so the browser and the server share one ticket model and one validator. There are no prices, payments or accounts.

## Setup and verification

Node 22.12 or later (CI uses Node 24) and npm. Everything except _running_ the service works on Windows, macOS and Linux. The service refuses to start on anything other than Linux.

```sh
npm ci
npx playwright install chromium   # once
```

**Definition of done.** Run all of these and make sure they pass. Order matters: `test:e2e` serves `build/`, so `build` has to run first.

```sh
npm run check          # svelte-check (0 errors, 0 warnings) + tsc for printer-service
npm run lint           # Prettier, including Markdown; fix with `npm run format`
npm test               # Vitest: src/**/*.test.ts and printer-service/**/*.test.ts
npm run build          # build/
npm run build:printer  # build-printer/server.mjs
npm run test:e2e       # Playwright, Chromium, vite preview on :4175
```

CI ([.github/workflows/checks.yml](.github/workflows/checks.yml)) runs the same sequence on Node 24 for every push and pull request. The full suite takes about a minute locally: 187 Vitest tests in 19 files and 120 Playwright runs as of 2026-10-12.

Faster loops:

```sh
npx vitest run src/lib/tickets                 # one area
npx playwright test tests/queue.spec.ts        # one spec
npx playwright test --project=builder-390x844  # app.spec.ts at phone size only
```

`tests/app.spec.ts` runs three times, once per viewport project: `builder-390x844`, `builder-820x1180` and `builder-1280x800`. The other specs run in the `chromium` project.

`npm run dev` and `npm run preview` have no `/api` routes, so **Printer unavailable** and a disabled **Print order** button are expected there. That is not a bug. There is no in-app simulator. Use the tests to exercise print and queue flows.

## Code map

| Path                                                        | Responsibility                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/tickets/ticket.ts`                                 | The menu (`FLAVORS`, `CONTAINERS`, `TOPPINGS`), limits, `OrderTicket`/`Serving` types, `parseTicket`, `parseServing`, `blankNameLabel`, `sampleTicket`.                                                       |
| `src/lib/tickets/order.ts`                                  | `OrderDraft` and pure editing operations: `commitServing`, `editServing`, `removeServing`, `cancelServing`, `prepareDraftForPrint`, `draftTicket`, `newDraft`.                                                |
| `src/lib/tickets/format.ts`                                 | Receipt layout. `formatTicket` gives text lines (preview and the 240-line limit); `prepTicketLayout` gives absolute geometry for PDF and HTML (576 px at 8 px/mm, 2000 mm cap); `assertPrintable` runs both.  |
| `src/lib/printing/port.ts`                                  | `TicketPrinter`, `PrintAttempt` and `PrintAttemptResult` (`accepted` / `failed` / `outcome-unknown`), plus `PrintHandoff` for PassPRNT.                                                                       |
| `src/lib/printing/session.ts`                               | `PrintSession`: the browser state machine (`loading → ready → saving → printing → ready`, or `blocked`). It saves intent before every send, serializes draft writes and recovers pending attempts as unknown. |
| `src/lib/printing/adapters/linux-cups.ts`                   | `LinuxCupsPrinter` (`POST /api/print`) and `linuxPrinterStatus` (`GET /api/printer`). This is the **only** adapter the UI uses.                                                                               |
| `src/lib/printing/adapters/{simulated,passprnt}.ts`         | Kept for unit tests and history. They cannot be selected in the UI.                                                                                                                                           |
| `src/lib/storage/ticket-store.ts`                           | `IndexedDbTicketStore`, database `order-pad-v1` at version 2 (stores `tickets`, `attempts`, `settings`). Owns the atomic multi-store transactions and the queue outbox.                                       |
| `src/lib/orders/order.ts`                                   | `QueueOrder`, `parseOrder`, `sortOrders`, and wait-time helpers (`waitMinutes`, `waitTone`).                                                                                                                  |
| `src/lib/orders/{live,client,stream,features,publisher}.ts` | Snapshot and version parsing, REST client, `QueueFeed` (EventSource with a 45 s watchdog), the tracking flag, and `OrderPublisher` (5 s outbox retry).                                                        |
| `src/lib/orders/pack.ts`                                    | `columnCount` and `packColumns`: shortest-column card packing for the queue.                                                                                                                                  |
| `src/lib/app-update.ts`, `src/service-worker.ts`            | Network-first shell cache and update reloads that wait until `holdUpdates()` is released.                                                                                                                     |
| `src/routes/+page.svelte`                                   | Order builder UI. It wires `PrintSession`, `LinuxCupsPrinter`, `OrderPublisher`, the toast, recovery and Order tools together.                                                                                |
| `src/routes/queue/+page.svelte`                             | Now Scooping UI: measured column packing, chips, Done and Undo, and handling of the tracking-disabled state.                                                                                                  |
| `src/routes/+layout.svelte`, `+layout.ts`                   | Injects `design/tokens/tokens.css` (with `@font-face` stripped), loads `src/lib/builder.css`, starts update checks, and sets `prerender = true`.                                                              |
| `printer-service/server.ts`                                 | Entry point. Reads and validates the `ORDER_PAD_*` environment variables, resolves `./build` and the data directory **from the current working directory**, and listens on `127.0.0.1`.                       |
| `printer-service/http.ts`                                   | `createApp()`: routing, Host/Origin/Content-Type guards, the 128 KiB body limit, static file serving and the tracking gate.                                                                                   |
| `printer-service/printing.ts`                               | `Printing`: per-attempt journal (`<attemptId>.json`), busy lock, intent written and fsynced before `lp`, and unknown recovery without replay.                                                                 |
| `printer-service/cups.ts`                                   | `Cups`: `lpstat` and `lpoptions` readiness checks, Star option detection, media selection and `lp` submission. External commands are injected through `Command`.                                              |
| `printer-service/receipt.ts`                                | PDF rendering from `prepTicketLayout`, using the configured TTF font.                                                                                                                                         |
| `printer-service/orders.ts`, `order-stream.ts`, `config.ts` | `Orders`: serialized, atomic, file-per-order store with instance ID and revision. `OrderStream`: one SSE client with backpressure and heartbeat. `config.ts`: strict flag parsing.                            |
| `tests/app.spec.ts`                                         | Builder end-to-end tests. `/api/*` is mocked with `page.route` (see `mockUsb`).                                                                                                                               |
| `tests/queue.spec.ts`                                       | Queue UI tests. `EventSource` is replaced through `addInitScript`, and REST calls are mocked with `context.route`.                                                                                            |
| `tests/queue-live.spec.ts`                                  | Runs the real `createApp` with a temporary `Orders` directory and stubbed CUPS and printing on a random loopback port, serving `build/`.                                                                      |

## Invariants: do not break these

Each rule exists to prevent a duplicate or lost ticket during service. Tests enforce most of them, so if a change makes one of those tests fail, fix the change, not the test.

1. **Intent before send.** A ticket and its pending attempt must be committed to IndexedDB before any adapter call (`PrintSession.send`, `IndexedDbTicketStore.startOrder`). The service must write and fsync its journal entry before `lp` (`Printing.print`). If the save fails, send nothing.
2. **Never resend a print automatically.** Never add retries around `/api/print` or `printer.print`. A pending attempt found after a reload or restart becomes `outcome-unknown` and stays that way. Only the order outbox retries, and it only calls `POST /api/orders`.
3. **Three outcomes, final once written.** `failed` means nothing was submitted. Anything ambiguous (timeouts, lost or malformed responses, a result that could not be saved) is `outcome-unknown`. A completed attempt is never overwritten (`finishAttempt` aborts if `before.result` exists).
4. **Unknown outcomes need acknowledgment.** After `outcome-unknown`, reprinting and **New order** stay disabled until the operator confirms they checked the output (`requiresConfirmation`, `outputConfirmed`).
5. **Tickets are immutable, and reprints reuse them.** A reprint is a new attempt with `reprint: true` for the same ticket ID, number, name and `createdAt`. `saveTicket` aborts if stored content differs. Reprints never create, duplicate or reopen a queue order.
6. **One validator.** All ticket input passes through `parseTicket`: HTTP bodies, IndexedDB reads, the order journal and the outbox. It returns deeply frozen objects in canonical menu order, rejects anything except `schema: 2` (including v1 `items`), and calls `assertPrintable`, so every accepted ticket can also be printed as a REPRINT. Apply the same pattern to new data: write `parseX(unknown)` that either throws a user-facing `Error` or returns a frozen value.
7. **Queue identity is the ticket ID.** `Orders.upsert` is idempotent and never changes an existing record. Only `POST /api/orders/:id/reopen` reopens. `submittedAt` is the ticket's `createdAt`. Done records stay on disk.
8. **Tracking is optional and never blocks printing.** Failures of `/api/features` or `/api/orders` must not disable the print button. `POST /api/print` registers the order on a best-effort basis and prints regardless.
9. **No caching of `/api`, and no reload mid-send.** The service worker ignores `/api/*`. `+page.svelte` holds updates while working, awaiting acknowledgment, loading or blocked. Any new long-running UI operation must take a `holdUpdates()` hold too.
10. **Same-origin only.** The service accepts only its configured Host values. POSTs to `/api/print` and `/api/orders*` require `Origin === ORDER_PAD_ORIGIN` and JSON. Do not add CORS. **A new POST route must be added to the guard in `http.ts` explicitly**, because the guard matches paths and new routes are not covered automatically.
11. **Shared modules stay portable.** `src/lib/tickets/*`, `src/lib/orders/{order,live,features}.ts` and `src/lib/printing/port.ts` are bundled into the Node service. Use relative imports there, not `$lib` (the printer build has no SvelteKit aliases), and do not touch the DOM, `window` or SvelteKit modules at import time. `src/lib/tickets/` stays pure: no I/O, transport or prices.
12. **Browser storage is station data.** Never rename the `order-pad-v1` database or its stores. Any change to its shape needs a version bump and an `onupgradeneeded` path in `ticket-store.ts`, plus a note in README's upgrade section. The v1 to v2 reset is a one-time, owner-approved exception.
13. **Accessibility and touch.** Use real `<button>` toggles with `aria-pressed`, keep the `aria-live` scoop total, keep touch targets of at least 44 px, keep DOM order equal to reading order (layout uses `grid-template-areas`, not CSS `order`), and keep `aria-posinset`/`aria-setsize` on queue cards. The Playwright tests find elements by role and accessible name, so renaming a label means updating the tests.

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
2. **Adding is safe. Renaming or removing is not.** Stored tickets, drafts, outbox entries and server order files are re-validated with `parseTicket`, so an unknown value blocks browser storage ("Local storage is unavailable or damaged") and makes the order store return 503. Plan a migration or a deliberate reset first.
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

### Change browser persistence

Follow invariant 12. Write data for the same order in one transaction (`startOrder` and `finishAttempt` show the pattern). Test with a fresh `fake-indexeddb` `IDBFactory`, as `ticket-store.test.ts` does.

## Testing notes

- Vitest runs in the `node` environment. IndexedDB comes from `fake-indexeddb`. Time and IDs are injected through constructor parameters (`now`, `id`, `send`, `run`, `render`), so prefer injection over global mocks. `publisher.test.ts` and `stream.test.ts` use fake timers.
- `printer-service/http.test.ts` opens real sockets on `127.0.0.1`. In a sandbox without loopback access, those tests time out rather than fail cleanly.
- CUPS is never invoked by tests. `Cups` takes a `Command` runner and `Printing` takes a `render` function. No test touches a physical printer.
- The Playwright specs use `page.clock` for wait ages and toast timers. They read IndexedDB directly to assert that intent was saved before the mocked `/api/print` responded. Keep that ordering assertion if you change `mockUsb`.
- Test-result screenshots go to the Git-ignored `test-results/`.

## Conventions

- **TypeScript strict** everywhere. Svelte 5 runes only (`$state`, `$derived`, `$derived.by`, `$effect`, `$props`); there are no Svelte stores.
- **Prettier** settings: single quotes, trailing commas, `endOfLine: auto`, and `prettier-plugin-svelte`. Markdown is formatted too. `design/` is excluded.
- **Dependencies:** the browser app has no runtime dependencies, and the service uses only `pdfkit`. Exact versions are pinned for the SvelteKit toolchain. Avoid adding packages, especially anything the service would load.
- **Styling:** use the design-token CSS variables (`--cream-200`, `--radius-card`, and so on) from `design/tokens/tokens.css`. Shared classes go in `src/lib/builder.css`; page-only styles go in the component's `<style>`. Fonts and the logo are self-hosted in `static/` for offline use. Do not load anything from a CDN.
- **Comments:** sparse. A one-line `/** … */` on a class or function states the guarantee it provides, and inline comments explain _why_, not what.
- **Copy:** sentence case, with curly quotes and apostrophes in UI text (“ ” ’). Say plainly what happened to the print, for example "No job was submitted" or "Nothing will be resent automatically".
- **Commits:** short imperative sentence-case subjects with no type prefix, for example `Pack build queue cards into measured columns with chip servings`. `main` is the default branch.

## Gotchas

- `design/tokens/tokens.css` **ships in the app**: `+layout.svelte` imports it with `?raw`. The rest of `design/` is reference only. The `.dc.html` screens use a design-canvas template syntax and cannot render on their own; do not import them.
- The attempt mode `'star-usb'` and the session phase `'handoff'` exist only so old histories and the PassPRNT adapter still type-check and parse. Nothing in the UI constructs the simulated or PassPRNT adapters; only tests do.
- The service resolves `./build` with `realpath` at startup. Run it from the repository root after `npm run build`, or it exits.
- Printed ticket times use the **service host's** time zone, because the PDF is rendered there. The browser preview and the queue use the browser's time zone.
- `ORDER_PAD_ORIGIN` must be HTTPS. POSTs from `http://localhost:4174` are rejected by the Origin guard, even though GETs from that address are allowed.
- Order numbers come from a per-browser counter (`settings.referenceCounter`), so two ordering devices will issue the same numbers. Queue identity uses ticket IDs and is unaffected.
- On Windows, `.gitattributes` (`text=auto`) and Prettier's `endOfLine: auto` keep line endings from causing lint failures.

## Keep the docs in sync

| When you change…                                    | Update                                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Menu, limits or ordering behavior                   | README "Using the order builder", `design/IMPLEMENTATION.md`, tests                   |
| HTTP routes, status codes or payloads               | README "HTTP API"                                                                     |
| Environment variables or startup                    | README "Configuration", `docs/linux-printing.md`                                      |
| Browser or service storage layout                   | README "Data and persistence" and, if a migration is involved, "Upgrading a station…" |
| Receipt layout, or anything needing physical checks | `docs/linux-printing.md` acceptance checklist                                         |
| Results of a verification run or hardware test      | Add a dated entry at the top of `docs/verification.md`                                |
| Commands, layout or invariants in this file         | This file                                                                             |

Never record a hardware result the owner has not reported. Automated checks use mocks and do not prove physical output, cutting or USB behavior.
