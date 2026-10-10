# Android / TSP143IV-UE hardware acceptance

**Status: NOT RUN. No printer or Android tablet was available during implementation.** Desktop browser and unit tests do not satisfy this checklist.

## Record the device

| Evidence                                             | Actual value |
| ---------------------------------------------------- | ------------ |
| Test date / operator                                 | Not recorded |
| Exact model (must distinguish UE from UEWB) / serial | Not recorded |
| Printer firmware / self-test printout                | Not recorded |
| Paper width (this adapter assumes 80 mm)             | Not recorded |
| Tablet manufacturer/model / Android version          | Not recorded |
| Star webPRNT Browser version / WebView version       | Not recorded |
| Chrome version (comparison only)                     | Not recorded |
| App HTTPS origin / build revision                    | Not recorded |
| Printer port / tablet port / cable type              | Not recorded |
| Android USB permission prompt and response           | Not recorded |
| Actual MODEL / USB printer selection labels          | Not recorded |

## Connect and print

1. Check printer self-test for exact model and firmware; load 80 mm thermal paper. Start the Android tablet and install Star webPRNT Browser.
2. With the printer off, connect **printer Android USB-A → tablet USB-C** using the supplied A-C data cable, or an A-micro-B data cable for a micro-B tablet. Then turn on the printer. Do not substitute a charge-only cable. The selected AOA route does not use a tablet-host OTG adapter; printer USB-C is a different path.
3. Grant Android USB/accessory access. Open Star's browser settings and select TSP100IV / TSP143IV-UE and the attached USB printer. Record actual labels and discovery behavior. If the model/device cannot be selected, stop and record the compatibility blocker; do not treat charging as connection evidence.
4. Serve `build/` at a static **HTTPS** root origin, enter it as HOME PAGE in Star's browser, and open it. A local HTTPS host is acceptable if reachable and its certificate is trusted. Ordinary LAN HTTP and `file://` are not the hardware acceptance route. Verify browser eligibility, IndexedDB availability and setup acknowledgment.
5. Select real USB mode. Press **Print Test Ticket** once. Keep Star's browser in the foreground. Record the app outcome and check the actual ticket: preparation heading, prominent #0042, `2 x` / `1 x`, both illustrative ice-cream items, indented modifiers, special instructions, whole-ticket note, stable ticket ID, end marker and partial cut. Verify no clipping and sensible feed length.
6. Press **Reprint Last Ticket**. Confirm prominent **REPRINT**, unchanged original ticket ID/reference/timestamp, and a separately recorded attempt.
7. Test longer printable notes and any required accented characters using a local test fixture if necessary. Record legibility/font coverage and paper alignment. Do not assume a text preview proves device glyph rendering.

## Error and recovery checks

- **Rapid taps:** repeatedly tap once printing starts; only one request/attempt should be active, controls disabled. No extra physical ticket should appear.
- **USB denied:** deny permission after clearing the relevant permission through Android/Star settings, then try the real mode. Record setup/discovery failure or transport outcome. Allow access and explicitly reprint after inspecting output. The SDK may not identify permission denial separately from a missing device.
- **Disconnected/powered off:** disconnect before the test. Check honest error/unknown feedback and absence of simulated fallback. Reconnect and use a deliberate reprint.
- **Cover open / paper out:** test separately. Expect status-specific guidance when returned. A post-send fault remains unknown because partial output is possible. Resolve the problem, inspect output and explicitly reprint.
- **Mid-send interruption:** where safe, interrupt the cable or foreground application during a test. Do not power-cycle firmware maintenance. Confirm unknown outcome, no automatic retry, and a visible duplicate warning. A deliberate repeat must include REPRINT.
- **Close/reload during send:** reopen the same origin in the same browser. An unfinished saved attempt becomes unknown. Original ticket and all previous attempts must remain. No automatic send occurs on reopen.
- **Ordinary reload:** confirm accepted/failed/unknown history and stable ticket ID survive. Confirm real mode requires intentional selection again. Keep one tab per station.

## Offline acceptance — test browsers separately

1. Load the production app online and wait for the cache indication. Close/reopen once online; verify recovery. Install as a PWA if that browser offers installation.
2. Disable internet access on the tablet while leaving USB attached. Fully close and reopen the app in **Star webPRNT Browser** at the same HTTPS URL, not just an already displayed page. Confirm UI/assets/local SDK load, IndexedDB ticket recovery, and a deliberate real reprint.
3. Repeat with device reboot if practical. Record whether cached offline navigation, service workers and persistence survive.
4. Separately run the simulator offline in Chrome / Chrome's installed PWA. This does not prove AOA printing in Chrome or offline support in Star's browser. Note separate browser storage and any differences.
5. If Star's browser cannot reopen offline, mark **offline hardware acceptance failed** and record its browser/WebView version and symptoms. Keep simulation functional; do not claim event readiness based on the Chrome result.

## Outcome

| Acceptance area                                           | Result / evidence                              |
| --------------------------------------------------------- | ---------------------------------------------- |
| USB-A/AOA discovery and permission                        | Not tested                                     |
| Physical ticket content, glyphs and partial cut           | Not tested                                     |
| Explicit reprint / stable ID                              | Not tested                                     |
| Disconnect, denied permission, cover, paper, interruption | Not tested                                     |
| Reload recovery / no automatic resend                     | Not tested on device                           |
| Star browser offline reopen and USB printing              | Not tested                                     |
| Chrome offline simulator comparison                       | Desktop automated checks only; no Android test |

When all device smoke tests pass, proceed to the smallest order-entry milestone using the existing domain/port. Resolve compatibility/offline blockers first. See [printing-compatibility.md](printing-compatibility.md) for official references and the deferred network-printing documentation conflict.
