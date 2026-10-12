# Order Pad

A touch-friendly SvelteKit/TypeScript ice cream order builder and shared build queue with preparation receipts, USB printing and durable recovery. Orders contain separately configured servings; there are no prices or payments.

The station uses a **Star TSP143IIIU / TSP100IIIU USB printer attached to the Linux server**, with phones, tablets, or the server itself acting as browser clients. The server sends every order to its single configured local CUPS queue. There is no printer selector or simulation/PassPRNT mode in the ordering interface.

The owner has confirmed building an order and printing its receipt. Follow [Linux USB setup](docs/linux-printing.md) for server configuration and the updated workflow’s physical acceptance checklist.

## Run and check

Use Node 22.12+ or 24 and npm.

```sh
npm ci
npm run dev
```

Use the +/− controls to choose scoop counts for one or more flavors, choose a container, then select any toppings. Each cup or cone allows **1–5 scoops total** across its flavors. The total updates automatically; at five scoops, remove one before adding another. Flavors start at zero and the container has no default. For a single serving, tap **Print order** directly; it includes the serving currently being configured. For multiple servings, use **Add serving** for each earlier serving, then print the last one directly. Editing a serving and pressing Print saves that replacement without duplicating it. **Save serving**, **Remove**, and **Cancel serving** remain available.

The menu is:

- Flavors: Chocolate, Vanilla, Strawberry, Chocolate Chip.
- Containers: Cup, Cake Cone, Sugar Cone.
- Toppings: Whipped cream, Gummy Bears, Caramel Sauce, Chocolate Sauce, Sliced Almonds, Maraschino Cherries, Rainbow Sprinkles, Chocolate Sprinkles.

Enter an optional name (up to 80 printable characters). Blank names use a stable
adjective and ice cream noun derived from the numeric order reference, such as
**Sunny Caramel** for #0043. Each serving has its own preparation block with its
total and per-flavor scoop counts, container, and toppings, including **No
toppings** when appropriate. For example, one cup with 2 Chocolate Chip + 1
Strawberry prints **3 SCOOPS - CUP**, then **1 x Strawberry** and **2 x Chocolate
Chip** in menu order; it remains one serving. Orders support up to 30 servings,
subject to receipt-length limits. At least one scoop and a container are required
before printing. Incomplete selections must be completed or canceled. Schema 2
tickets remain immutable for reprinting; old browser records receive the one-time
reset described below.

The builder shows customer name, saved servings, and the current serving, with an always-visible print action. **Order tools** contains printer settings, receipt previews, print attempts, and New order. Opening or closing these tools preserves the draft. Accepted prints reset the builder and show a six-second toast; failed or unknown outcomes keep the order saved with visible recovery actions. Unknown outcomes require inspecting the printer before continuing. The header reprints the last order without changing its identity or an independent draft. The supplied Fiona’s Ice Cream logo uses the official cream-200 color in both page headers; Poppins fonts and the logo are hosted locally for offline use. Readiness is checked automatically on startup; no recurring setup acknowledgment is required. A static-only host cannot print.

After the server accepts a submission, the accepted result and a fresh empty draft save together. The screen is ready for the next customer, while **Reprint last order** preserves the previous receipt’s ID, label, timestamp, and REPRINT marker. Reprinting while building another order does not change that draft. **New order** explicitly clears a draft.

Failed or unknown submissions remain locked for deliberate recovery and do not advance automatically. Unknown outcomes require inspecting physical output/pending jobs and acknowledging before continuing. No automatic resend occurs. Drafts, unfinished selections, and the latest submitted ticket/attempts recover after reload. An older accepted locked draft advances on reload without another send. Storage failure blocks printing; browser cleanup and changing origin/profile can remove recovery data.

```sh
npm run check
npm run lint
npm test
npm run build
npm run build:printer
npx playwright install chromium
npm run test:e2e
npm run preview
```

The lockfile pins dependencies; the cookie override resolves an upstream SvelteKit 2 advisory. CI runs equivalent checks on Node 24. Browser checks are desktop Chromium, not Android hardware acceptance.

## USB station setup

Configure the existing local USB CUPS queue with the Star TSP100 Cutter driver, set `ORDER_PAD_QUEUE` to its name, and run the same-origin Linux service. The verified station uses `Star_TSP143`. Printer configuration is managed on the server; browser clients use that destination automatically. See [Linux USB setup](docs/linux-printing.md) for the exact commands, driver options, HTTPS setup, restart instructions, and physical checks.

