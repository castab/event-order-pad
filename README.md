# Order Pad — Milestone 1

A static SvelteKit/TypeScript preparation-ticket proof of concept: one fake sample (#0042), simulation, a documented USB route and durable local recovery. No order builder or payment workflow.

The actual target is **Star TSP143IIIU / TSP100IIIU**, tested next with **Galaxy S10e, Android 12**. These owner-confirmed details replace the original specification's IV assumption. Real printing now uses **Star PassPRNT and printer USB-B**; the IV USB-A/AOA/webPRNT adapter was removed.

## Run and check

Use Node 22.12+ or 24 and npm.

```sh
npm ci
npm run dev
```

Select Simulated printer and Print Test Ticket. Choose failed/unknown scenarios to exercise recovery. Reload recovers the same ticket/history. Later attempts use Reprint Last Ticket, preserve its ID and include REPRINT. Unknown outcomes require checking output and confirming a deliberate repeat.

```sh
npm run check
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run preview
```

The lockfile pins dependencies; the cookie override resolves an upstream SvelteKit 2 advisory. CI runs equivalent checks on Node 24. Browser checks are desktop Chromium, not Android hardware acceptance.

## Real USB setup

1. Install Star Quick Setup Utility and Star PassPRNT on the S10e. Android 12 meets the documented Android 9+ baseline. Update Chrome/WebView; test ordinary Chrome as the default HTTPS browser first.
2. Connect **phone USB-C host/OTG → printer USB-B** using an adapter/data cable or compatible C-to-B data cable. Power the printer from mains; USB-B does not charge the phone. Printer USB-A only charges Android. Keep one USB printer connected.
3. Grant each Star app USB permission. Prove a Quick Setup Utility sample print, then configure IIIU / USB in PassPRNT.
4. Serve the contents of **build/** at a static HTTPS root origin and open in Chrome. Subdirectory hosting requires manifest/service-worker changes. Select **Star TSP143IIIU — USB-B / PassPRNT** and acknowledge setup.
5. Print Test Ticket saves intent and prepares the request. A separate **Open PassPRNT and print** tap provides a fresh user gesture after storage commits. Self-contained HTML is rasterized by PassPRNT; partial cut is requested, retry pop-ups and peripherals are disabled.
6. Keep PassPRNT in the foreground until its callback returns. If a new tab opens, close the original pending tab and retain one station tab. Different browsers/profiles cannot recover the originating IndexedDB data.
7. If launch/return fails, close PassPRNT and inspect output, then Recover without resending. The attempt becomes unknown; no automatic retry occurs.

**Physical acceptance has not been performed.** Setup acknowledgment and preparing/opening a link do not prove connection or printing. Complete [hardware acceptance](docs/hardware-test.md); [compatibility notes](docs/printing-compatibility.md) contain official sources.

## Boundaries and reliability

- `src/lib/tickets/`: immutable tickets and pure layout; no SDK, DOM, prices or transport.
- `src/lib/printing/port.ts`: printer-neutral port, attempt IDs, handoff and accepted/failed/unknown results.
- `src/lib/printing/adapters/`: explicit simulator and PassPRNT protocol/HTML adapter; no remote receipt assets or vendor downloads.
- `src/lib/printing/session.ts`: saves intent first, locks repeated taps, correlates callbacks, completes attempts once and recovers interruptions as unknown.
- `src/lib/storage/`: IndexedDB; immutable tickets/separate attempts; unavailable storage blocks sends.
- `src/routes/+page.svelte`: setup, preview, deliberate actions and history, wired through the adapter selector.
- `src/service-worker.ts`: versioned same-origin shell caching; no USB send/result caching or forced mid-job updates.

Accepted means the simulator or PassPRNT reported success, not physical verification. Pre-send rejection is failed; partial/interrupted/missing results are unknown. Late/repeated callbacks cannot rewrite a final outcome. URL callbacks are correlated external reports, not authenticated physical proof. Historical IV attempts stay readable.

Every reload defaults to simulation; real mode never falls back. Keep one station tab. There is no queue, cloud backup or exactly-once guarantee. Browser cleanup, origin/profile changes and eviction can remove local data.

## Offline and next step

After an online load, the production service worker caches the shell and supports callback query navigation offline. PassPRNT receives embedded HTML, avoiding receipt downloads. Serve service-worker.js with revalidation.

**S10e offline reopening, USB permission, launch/return, raster output and cutting still require device tests.** Test an installed PWA separately from a Chrome tab. Record failures as blockers before event use.

Keep the full order workflow deferred. After hardware acceptance, the next milestone can add minimal touch order entry using the existing domain/port. See [verification](docs/verification.md).
