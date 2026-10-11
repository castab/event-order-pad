# Milestone 1 verification

Updated **2026-10-10** for the owner-confirmed **TSP143IIIU / Galaxy S10e / Android 12** target. Local environment: Windows, Node 26.9.0, npm 11.19.1, Playwright 1.64.0 / Chromium 156.0.8078.4. The implementation agent has not tested physical hardware.

| Check            | Result                                                |
| ---------------- | ----------------------------------------------------- |
| npm run check    | Passed; 0 errors, 0 warnings                          |
| npm run lint     | Passed                                                |
| npm test         | Passed; 38 tests across 3 files                       |
| npm run build    | Passed; static app, manifest/icons and service worker |
| npm run test:e2e | Passed; 9 Chromium tests                              |
| npm audit        | 0 vulnerabilities                                     |
| git diff --check | Passed                                                |

Unit checks cover immutable tickets, modifiers/instructions, long notes, URI/HTML escaping, USB parameters, partial cut, disabled retry pop-up, unsupported runtimes, structured callback outcomes, intent before handoff, overlap prevention, callback correlation, immutable final outcomes, storage failures and unknown recovery without resend. The old IV adapter and SDK tests were replaced by IIIU PassPRNT coverage; historical IV attempts remain readable.

Browser checks cover simulation, reload/reprint, offline shell reopening, duplicate acknowledgment, unsupported real mode, missing IndexedDB, interrupted sends, and no horizontal overflow at 1024×768, 768×1024 and 390×844. New checks cover a pending PassPRNT link after saved intent, matching callback completion through an offline cached shell, repeated callback protection and missing-return recovery. The HTTPS test uses Android user-agent metadata and maps static assets to local production output; it does not open PassPRNT or send USB data.

Screenshots of the 390-pixel phone handoff flow and the actual embedded receipt HTML were visually inspected. Browser rendering checks confirm the sample fits the 576-pixel width and is below the HTML length limit. These do not prove Android density, fonts, StarGraphic raster output or physical cutting. Screenshots remain in ignored test-results/.

The first HTTPS callback test failed because its page-only routing omitted service-worker requests. Context-level routing corrected the harness; all nine final tests passed. No application workaround was needed. Earlier foundation checks on 2026-10-09 passed against the assumed IV model; that integration has been superseded.

Physical acceptance remains **NOT RUN**: S10e USB-B host connection/cable, USB permission, utility and PassPRNT sample print, external launch, callback browser/tab behavior, hardware errors, legibility/cut, offline launch/return and installed PWA routing. The owner supplied the model and OS, not test outcomes. Use [hardware-test.md](hardware-test.md) to collect evidence and [printing-compatibility.md](printing-compatibility.md) for verified official documentation.

GitHub Actions has not been run remotely. No deployment or phone PWA installation was performed. The full order-building workflow remains deferred.