## Boundaries and reliability

- `src/lib/tickets/`: fixed menu, validated drafts, immutable tickets and shared receipt layout; no SDK, DOM, prices or transport.
- `src/lib/printing/port.ts`: printer-neutral port, attempt IDs, handoff and accepted/failed/unknown results.
- `src/lib/printing/adapters/`: Linux same-origin adapter used by the UI; simulation and PassPRNT adapters retained for unit tests and historical transport compatibility.
- `printer-service/`: optional Linux host; receipt PDF, CUPS submission, durable attempt journal and static serving. The domain remains printer-neutral.
- `src/lib/printing/session.ts`: saves intent first, locks repeated taps, correlates callbacks, completes attempts once and recovers interruptions as unknown.
- `src/lib/storage/`: IndexedDB; independent drafts, immutable tickets/separate attempts and atomic first-order intent; unavailable storage blocks sends. Structured tickets use schema 2 and IndexedDB version 2; the one-time v1 reset is described below.
- `src/routes/+page.svelte`: token-styled serving builder, toast and recovery feedback, collapsed Order tools, and direct USB submissions/reprints.
- `src/lib/orders/` and `printer-service/orders.ts`: shared order records, disk persistence, live SSE snapshots, and a durable publication outbox; order retries cannot resend printing.
- `src/routes/queue/`: oldest-first build cards, age badges, completion and Undo.
- `src/service-worker.ts`: versioned same-origin shell caching; no USB send/result caching or forced mid-job updates.

In the current UI, accepted means CUPS accepted a queue submission, not physical verification. The attempt model still supports simulator/PassPRNT results. Pre-send rejection is failed; partial/interrupted/missing results are unknown. Late/repeated callbacks cannot rewrite a final outcome. URL callbacks are correlated external reports, not authenticated physical proof. It also retains the IV adapter identifier; v1 browser history receives the one-time reset below.

Every new submission and reprint uses the server USB route; there is no transport fallback. Keep one station tab. There is no background print queue, cloud backup or exactly-once guarantee. Background order updates never invoke a printer. Linux uses the existing CUPS spooler; inspect pending jobs before reprinting. Browser cleanup, origin/profile changes and eviction can remove local data.

## Optional order tracking

Tracking is enabled by default. For an event that only needs printed receipts,
start the printer service with:

```sh
export ORDER_PAD_TRACKING_ENABLED=false
npm run start:printer
```

The value must be exactly `true` or `false`. Restart the service and reload open
Order Pad tabs after changing it; no rebuild is needed just to change the setting.
With tracking off, the builder hides **Build queue**, `/queue/` shows a disabled
message, and queue APIs and SSE are disabled. Ordinary printing, reprints, draft
recovery and numeric references continue working. Existing server order history
and the print-attempt journal stay intact.

When a browser learns tracking is off, it discards pending queue publications
while preserving tickets, attempts and drafts. Orders printed while disabled are
not imported later. Set the value to `true` (or remove it), restart and reload to
resume tracking new orders and view the saved history. An already-open queue stops
its connection when it detects the disabled service; the builder discovers the
setting on its next tracking check.

## Shared build queue

Open **Build queue** in Order tools, or open `/queue/` at the same Mint HTTPS
origin on the build-station tablet. The service pushes an initial queue snapshot
and updates after every saved order change over Server-Sent Events (SSE). The
queue sorts open orders by their first submission and shows serving totals and wait ages.
Wait badges use moss below five minutes, olive from five to ten, and rust at ten
minutes or more. **Mark #… done** takes one tap; the latest eight completed orders
have **Undo**. Ages refresh at least every 30 seconds. Connection errors preserve
the last received list and expose a refresh action; a failed initial load does not
claim the queue is empty. Mark done and Undo remain usable while live updates are
disconnected if their normal API requests still succeed. Action failures remain
visible until a successful action or manual refresh; live events do not hide them.

The browser reconnects automatically, with a three-second server-advertised delay.
Every connection receives a complete current snapshot, including after a service
restart; there is no historical event replay. A 15-second heartbeat keeps the
connection active, and 45 seconds without an event triggers a reconnect and warning.
The queue never falls back to polling. Stream revisions and per-service instance
IDs prevent delayed snapshots or action responses from overwriting newer state.
These versions are in memory; no order journal migration is needed.

