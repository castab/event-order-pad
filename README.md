# Order Pad — Milestone 1

A static, tablet-friendly SvelteKit/TypeScript application for a **prepaid event preparation ticket**. This milestone contains one fake sample order (#0042), simulated printing, a documented Star USB integration, and durable local print-attempt recovery. It does not contain an order builder or payment workflow.

## Run locally

Use a current Node.js release supported by Vite (Node 22.12+ or 24 recommended) and npm.

```sh
npm ci
npm run dev
```

Open the URL reported by Vite, select **Simulated printer**, and press **Print Test Ticket**. The preview and feedback explicitly identify simulation; no physical ticket is produced. Select a failed or unknown outcome to exercise recovery. Reload to recover the same ticket and history. All later attempts use **Reprint Last Ticket**, preserve its original ID, and include **REPRINT**. Unknown outcomes require checking the output and confirming a deliberate reprint.

The app defaults to simulation on every page load. Real mode is always an intentional selection and never falls back to simulation. Keep one tab open per station: this is a single-tab proof of concept, not a multi-station spooler.

## Checks

```sh
npm run check       # Svelte + TypeScript
npm run lint        # Prettier check
npm test            # Unit tests, no physical printer
npm run build       # Static output in build/
npx playwright install chromium
npm run test:e2e    # Production preview: simulation, reload, reprint, offline, sizing
npm run preview    # Manually inspect the production build
```

`npm run format` formats first-party source. Vendor scripts retain their original bytes. The lockfile pins the installed toolchain. A cookie dependency override removes a low-severity upstream advisory while retaining SvelteKit 2; cookies are not part of this application's workflow.

## Real USB setup

The adapter targets **Star TSP143IV-UE / TSP100IV**, **printer Android USB-A → tablet USB-C (or micro-B)**, **Android Open Accessory (AOA)**, and **Star webPRNT Browser for Android**. It uses the official `StarWebPrintBuilder.js` 1.3.0 and `StarWebPrintTrader.js` 1.2.0, hosted with the app. The JavaScript protocol is Star webPRNT XML through Star's browser bridge at `https://localhost:8001/StarWebPRNT/SendMessage`. No app-owned Node service is needed on the tablet.

1. Build and serve **the contents of `build/` at the root of a static HTTPS origin**, such as a static hosting project. This implementation assumes root hosting (`/`); do not host under a subdirectory without adjusting manifest and service-worker paths.
2. Install the current **Star webPRNT Browser** on the Android tablet and update its WebView/browser engine. Start with Android 9+ and confirm actual compatibility; this is not a promise for every inexpensive tablet.
3. Start the tablet. Connect a **data-capable USB-A → tablet cable to the printer's Android USB-A port** and then turn on the printer. The supplied A-C cable fits a USB-C tablet. This AOA route does not use a tablet-host OTG adapter. The printer USB-C port is documented for PC/Mac/Linux communication and is not the selected route.
4. Allow the USB accessory/device permission when Android prompts. Open Star's browser settings and select the TSP100IV / TSP143IV-UE model and the USB printer. Exact USB selection labels and permission behavior must be verified on the installed browser version; Star's older public setup walkthrough illustrates Bluetooth, so do not pair this UE model as Bluetooth.
5. Set **HOME PAGE** to the deployed HTTPS app URL and open it in Star's browser. The app also offers Star's documented URL-scheme launch link. Ordinary Chrome can use simulation but cannot use this AOA adapter.
6. Select **Star TSP143IV-UE — Android USB-A/AOA**, complete the setup acknowledgment, and press **Print Test Ticket**. Keep the browser in the foreground. Use 80 mm paper for this milestone.
7. Check the actual ticket, order number, modifiers, instructions, end marker and partial cut. Complete [the hardware acceptance checklist](docs/hardware-test.md).

**No physical hardware acceptance has been performed.** The selected route is documented; tablet accessory support, USB permissions, Star's localhost bridge/TLS behavior, text rendering and cutting remain unverified. The app's setup acknowledgment means the operator completed setup, not that the printer is connected.

See [printing compatibility and official sources](docs/printing-compatibility.md) for the USB-role distinction, SDK provenance, limitations, and conflicting LAN documentation.

## Boundaries and reliability

- `src/lib/tickets/`: immutable validated `OrderTicket` / `TicketItem`, illustrative sample data, and pure text layout. No SDK, DOM, transport, prices, or payment data.
- `src/lib/printing/port.ts`: printer-neutral interface, separate print/reprint options, and structured `accepted`, `failed`, and `outcome-unknown` results.
- `src/lib/printing/adapters/`: explicit simulation and one Star USB adapter. Only `star-sdk.ts` loads third-party scripts. The Star adapter owns 80 mm layout width, UTF-8 device text, emphasis, alignment, and the final partial cut.
- `src/lib/printing/session.ts`: saves ticket and intent before calling the port, synchronously locks against repeated taps, records each outcome, blocks on storage failure, and recovers interrupted sends as unknown.
- `src/lib/storage/`: small IndexedDB store. Tickets cannot be changed under the same ID; attempt IDs are added separately and completed only once. No background queue, retries, sync, or exactly-once claims.
- `src/routes/+page.svelte`: mode/setup, preview, deliberate print/reprint actions and attempt history. It consumes the printer port and session, with explicit wiring in `select.ts`.
- `src/service-worker.ts`: versioned application shell, icons and local SDK caching. It never intercepts printer POST requests or cross-origin bridge traffic and does not force an update during a print.

`accepted` in simulation means only that the simulator accepted the request. For real USB, it means Star reported success, not independent verification of readable physical output. A busy rejection is `failed`. Cover/paper/offline errors after sending, transport interruption, missing responses, and page closure before saving the result are conservative `outcome-unknown` results because partial output is possible. Inspect output before a repeat. The SDK does not give a unique permission-denied callback for this bridge, so connection errors include USB permission guidance instead of guessing the cause.

Local data belongs to this browser profile and origin. Chrome, an installed Chrome PWA and Star's browser may use different storage. Clearing site data, changing origin or browser, private browsing, or storage eviction can remove it. Unavailable IndexedDB blocks sends rather than silently losing print intent.

## Offline and deployment

Deploy `build/` as static HTTPS files; no application server processes orders. Allow same-origin static vendor scripts and Star's localhost bridge in any hosting CSP. Do not cache printer responses. Serve `service-worker.js` with revalidation rather than a permanent immutable cache header; hashed application assets may be cached immutably.

After a complete online load, the service worker caches the shell and local assets. Chrome can install the supplied manifest where supported. Updates wait for existing tabs to close so code is not replaced mid-send. The UI reports whether application assets have been cached, not a guarantee of successful offline reopening.

**Offline loading and PWA installation inside Star webPRNT Browser require separate device tests.** If that browser lacks service workers or usable IndexedDB, Chrome PWA results do not establish compatibility. If it cannot reopen the cached app without internet, offline hardware acceptance fails; document that blocker rather than adding a backend or silently changing transport.

## Next step

Smoke-test this USB route on the actual tablet/printer, record the evidence in `docs/hardware-test.md`, and resolve any browser/offline blockers. Once that passes, the smallest next milestone is a minimal touch order-entry screen that creates these same printer-neutral tickets. Network printing and additional printer adapters remain deferred.
