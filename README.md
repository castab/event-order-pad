# Order Pad

A touch-friendly SvelteKit/TypeScript ice cream order builder with preparation receipts, simulation, USB printing and durable local recovery. Orders contain separately configured servings; there are no prices or payments.

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
- Toppings: Whipped cream, Gummy Bears, Caramel Sauce, Chocolate Sauce, Sliced Almonds, Maraschino Cherries.

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

The builder shows customer name, saved servings, and the current serving, with an always-visible print action. **Order tools** contains printer settings, receipt previews, print attempts, and New order. Opening or closing these tools preserves the draft. Accepted prints reset the builder and show a six-second toast; failed or unknown outcomes keep the order saved with visible recovery actions. Unknown outcomes require inspecting the printer before continuing. The header reprints the last order without changing its identity or an independent draft. The current app icon temporarily stands in for the supplied brand logo; Poppins fonts are hosted locally for offline use. Readiness is checked automatically on startup; no recurring setup acknowledgment is required. A static-only host cannot print.

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
- `src/service-worker.ts`: versioned same-origin shell caching; no USB send/result caching or forced mid-job updates.

In the current UI, accepted means CUPS accepted a queue submission, not physical verification. The attempt model still supports simulator/PassPRNT results. Pre-send rejection is failed; partial/interrupted/missing results are unknown. Late/repeated callbacks cannot rewrite a final outcome. URL callbacks are correlated external reports, not authenticated physical proof. It also retains the IV adapter identifier; v1 browser history receives the one-time reset below.

Every new submission and reprint uses the server USB route; there is no transport fallback. Keep one station tab. There is no application background queue, cloud backup or exactly-once guarantee. Linux uses the existing CUPS spooler; inspect pending jobs before reprinting. Browser cleanup, origin/profile changes and eviction can remove local data.

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
orders can leave gaps. Keep one station tab; shared allocation across phones is
deferred to the shared-store phase.

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

Automated checks use mocked printer commands/API responses. Complete the [Linux acceptance checklist](docs/linux-printing.md) on the station to verify the updated interaction flow, physical receipt layout, and cutting. Drafts and history are local to one browser/origin; shared history and cross-device synchronization remain deferred.
