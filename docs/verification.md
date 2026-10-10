# Milestone 1 verification

Date: **2026-10-09**. Environment: Windows desktop, Node **26.9.0**, npm **11.19.1**, Playwright **1.64.0** / headless Chromium **156.0.8078.4**. No Android tablet or physical Star printer was available.

| Check                 | Result                                                                |
| --------------------- | --------------------------------------------------------------------- |
| `npm run check`       | Passed; 0 errors, 0 warnings                                          |
| `npm run lint`        | Passed                                                                |
| `npm test`            | Passed; 29 tests across 3 files                                       |
| `npm run build`       | Passed; static `build/`, manifest/icons, local SDK and service worker |
| `npm run test:e2e`    | Passed; 7 Chromium tests                                              |
| `npm audit`           | 0 vulnerabilities after cookie override                               |
| `git diff --check`    | Passed                                                                |
| Vendor SHA-256 checks | Match the recorded official script downloads                          |

Unit coverage includes immutable ticket validation, quantities/modifiers/instructions, long-note wrapping, optional empty notes, the actual vendor builder's command encoding and final cut, adapter status/timeout/overlap handling, durable intent before send, failed/accepted/unknown outcomes, explicit reprint, storage failures, interrupted-attempt recovery and no silent retry.

Browser checks cover simulated print, saved ticket/history after reload, REPRINT preview, offline production-app reopening, unknown-result confirmation, real mode blocked in an unsupported browser without fallback, absent IndexedDB, interruption before a final result, and no horizontal overflow at **1024×768**, **768×1024** and **390×844**. Full-page screenshots were inspected for readability and layout; generated screenshots remain in ignored `test-results/`.

The first browser run required installing the matching Playwright Chromium runtime. A later interrupted-reload test exposed a misleading pre-save progress label; the session now has separate `saving` and `printing` phases so the UI says intent is saved only after the transaction commits. All final checks passed after that correction. The interruption test deliberately holds the simulator completion timer to avoid timing-dependent CI behavior.

No hardware acceptance is claimed. Android AOA support/USB permission, Star browser discovery and localhost/TLS bridging, physical UTF-8 output/alignment/cutting, hardware error statuses, and offline reopening inside Star webPRNT Browser remain unverified. Use [hardware-test.md](hardware-test.md) to collect device evidence; see [printing-compatibility.md](printing-compatibility.md) for official sources and deferred alternatives.

The checked-in GitHub Actions workflow runs equivalent checks on Linux/Node 24; it has not been run remotely during this task. Production deployment and PWA installation on Android were not performed.
