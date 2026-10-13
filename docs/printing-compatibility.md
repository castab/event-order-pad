# Printing compatibility

Updated **2026-10-11**. The owner confirmed **TSP143IIIU / Galaxy S10e / Android 12**, reported working PassPRNT output and later a successful CUPS test receipt on **Mint 22.3 Cinnamon 64-bit**. These replace the specification's IV assumption. Detailed hardware acceptance is incomplete.

> **Current route: Linux only.** Since the USB-only ordering UX (2026-10-11), the ordering interface prints exclusively through the Linux service. The Android PassPRNT route described below is **not selectable in the app**; its adapter (`src/lib/printing/adapters/passprnt.ts`) is kept for unit tests and as reference if the route is restored. Read this page for background and official Star sources, and [linux-printing.md](linux-printing.md) for the live setup.

## Linux host route

The Linux route is implemented and is the only route the UI uses: **phone browser → Mint HTTPS app/service → CUPS → printer USB-B**. [Linux setup and limits](linux-printing.md) document exact launch commands and official CUPS/Star sources. Domain objects and shared layout remain printer-neutral. The service uses the installed Star driver, not an Android SDK or guessed raw printer commands. The first app-generated receipt printed and cut correctly on 2026-10-11; detailed layout, REPRINT, error and network-interruption tests are still required. Native Android remains deferred; no Order Pad APK exists.

## Android PassPRNT route (historical)

**Static HTTPS app in Android Chrome → Star PassPRNT → phone USB-C host/OTG → printer USB-B.** This was the original route and is no longer reachable from the ordering UI (see the note above). The ticket domain and simulator remain printer-neutral. (This route stored history in browser IndexedDB; the current app uses Postgres.) No custom native app was added.

The [IIIU USB manual](https://www.star-m.jp/products/s_print/tsp100iiiu/manual/en/installing/connectingUSBCable.htm) assigns Android communication to **USB-B** with a suitable device cable/adapter. USB-A only charges Android; USB-B does not charge the phone. Use a USB-C host/OTG adapter plus an A-to-B data cable, or a compatible C-to-B data cable. Exact cable/phone compatibility needs testing. This is different from the former IV AOA route.

[PassPRNT's Android table](https://www.star-m.jp/products/s_print/sdk/passprnt/manual/android/en/functions.html) lists TSP100IIIU USB, firmware 1.0+, empty settings, and Android 9+ for PassPRNT 2.8+. Android 12 meets the OS baseline but does not prove the installed apps, USB permission or cable work. Manual 1.9.0 describes Android app 2.11.0; record the installed version.

The [supported devices PDF, TSP100IIIU table (page 21)](https://star-m.jp/wp-content/uploads/supported_peripheral_devices_en.pdf) marks PassPRNT USB printing supported and webPRNT Browser / StarXpand Web unsupported. The old IV adapter and vendor scripts have been removed; the attempt model retains the `star-usb` identifier for IV compatibility. Old v1 browser tickets and attempts are left untouched as archives and are never imported (see README, “Upgrading a station with old browser data”).

## Implemented protocol

The [official specification](https://www.star-m.jp/products/s_print/sdk/passprnt/manual/android/en/data_specifications.html) includes a JavaScript link example. This adapter implements its URL scheme directly; no vendor script is required.

| Parameter               | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| Scheme/path             | `starpassprnt://v1/print/nopreview`                    |
| port / settings         | `usb:` / empty; keep exactly one USB printer connected |
| size                    | 576 dots for this 80 mm layout                         |
| html                    | Escaped, self-contained UTF-8 HTML; no remote assets   |
| cut / popup             | `partial` / `disable`                                  |
| drawer / buzzer / sound | `off`                                                  |
| back                    | Same HTTPS origin/path with saved attempt ID           |

PassPRNT rasterizes HTML for the printer command system. The [native SDK table](https://star-m.jp/products/s_print/sdk/starprnt_sdk/manual/android_java/en/getting_start.html) identifies IIIU as **StarGraphic**; IV device-text commands must not be reused. The adapter limits receipts to 240 formatted lines and 128 KiB encoded intent data. Device density, browser URL limits, glyph coverage and actual length remain test items.

Intent commits before link creation. A separate launch tap supplies a fresh user gesture. The link disappears after tapping; controls remain locked. Preparing or opening a link never counts as success. Recover without resending reloads and records unknown; close PassPRNT and inspect output first. Retry pop-ups are disabled.

A callback's `passprnt_code` completes only a matching unfinished saved attempt in PassPRNT mode. Code 0 is accepted. Pre-send rejection/preparation errors are failed; interrupted, unknown, malformed or missing results stay unknown. Codes 4/5 provide connection/cover/paper guidance without inventing a unique USB-permission error. Final results cannot be overwritten by late/repeated callbacks. Arbitrary callback messages are not rendered. URL callbacks are external reports, not authenticated physical proof.

A callback can reopen another tab or bypass a standalone PWA. Use Chrome as the default HTTPS browser and test an ordinary Chrome tab first. If another tab opens, close the original pending tab and keep one station tab. A different browser/profile/origin cannot access the originating IndexedDB data. Lost correlation or manual reopening before callback becomes unknown.

## Verification boundary

[Quick Setup Utility](https://www.star-m.jp/products/s_print/tsp100iiiu/manual/en/settings/usingApp.htm) supports Android 9+ and IIIU sample printing/setup. Prove its sample print first and grant USB permission separately to each Star app.

The shell and callback navigation can load from production cache. Layout is embedded. The owner reports PassPRNT printing works and notes the app-switching requirement. Exact versions, callback correlation, offline return, output details and cutting still need a recorded test. Installed-PWA routing must be checked separately. Use [hardware-test.md](hardware-test.md).

Native SDKs support IIIU USB but require a native app/wrapper and remain deferred. WebUSB, Ethernet and CloudPRNT were not pursued. (The order builder, originally out of scope here, has since been implemented; see [README](../README.md).)
