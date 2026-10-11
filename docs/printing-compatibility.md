# Printing compatibility

Updated **2026-10-11**. The owner confirmed **TSP143IIIU / Galaxy S10e / Android 12**, reported working PassPRNT output and later a successful CUPS test receipt on **Mint 22.3 Cinnamon 64-bit**. These replace the specification's IV assumption. Detailed hardware acceptance is incomplete.

## Linux host route

The optional Linux route is now implemented: **phone browser → Mint HTTPS app/service → CUPS → printer USB-B**. [Linux setup and limits](linux-printing.md) document exact launch commands and official CUPS/Star sources. Domain objects and shared layout remain unchanged. The service uses the installed Star driver, not an Android SDK or guessed raw printer commands. App-generated PDF, cut/reprint, error and network-interruption tests are still required. The owner's CUPS test page proves basic output only. Native Android remains deferred; no Order Pad APK exists.

## Selected route

**Static HTTPS app in Android Chrome → Star PassPRNT → phone USB-C host/OTG → printer USB-B.** This original Android route remains available alongside Linux. The ticket domain, simulator and IndexedDB remain printer-neutral. No order builder or custom native app was added.

The [IIIU USB manual](https://www.star-m.jp/products/s_print/tsp100iiiu/manual/en/installing/connectingUSBCable.htm) assigns Android communication to **USB-B** with a suitable device cable/adapter. USB-A only charges Android; USB-B does not charge the phone. Use a USB-C host/OTG adapter plus an A-to-B data cable, or a compatible C-to-B data cable. Exact cable/phone compatibility needs testing. This is different from the former IV AOA route.

[PassPRNT's Android table](https://www.star-m.jp/products/s_print/sdk/passprnt/manual/android/en/functions.html) lists TSP100IIIU USB, firmware 1.0+, empty settings, and Android 9+ for PassPRNT 2.8+. Android 12 meets the OS baseline but does not prove the installed apps, USB permission or cable work. Manual 1.9.0 describes Android app 2.11.0; record the installed version.

The [supported devices PDF, TSP100IIIU table (page 21)](https://star-m.jp/wp-content/uploads/supported_peripheral_devices_en.pdf) marks PassPRNT USB printing supported and webPRNT Browser / StarXpand Web unsupported. The old IV adapter and vendor scripts have been removed; historical `star-usb` attempts remain readable as previous IV attempts.

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

Native SDKs support IIIU USB but require a native app/wrapper and remain deferred. WebUSB, Ethernet, CloudPRNT and the full order builder remain outside this milestone.
