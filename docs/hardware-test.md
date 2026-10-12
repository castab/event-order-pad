# Galaxy S10e / TSP143IIIU hardware acceptance

**Status: PARTIAL, OWNER-REPORTED.** The owner reports PassPRNT output and, on 2026-10-11, a successful CUPS test page/receipt on Mint 22.3 Cinnamon 64-bit with direct USB. Exact driver version, output/cut details, reprint, error and offline checks remain unrecorded. The implementation agent has no physical printer access.

For Linux app printing, follow [Linux setup and acceptance](linux-printing.md). Its application-generated receipt has not yet been hardware-tested. The Android checklist below remains applicable to PassPRNT.

## Device evidence

| Evidence                                 | Actual value                               |
| ---------------------------------------- | ------------------------------------------ |
| Printer label                            | TSP143IIIU (owner confirmed)               |
| Phone / Android                          | Galaxy S10e / Android 12 (owner confirmed) |
| Test date / operator                     | Not recorded                               |
| Printer serial / firmware / self-test    | Not recorded                               |
| Paper width                              | Adapter assumes 80 mm; verify              |
| PassPRNT / Quick Setup Utility versions  | Not recorded                               |
| Chrome / WebView versions                | Not recorded                               |
| App HTTPS origin / Git revision          | Not recorded                               |
| USB-C host adapter / USB-B data cable    | Not recorded                               |
| USB permission / selected printer labels | Not recorded                               |
| Default HTTPS browser / callback tabs    | Not recorded                               |

## First print

1. Load 80 mm paper, inspect the printer self-test and install current **Star Quick Setup Utility** and **Star PassPRNT**. Update Chrome/WebView. Use ordinary Chrome and set Chrome as the default HTTPS browser for the first test.
2. Power the printer from mains. Connect **S10e USB-C → host/OTG adapter → A-to-B data cable → printer USB-B**, or use a compatible C-to-B data cable. Keep only one USB printer connected. Printer USB-A only charges Android; USB-B does not charge the phone. Record the cable that actually works.
3. Grant Quick Setup Utility USB access and print its sample. Configure TSP100IIIU / USB in PassPRNT and grant its own USB permission. Record actual labels/versions. If either app cannot discover/print, record a blocker.
4. Serve `build/` at a static HTTPS root origin. Open in Chrome; confirm local storage and cache indication. Select **Star TSP143IIIU — USB-B / PassPRNT** and acknowledge setup.
5. Build an order (add each serving, with optional name) and press **Print order** once. Confirm saved intent appears before the launch link. Tap **Open PassPRNT and print** once. Keep PassPRNT in the foreground until it returns. Link disappearance is not printing evidence.
6. Record the callback code, browser and tab routing. Matching success should yield one accepted saved attempt. If another tab opens, close the original pending tab. A different browser/profile or missing attempt ID is a compatibility blocker.
7. Inspect the name or two-word label, each serving and its container/toppings, stable ID, end marker and partial cut/feed. Check clipping, raster legibility and excessive wrapping.
8. Explicitly reprint using the new launch link. Confirm prominent REPRINT, original ID/reference/timestamp and separate attempt. Test long customer names, mixed flavors, all toppings, and required accented characters with a local fixture.

## Error and recovery checks

- Rapid taps: one attempt/link; launch link disappears after tapping. No extra ticket.
- Denied permission / disconnected / power off: record actual code and feedback; no simulated fallback or guessed unique permission diagnosis.
- Cover / paper: test before send and during print. Retry pop-up disabled. Pre-send code 5 is failed; end-check code 7 is unknown. Inspect output before a deliberate repeat.
- Missing launch/return: close PassPRNT and inspect output, then **Recover without resending**. One saved attempt becomes unknown; reprint requires duplicate acknowledgment.
- Mid-send cancellation/disconnection: check unknown outcome and no automatic retry. Never interrupt firmware maintenance. Close active PassPRNT jobs before another attempt.
- Late/repeated callback: final outcome must stay unchanged. Late success after unknown recovery remains unknown.
- Reload: same ticket/history, simulation default, intentional real-mode selection. The attempt model still supports the IV identifier; phase 1 resets v1 browser history once (see README).

## Offline acceptance

1. Load production online, wait for cache indication and verify recovery after reopening.
2. Leave USB attached, disable internet and fully close/reopen the same HTTPS origin in Chrome. Verify assets and local records.
3. Deliberately reprint through PassPRNT offline. Verify embedded HTML renders without download, callback reaches cached Chrome content and physical ticket/cut matches the saved result.
4. Repeat after reboot if practical; record cache and USB permission persistence.
5. Test an installed Chrome PWA separately, especially callback routing. A regular-tab result does not prove standalone behavior.
6. If offline launch/return/reopening fails, mark hardware offline acceptance failed with versions/symptoms.

| Acceptance area                        | Result                                               |
| -------------------------------------- | ---------------------------------------------------- |
| USB-B host connection / permission     | Basic output reported; permission details unrecorded |
| Utility / PassPRNT sample print        | PassPRNT output reported; utility test unrecorded    |
| App launch / callback / tab routing    | Not tested on device                                 |
| Physical ticket / glyphs / partial cut | Not tested                                           |
| Reprint / stable ID                    | Not tested on device                                 |
| Hardware errors / interruption         | Not tested                                           |
| Chrome offline reopen / return         | Not tested on device                                 |
| Installed PWA offline return           | Not tested                                           |

The order builder is implemented; complete the new-receipt acceptance checks before event use. See [printing-compatibility.md](printing-compatibility.md) for official sources.
