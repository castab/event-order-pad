# Linux USB printing

Target: **TSP143IIIU**, USB-B to Intel/AMD Mint **22.3 Cinnamon 64-bit**. On 2026-10-11 the owner reported a successful CUPS test page/receipt. Installed driver version, cutter behavior and application-generated output still need confirmation. Mint shares Ubuntu 24.04's base; Star lists Ubuntu 24.04 64-bit, not Mint explicitly. Compatibility is an inference supported by the owner's test, not certification.

The service hosts the static app and accepts same-origin print requests. The phone remains a browser client; this mode uses neither phone USB nor PassPRNT. Keep one station/tab. The order builder remains deferred. This Linux route follows the owner's move to a separate USB host after Android PassPRNT testing.

## Start on Mint

Prerequisites: working **OrderPad** CUPS queue with **Star TSP100 Cutter (en)**, Node **22.12+ or 24**, Git, Tailscale connected to the phone's tailnet. Check `node --version`; distribution Node packages may be older. Use the [official Node installation guide](https://nodejs.org/en/download) if needed. Run the app as your normal user.

Confirm the queue and options:

```sh
lpstat -p OrderPad -v OrderPad
lpoptions -p OrderPad -l
```

For CUPS backend errors, use abort-job rather than automatic job retry:

```sh
sudo lpadmin -p OrderPad -o printer-error-policy=abort-job
sudo apt install git fonts-dejavu-core
```

If already checked out, enter this repository and `git pull --ff-only`. Otherwise:

```sh
git clone https://github.com/castab/event-order-pad.git order-pad
cd order-pad
```

```sh
npm ci
npm run build
npm run build:printer
tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
```

Set the printed Mint hostname as the HTTPS origin, replacing the example:

```sh
export ORDER_PAD_ORIGIN='https://YOUR-MINT-HOST.YOUR-TAILNET.ts.net'
export ORDER_PAD_QUEUE='OrderPad'
npm run start:printer
```

Keep this terminal running. In another terminal, inspect `tailscale serve status` before changing existing configuration. If the Mint host's HTTPS root is available for Order Pad:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4174
```

Follow Tailscale's authorization link if HTTPS needs enabling. Serve is private to the tailnet; do not enable Funnel or expose CUPS port 631. Phone HTTPS uses 443 with no explicit port. The backend binds only to loopback port 4174.

On the S10e, open the **Mint machine's** HTTPS URL. Select **Star TSP143IIIU — Linux USB / CUPS**, wait for **Linux queue configured**, acknowledge the CUPS test, then **Print Test Ticket**. Later attempts use **Reprint Last Ticket**. The page stays open while the service submits.

The Mint URL is a different storage origin from the Windows URL. Old browser ticket/history remain at the old origin; no migration or erasure occurs. This is still fake sample data.

## Behavior and limits

- PDFKit 0.20.2 renders the shared layout into one 72 mm wide PDF for 80 mm paper, embedding local DejaVu Sans Mono. Font/Unicode coverage requires output inspection. No remote receipt assets.
- The service reads installed `PageSize` choices and selects adequate 72 mm stock or supported custom size. It rejects unsupported options and tickets longer than 2000 mm. It never guesses a size keyword or shrinks to A4.
- `/usr/bin/lp` submits one copy of stdin PDF with documented Star `PageType=Variable0`, `PageCutType=NoCutPage0`, `DocCutType=PartialCutDoc1`. The driver rasterizes and controls USB. Variable length omits trailing blank stock.
- Accepted means **CUPS queue submission**, not physical output. Cover/paper/disconnection errors may occur after acceptance; no live hardware sensor claims. A queued job may print later. Pending CUPS jobs block new submissions.
- Browser IndexedDB saves intent first; the service independently flushes exclusive attempt intent before `lp`. Repeated recorded IDs return existing results; pending intent is unknown and never replayed after restart. Different content with the same ID is rejected. No background app queue or exactly-once guarantee.
- Lost/malformed response, interrupted submission or failed outcome persistence is unknown. Reprinting requires an explicit new attempt marked REPRINT with the original ticket ID. Other applications using CUPS are outside the station lock.
- Preserve `.print-data/` on local persistent storage; it contains tickets/attempts and is Git-ignored. Do not delete it to resolve an ambiguous print.
- Host/POST Origin checks, JSON-only bounded requests and no CORS permission restrict printing to the configured same-origin app. Tailnet rules control access; no account system is added.
- Static deployment/simulation/PassPRNT remain available. A static-only host has no Linux service. Cached UI and reachability of Mint are separate requirements.

Optional variables: `ORDER_PAD_PORT` (4174), `ORDER_PAD_DATA` (`.print-data` relative to repository), `ORDER_PAD_FONT` (`/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`). Keep paths/environment stable across restarts.

The initial service is foreground-only. Tailscale `--bg` persists the proxy, not Node. After smoke testing, configure systemd with the actual Node path, repository working directory and these variables. Disable host sleep for event use.

## Still to test

Sample readability/order/modifiers/instructions/end marker/cut; REPRINT and stable ID; rapid taps; host restart/browser recovery; disconnect/cover/paper errors and delayed jobs; network loss during submission; cached phone reopening with host reachable. The owner's CUPS test receipt does not establish these.

Inspect pending jobs before retrying:

```sh
lpstat -o OrderPad
lpstat -p OrderPad -l
```

Cancel a specific job in CUPS only after inspecting physical output. Never automatically clear jobs or journal records.

## Official sources

[Mint base](https://linuxmint.com/download_all.php), [Star driver/support](https://starmicronics.com/support/download/cups-driver-for-linux/), [Star manual](https://starmicronics.com/support/Mannualfolder/common_tsp_linux_en.pdf) (USB/model pp. 8–11, variable length p. 29, cutting p. 31, command values p. 51), [CUPS lp](https://www.cups.org/doc/man-lp.html), [media/options](https://www.cups.org/doc/options.html), [lpstat](https://www.cups.org/doc/man-lpstat.html), [error policy](https://www.cups.org/doc/man-lpadmin.html), [PDFKit fonts](https://pdfkit.org/docs/text.html), [page sizing](https://pdfkit.org/docs/getting_started.html), [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve).
