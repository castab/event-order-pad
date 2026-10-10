# Printing compatibility

Investigation date: **2026-10-09**. Hardware tested: **none**. Repository initially contained only `.git` and `.gitattributes`; no existing app/tooling or `AGENTS.md` was found.

## Selected USB strategy

**Android tablet + TSP143IV-UE + printer Android USB-A + AOA + Star webPRNT Browser for Android + Star webPRNT JavaScript SDK.** The application remains ordinary static HTTPS web content; all Star/browser details sit behind `TicketPrinter`. Hosting serves assets and updates; it never handles orders or USB.

Star's [TSP143IV product page](https://starmicronics.com/product/tsp143iv-thermal-receipt-printer/) explicitly identifies Android Open Accessory support for the UE models.

The [TSP100IV specifications](https://star-m.jp/eng/products/s_print/tsp100iv/index.html) document USB-A for Android and charging (up to 1.5 A), USB-C for PC/Mac, Ethernet, StarPRNT emulation, and partial cut. The [USB installation manual](https://www.star-m.jp/products/s_print/oml/tsp100iv/manual/en/installing/connectingUSBCable.htm) directs Android to the USB-A port and describes the supplied A-C cable. Start Android, attach cable, then power on the printer. An A-micro-B data cable is needed for older tablet connectors. Validate the actual cable/device combination. AOA makes the printer the USB host/accessory counterpart; a tablet-host OTG configuration is a different route.

The [webPRNT interface table](https://star-m.jp/products/s_print/sdk/webprnt/manual/en/_interfaceTable.htm) specifically supports TSP143IV-UE USB through **Android** webPRNT Browser. This UE model is not the Bluetooth/Wi-Fi UEWB variant. The documented Android USB-A requirements in the [native StarPRNT getting-started manual](https://star-m.jp/products/s_print/sdk/starprnt_sdk/manual/android_java/en/getting_start.html) say Android 9+ and one connected device. Treat that as a device-selection baseline, not a guarantee for webPRNT Browser or arbitrary Android hardware.

**Documented support:** printer Android USB-A communication and webPRNT Browser USB compatibility. **Reasonable inference:** that combination is the most defensible first AOA route for this web app. **Unverified:** the unspecified tablet's accessory support, browser version, exact printer selection screens, permissions and physical printing.

## SDK and API used

The [webPRNT SDK manual](https://www.star-m.jp/products/s_print/sdk/webprnt/manual/en/_sampleProgram.htm) describes serving JavaScript libraries with the web application, identifies the browser user-agent marker `StarWebPRNTBrowser/X.X.X`, and documents the Android HTTPS bridge endpoint. This adapter uses `https://localhost:8001/StarWebPRNT/SendMessage`; localhost is Star's browser integration, not an app-owned service.

Unmodified vendor scripts are committed under `static/vendor/star-webprnt/`:

| File                   | Header version | SHA-256                                                            |
| ---------------------- | -------------- | ------------------------------------------------------------------ |
| StarWebPrintBuilder.js | 1.3.0          | `59de0a6bd803a91fadf6516fe76b66ebdf1892747036ac08b33ece8f08ffe708` |
| StarWebPrintTrader.js  | 1.2.0          | `d025e0afb782f4c7c738082656ec1b3129c76d4ea89d320fe30f3a391b66f544` |

Source URLs and copyright provenance are recorded in [the vendor README](../static/vendor/star-webprnt/README.md). They are fetched from Star's published official sample, with their original copyright headers retained; no CDN fetch is required at runtime. Header versions identify the actual files, not a claim about the newest downloadable SDK package.

Documented [Builder APIs](https://star-m.jp/products/s_print/sdk/webprnt/manual/en/_StarWebPrintBuilder-js.htm): initialization, alignment, UTF-8 Font A text with explicit emphasis/magnification, and `createCutPaperElement({feed: true, type: 'partial'})`. Layout assumes 80 mm paper and conservatively wraps body text at 42 columns. Font coverage, real usable width, long-note output and cut/feed need device verification; 58 mm paper is deferred.

Documented [Trader APIs](https://star-m.jp/products/s_print/sdk/webprnt/manual/en/_StarWebPrintTrader-js.htm): constructor, `sendMessage`, `onReceive`, `onError`, and cover/paper/offline/cutter status helpers. The adapter accepts both Boolean and string success values because the vendor JavaScript returns strings. Code 0 plus success becomes `accepted`; 2001 is an explicit busy failure. Code 1100 is classified using status helpers but remains unknown after send because partial output is possible. Other unexpected responses, communication errors and missing callbacks remain unknown. A 17-second adapter guard complements the SDK's 15-second transport timeout. No automatic resend is performed.

There is no distinct documented USB-permission callback in this JavaScript bridge. Permission denial and a disconnected bridge may look alike; the UI reports the communication problem, prompts checking Android USB access and keeps uncertainty. Status before a send is not claimed. Browser eligibility and operator setup acknowledgment do not establish a live connection.

## Runtime, permissions and offline checklist

- Use Android with AOA support, starting with 9+; install current Star webPRNT Browser and update WebView. The compiled app targets ES2020 and uses IndexedDB and secure-context browser APIs; ancient/unmaintained browser engines are not an accepted target.
- Use the printer's **Android USB-A**, a data-capable cable to the tablet, 80 mm thermal paper and printer mains power. Tablet charging availability does not prove accessory communication or sustained battery charging.
- Grant USB/accessory access through Android/Star's browser. Choose TSP100IV / TSP143IV-UE and the attached USB printer in Star browser settings. Exact USB menu labels are a device-validation item; the [public Android browser walkthrough](https://star-m.jp/products/s_print/sdk_webprnt/sample/howto_en_Android.html) documents HOME PAGE/MODEL/SELECTED PRINTER using Bluetooth examples, not this exact USB screen.
- Set HOME PAGE to the app's static HTTPS URL. The launch link uses Star's documented URL scheme. Select real mode and acknowledge setup explicitly. There is no background chooser or auto-connect.
- The vendor trader has compatibility handling for old browsers without its HTTPS capability marker. TLS/bridge behavior must be checked on the actual version; do not downgrade the app to HTTP or disable certificate validation to hide a failure.
- Same-origin local SDK scripts and shell assets are cached with the production service worker. Printer POSTs are never cached. Browser profile/origin changes do not carry IndexedDB tickets with them.
- Service workers, installation and offline reopening inside Star's browser are **unverified**. An offline Chrome simulator test proves only that runtime. Keep the app in the foreground during send, as [Star's browser precautions](https://www.star-m.jp/products/s_print/sdk/webprnt/manual/en/_infoToUse.htm) require. Repeated taps are guarded in UI and session code.

Run the sample, inspect the physical ticket/cut, try an explicit reprint, exercise errors, reload, and reopen without internet. Use the evidence fields in [hardware-test.md](hardware-test.md). If offline loading fails inside Star's browser, record a blocker rather than declaring offline USB readiness.

## Alternatives deferred

**StarXpand SDK for Web / `star-io10-web`:** [manual version 1.0.1, updated 2026-09-15](https://star-m.jp/products/s_print/sdk/starxpand-for-web/manual/en/index.html) lists this printer and Android Chrome USB, but explicitly excludes AOA and requires Printer class. Its [official source README](https://github.com/star-micronics/star-io10-web) lists its sample's tested Android 16 / Chrome 144 environment. That is not broad compatibility assurance for older tablets. A tablet in USB host mode connecting to the printer's USB-C device interface might be a hardware spike, with a suitable host/OTG cable and WebUSB permission, but the model's hardware instructions assign USB-C to PCs. This route is **not** implemented or claimed usable on the owned Android USB-A configuration.

**Ethernet / direct webPRNT:** The [TSP100IV online hardware manual](https://star-m.jp/products/s_print/oml/tsp100iv/manual/en/convenientFunctions/settingsWebPRNT.htm) describes direct browser webPRNT and printer/browser TLS certificate setup. However, the SDK interface table linked above marks the exact TSP143IV-UE LAN column unsupported. This is an official-documentation conflict. Direct network webPRNT is a plausible future adapter; verify firmware/endpoint and clarify with Star before implementing it. A local print service is **not inherently required** for supported direct-webPRNT printers. No network adapter is included in this milestone.

**Native Android SDK / backend / cloud printing:** deferred because this milestone requires static web content and one documented browser USB adapter. No new native app, app-owned service, CloudPRNT, or speculative hardware framework has been introduced.
