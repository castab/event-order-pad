# Milestone 1 verification

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

Unit checks cover immutable tickets, modifiers/instructions, long notes, URI/HTML escaping, USB parameters, partial cut, disabled retry pop-up, unsupported runtimes, structured callback outcomes, intent before handoff, overlap prevention, callback correlation, immutable final outcomes, storage failures and unknown recovery without resend. The old IV adapter and SDK tests were replaced by IIIU PassPRNT coverage; historical IV attempts remain readable.

Browser checks cover simulation, reload/reprint, offline shell reopening, duplicate acknowledgment, unsupported real mode, missing IndexedDB, interrupted sends, and no horizontal overflow at 1024×768, 768×1024 and 390×844. New checks cover a pending PassPRNT link after saved intent, matching callback completion through an offline cached shell, repeated callback protection and missing-return recovery. The HTTPS test uses Android user-agent metadata and maps static assets to local production output; it does not open PassPRNT or send USB data.

Screenshots of the 390-pixel phone handoff flow and the actual embedded receipt HTML were visually inspected. Browser rendering checks confirm the sample fits the 576-pixel width and is below the HTML length limit. These do not prove Android density, fonts, StarGraphic raster output or physical cutting. Screenshots remain in ignored test-results/.

The first HTTPS callback test failed because its page-only routing omitted service-worker requests. Context-level routing corrected the harness; all nine final tests passed. No application workaround was needed. Earlier foundation checks on 2026-10-09 passed against the assumed IV model; that integration has been superseded.

Physical acceptance is **PARTIAL, OWNER-REPORTED**: the owner reports working PassPRNT printing (with app switching) and a successful CUPS test page/receipt on Mint via direct USB on 2026-10-11. Exact driver/app/firmware versions and output/cut details remain unrecorded. Reprint, hardware errors, interruptions, offline and PWA routing are still unverified. Use [hardware-test.md](hardware-test.md) and [Linux acceptance](linux-printing.md).

Linux unit coverage verifies input validation, installed media/Star option checks, rejection of network/disabled/pending queues, flushed intent before lp, one-copy stdin submission, documented partial-cut options, duplicate ID/content rejection, concurrency locks, persisted unknown recovery without replay, renderer failure before send, and one-page PDF. HTTP checks exercise live noncached status, correlated same-origin submissions, foreign Host/Origin rejection, JSON and size limits and file traversal protection. Commands are stubbed; they do not prove Linux lp/driver operation.

New browser checks confirm Linux selection/readiness, IndexedDB intent before HTTP, staying in the app, recovery, explicit REPRINT with original ID, unavailable service blocking and lost-response ambiguity without automatic retry. The first new test looked up the wrong database name; changing the harness to the actual order-pad-v1 database fixed it. The production preview for tests uses 4175 so it does not interrupt the running Tailscale preview on 4173.

Temporary sample/reprint PDFs from the actual renderer were checked with Poppler and pypdf: one page, embedded font, complete content, clear reference/REPRINT, no clipping or overlap. The Windows visual check used Cascadia Mono; the Mint runtime embeds DejaVu Sans Mono. Target glyph coverage, CUPS rasterization, variable-length trimming and physical cut still need testing. Temporary PDFs/screenshots are ignored in test-results/.

The Linux service has not been started on the owner's Mint machine or sent an application-generated hardware receipt. Its exact queue options and Node runtime are pending owner confirmation. The full order-building workflow remains deferred. GitHub Actions status is separate from these local checks.
