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

Choose a flavor and container, then select any toppings. Flavor and container have no defaults. For a single serving, tap **Print order** directly; it includes the serving currently being configured. For multiple servings, use **Add serving** for each earlier serving, then print the last one directly. Editing a serving and pressing Print saves that replacement without duplicating it. **Save serving**, **Remove**, and **Cancel serving** remain available.

The menu is:

- Flavors: Chocolate, Vanilla, Strawberry, Chocolate Chip.
- Containers: Cup, Cake Cone, Sugar Cone.
- Toppings: Whipped cream, Gummy Bears, Caramel Sauce, Chocolate Sauce, Sliced Almonds, Maraschino Cherries.

Enter an optional name (up to 80 printable characters). Blank names use a stable two-word ice cream label such as **Sundae Sprinkle**. Each serving has its own preparation block, including **No toppings** when appropriate. Orders support up to 30 servings, subject to receipt-length limits. Incomplete selections must be completed or canceled before printing.

The **Order** tab contains the builder, summary, and always-visible print action. Receipt previews and print attempts are collapsed by default. The **Printer settings** tab shows the server’s configured USB queue, live readiness checks, and setup instructions. Switching tabs preserves the order. Readiness is checked automatically on startup; no recurring setup acknowledgment is required. A static-only host cannot print.

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
- `src/lib/storage/`: IndexedDB; independent drafts, immutable tickets/separate attempts and atomic first-order intent; unavailable storage blocks sends. Existing database version and records are preserved.
- `src/routes/+page.svelte`: Order and Printer settings tabs, serving editor, summary, collapsed receipts/attempts, and direct USB submissions/reprints.
- `src/service-worker.ts`: versioned same-origin shell caching; no USB send/result caching or forced mid-job updates.

In the current UI, accepted means CUPS accepted a queue submission, not physical verification. Historical simulator/PassPRNT results remain readable. Pre-send rejection is failed; partial/interrupted/missing results are unknown. Late/repeated callbacks cannot rewrite a final outcome. URL callbacks are correlated external reports, not authenticated physical proof. Historical IV attempts stay readable.

Every new submission and reprint uses the server USB route; there is no transport fallback. Keep one station tab. There is no application background queue, cloud backup or exactly-once guarantee. Linux uses the existing CUPS spooler; inspect pending jobs before reprinting. Browser cleanup, origin/profile changes and eviction can remove local data.

## Offline and acceptance

After an online load, the production service worker caches the app shell. Drafts can be recovered while offline, but printer API requests remain live and uncached; printing requires reaching the server. Serve service-worker.js with revalidation.

Automated checks use mocked printer commands/API responses. Complete the [Linux acceptance checklist](docs/linux-printing.md) on the station to verify the updated interaction flow, physical receipt layout, and cutting. Drafts and history are local to one browser/origin; shared history and cross-device synchronization remain deferred.