An order is registered on its first print submission, including submissions whose
print result is failed or unknown. A queue card does not prove physical output.
Orders are keyed by immutable ticket ID, not reference or attempt ID. Repeated
upserts leave the original ticket and status unchanged. Reprints never create a
missing order, duplicate an open card, or reopen a completed order. Only explicit
Undo reopens it. Completed identities remain on disk even after they leave the
recent-eight strip. Existing print history is not imported into the queue.

The Linux service atomically saves orders in `ORDER_PAD_DATA/orders/` (default
`.print-data/orders/`), separately from the print-attempt journal. Preserve both
across service updates and restarts. One service process owns these files. The
browser also commits a pending order update alongside first-print intent in its
existing IndexedDB transaction. Failed publications retry every five seconds and
survive reloads; these retries call only `/api/orders`, never `/api/print`. This
also covers a future non-CUPS transport without changing the print session or port.
Printer submission proceeds if the order registry is temporarily unavailable.

The API uses validated schema 2 tickets and same-origin JSON mutations:

| Endpoint                                       | Result                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/features`                            | `{ trackingEnabled }`; the current server setting.                                                    |
| `POST /api/orders` (ticket body)               | `{ order, created }`; 201 for first creation, 200 for an existing ID left unchanged.                  |
| `GET /api/orders/events`                       | SSE: `orders` events contain `{ orders, instanceId, revision }`; `ping` events keep the stream alive. |
| `GET /api/orders`                              | `{ orders }`: all open orders oldest first, then the latest eight done orders.                        |
| `GET /api/orders?status=open` or `status=done` | Open orders or the latest eight done orders.                                                          |
| `POST /api/orders/:id/done` (`{}` body)        | `{ order, instanceId, revision }`; idempotently marks it done.                                        |
| `POST /api/orders/:id/reopen` (`{}` body)      | `{ order, instanceId, revision }`; idempotently reopens it, retaining its first submission time.      |

Each order contains `ticket`, `submittedAt` (the ticket’s original submission time
in ISO UTC), `status`, and the server’s `doneAt` when done. Delayed publications
retain the original time so waiting ages do not reset when a connection recovers.
When tracking is disabled, every `/api/orders` endpoint returns 404 with code
`ORDER_TRACKING_DISABLED`. Unknown IDs return 404; unavailable order storage returns 503. API
responses are uncached. References still come from the existing browser counter:
keep one ordering station. Prisma, Postgres, and shared reference allocation
are deferred; this phase requires no Docker setup.

## Phase 1 storage upgrade

Before opening the updated app on a station with old browser data, inspect any
unfinished physical output and pending CUPS jobs. The first open upgrades the
existing `order-pad-v1` IndexedDB database to version 2 and **automatically deletes
v1 tickets, print attempts (including unfinished attempts), and order drafts**.
These generic `items` records cannot safely represent structured servings. The
reset is atomic and happens once; subsequent opens preserve schema 2 tickets,
attempts, and drafts. Close other station tabs if the upgrade is blocked.

The printer service's durable `.print-data` journal and CUPS jobs are not reset,
and the upgrade never sends or retries a print. Browser order numbers restart at
`#0001`, increase as new drafts are saved, and survive reloads. Reprints retain the
original number, display name, timestamp, servings, and ticket ID. Abandoned
orders can leave gaps. Keep one station tab; shared reference allocation across ordering phones remains deferred. The build queue can be viewed from multiple devices, but use one order-taking station.

Prep tickets calculate scoop totals from their servings (the pictured #0043 order
contains six scoops). Names are optional, sanitized, and limited to 80 printable
characters. Blank names resolve once to a stable label such as “Sunny Caramel” for
#0043. The fixed menu permits 1–5 scoops per serving, one container, and optional
toppings. Orders permit up to 30 servings, subject to a 240-line / 2000 mm receipt
limit with space reserved for the reprint warning. PassPRNT keeps its existing
128 KiB encoded-intent limit. Receipts use station-local date/time and require
physical layout and cutting verification on the printer.

## Offline and acceptance

After an online load, the production service worker caches the app shell. Drafts can be recovered while offline, but printer API requests remain live and uncached; printing requires reaching the server. Serve service-worker.js with revalidation.

Automated checks use mocked printer commands/API responses. Complete the [Linux acceptance checklist](docs/linux-printing.md) on the station to verify the updated interaction flow, physical receipt layout, and cutting. Drafts and print-attempt history stay local to one browser/origin. Build orders synchronize through the Linux service; shared reference allocation remains deferred.
