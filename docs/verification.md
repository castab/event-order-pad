# Order Pad verification

## Mixed flavors and scoop counts — 2026-10-11

Each serving now has a list of flavors with positive integer scoop counts, capped at **5 scoops total per cup or cone**. Touch-sized +/− controls start at zero, show each flavor’s count and the shared total, disable additions at five, and remove a flavor when its count reaches zero. Container and toppings apply to the whole serving. Printing still includes the complete current serving or edit automatically.

New tickets keep one item per serving (`quantity: 1`), with a heading such as **Ice cream (3 scoops)** and separate modifier lines for **2 scoops Chocolate Chip**, **1 scoop Strawberry**, the container, and toppings. The existing ticket API and receipt renderers need no schema change. Saved single-flavor drafts convert to one-scoop portions during recovery; submitted tickets remain unchanged for deliberate reprinting. No IndexedDB version bump or data clearing is needed.

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

## Milestone 2 — order builder (2026-10-11)

Implemented explicit flavor/container selection, any combination of six toppings, separately configured servings with add/edit/remove, optional names and stable two-word fallback labels. New orders and their first intents commit atomically; serialized draft writes restore unfinished editor selections independently from the latest submitted receipt. Reprints preserve the original ticket while a new draft is being built. Existing IndexedDB version/records and both real printer routes are retained.

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

## Milestone 1 — historical transport checks

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

The Linux service is now running on the owner's Mint machine with Node 24.21.0 and the verified `Star_TSP143` USB queue. The installed PPD exposes `0Variable`, `0NoCutPage`, `1PartialCutDoc`; selecting these advertised values fixed the initial driver mismatch. Prepared jobs carry their selected options independently of concurrent readiness checks. Type checks, 53 unit/HTTP tests, formatting and both production builds passed on Mint. Live Tailscale HTTPS app loading and printer readiness passed, CUPS `abort-job` policy was confirmed, and the first phone-to-printer smoke test succeeded as described above. See [verified Mint setup](linux-printing.md) for the origin, driver, journal IDs and foreground launcher. Boot startup has not been configured. At that transport milestone, the full order-building workflow was deferred; Milestone 2 above implements it. GitHub Actions status is separate from these local checks.
