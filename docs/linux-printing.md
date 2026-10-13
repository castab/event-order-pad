# Linux USB printing

Target: **TSP143IIIU**, USB-B to Intel/AMD Mint **22.3 Cinnamon 64-bit**. On 2026-10-11 the owner reported a successful CUPS test page/receipt, followed by a successful Order Pad receipt from the Galaxy S10e browser over Tailscale HTTPS. Queue/driver options and CUPS job completion were inspected directly; physical readability, end marker and partial cut were owner-confirmed. Mint shares Ubuntu 24.04's base; Star lists Ubuntu 24.04 64-bit, not Mint explicitly. Compatibility is an inference supported by these tests, not certification.

The service hosts the static app and accepts same-origin print requests. The phone remains a browser client; this mode uses neither phone USB nor PassPRNT. Keep one station/tab. Orders with separately configured ice cream servings and optional names use the same print route. This Linux route follows the owner's move to a separate USB host after Android PassPRNT testing.

## Start on Mint

Prerequisites: a working local USB CUPS queue with **Star TSP100 Cutter (en)**, Node **22.17+ or 24**, Git, PostgreSQL 18 running on this same machine, Tailscale connected to the phone's tailnet. Check `node --version`; distribution Node packages may be older. Use the [official Node installation guide](https://nodejs.org/en/download) if needed. Run the app as your normal user. Use the existing queue's exact name; creating or renaming a queue is unnecessary.

Confirm the queue and options:

```sh
lpstat -p -v
lpoptions -p Star_TSP143 -l
```

For CUPS backend errors, use abort-job rather than automatic job retry:

```sh
sudo lpadmin -p Star_TSP143 -o printer-error-policy=abort-job
sudo apt install git fonts-dejavu-core
```

If already checked out, enter this repository and `git pull --ff-only`. Otherwise:

```sh
git clone https://github.com/castab/event-order-pad.git order-pad
cd order-pad
```

```sh
npm ci
# Configure .env and start PostgreSQL 18 as described in README first.
npm run db:deploy
npm run build
npm run build:printer
tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))'
```

Set the printed Mint hostname as the HTTPS origin, replacing the example:

```sh
export ORDER_PAD_ORIGIN='https://YOUR-MINT-HOST.YOUR-TAILNET.ts.net'
export ORDER_PAD_QUEUE='Star_TSP143'
npm run start:printer
```

Keep this terminal running. In another terminal, inspect `tailscale serve status` before changing existing configuration. If the Mint host's HTTPS root is available for Order Pad:

```sh
sudo tailscale serve --bg --https=443 http://127.0.0.1:4174
```

Follow Tailscale's authorization link if HTTPS needs enabling. Serve is private to the tailnet; do not enable Funnel or expose CUPS port 631. Phone HTTPS uses 443 with no explicit port. The backend binds only to loopback port 4174.

On the S10e, open the **Mint machine’s** HTTPS URL. The builder checks the server’s USB queue automatically on load. Use +/− to choose 1–5 scoops across any flavors for one serving, choose its container, optionally select toppings/name, then tap **Print order**. It adds or saves the complete current serving before submitting. Use **Add serving** for earlier servings in a multi-serving order. After queue acceptance, a fresh order opens automatically; **Reprint last order** keeps the original ticket, even while another draft is being built. **Order tools → Printer settings** shows the queue, its readiness message, setup notes and **Check printer**. No printer selection or recurring setup acknowledgment is needed.

Drafts, tickets, order numbers, attempts and print dispatch records belong to the shared local Postgres station. Browsers keep transient view state only. Opening a new browser profile reads the same station; stale concurrent ordering tabs are blocked by revision checks.

## Behavior and limits

- PDFKit 0.20.2 renders the shared layout into one 72 mm wide PDF for 80 mm paper, embedding local DejaVu Sans Mono. Font/Unicode coverage requires output inspection. No remote receipt assets.
- The service reads installed `PageSize` choices and selects adequate 72 mm stock or supported custom size. It rejects unsupported options and tickets longer than 2000 mm. It never guesses a size keyword or shrinks to A4.
- `/usr/bin/lp` submits one copy of stdin PDF using installed Star keywords for variable-length output, no page cut and a partial document cut. The verified Mint driver exposes `PageType=0Variable`, `PageCutType=0NoCutPage`, `DocCutType=1PartialCutDoc`; the service also accepts the alternate `Variable0`, `NoCutPage0`, `PartialCutDoc1` spelling only when advertised by the queue. The driver rasterizes and controls USB. Variable length omits trailing blank stock.
- Accepted means **CUPS queue submission**, not physical output. Cover/paper/disconnection errors may occur after acceptance; no live hardware sensor claims. A queued job may print later. Pending CUPS jobs block new submissions.
- The browser commits the ticket, locked draft, attempt and queue event in Postgres first; the service independently commits an exclusive dispatch claim in Postgres before `lp`. Repeated recorded IDs return existing results; pending intent is unknown and never replayed after restart. Different content with the same ID is rejected. No background print queue or exactly-once guarantee. There is no browser outbox or automatic publication retry.
- Lost/malformed response, interrupted submission or failed outcome persistence is unknown. Reprinting requires an explicit new attempt marked REPRINT with the original ticket ID. Other applications using CUPS are outside the station lock.
- Order events persist centrally in PostgreSQL 18; `/queue/` subscribes to live SSE snapshots at `/api/orders/events`. Reprints never add or reopen orders, and completed IDs remain durable after leaving Recently done. Only explicit Undo reopens an order. First submissions can appear before CUPS acceptance, including failed or unknown prints.
- Back up the whole Postgres database. Keep legacy `.print-data/` and browser history as archives; the current app never reads, writes or automatically imports them. Never reset database history to resolve an ambiguous print.
- Host/POST Origin checks, JSON-only bounded requests and no CORS permission restrict printing to the configured same-origin app. Tailnet rules control access; no account system is added.
- The ordering interface uses this USB route exclusively. A static-only host or cached shell cannot edit/recover drafts or print. Both the app service and local Postgres are required. Simulation/PassPRNT adapters remain available for compatibility tests. Legacy v1/v2 browser records are left untouched.
- Printed ticket times use the **Mint host’s** local time zone, because the service renders the PDF. Check it with `timedatectl` before an event. Browser previews and the queue use each device’s own time zone.

Required: `DATABASE_URL` (loopback Postgres connection URL; remote hosts/host overrides are rejected), `ORDER_PAD_CAPTURE_FROM` (fixed UTC capture cutoff with milliseconds), and `ORDER_PAD_ORIGIN`, the root HTTPS origin (no path). Effectively required: `ORDER_PAD_QUEUE`; it defaults to `OrderPad`, which is not the verified queue name. Optional: `ORDER_PAD_TRACKING_ENABLED` (`true`; set exactly `false` to hide the queue while retaining order capture; any other value stops startup), `ORDER_PAD_PORT` (4174; 1024–65535, loopback only), `ORDER_PAD_FONT` (`/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`). See the [configuration table in README](../README.md#configuration). Keep paths/environment stable across restarts.

Start the service **from the repository root**: it serves `./build`, checks the migrated database before listening, and exits if either is unavailable.

The npm launcher runs in the foreground. The verified Mint station uses `order-pad.service`. Its `WorkingDirectory` is the repository root and its environment-file drop-in loads `.env`; restart the managed process after every service rebuild with `sudo systemctl restart order-pad.service`. After changing the unit or its drop-ins, run `sudo systemctl daemon-reload` first. Configure new systemd stations with the actual Node path, the repository working directory, and `EnvironmentFile` pointing to `.env`. Tailscale `--bg` persists the proxy, not Node. Disable host sleep for event use.

## Verified Mint setup — 2026-10-11

- Node **24.21.0**, npm **11.19.0**; locked dependencies installed with zero audit vulnerabilities.
- Existing queue **Star_TSP143**, local Star USB backend, accepting jobs and idle with no pending jobs before the phone test. Driver: **Star TSP100 Cutter**, PPD `FileVersion` **2.1**, `rastertostar` filter. PPD version does not establish the driver package version.
- Advertised media includes `X72MMY30MM` through `X72MMY200MM` and `X72MMY2000MM`. `Custom.WIDTHxHEIGHT` is a template; this host uses an advertised fixed stock keyword with variable-length trimming.
- Installed option spellings are `0Variable`, `0NoCutPage`, `1PartialCutDoc`. The service was corrected to select supported keywords rather than send assumed spellings. A regression test covers this Mint configuration.
- Owner applied `printer-error-policy=abort-job`; confirmed through CUPS IPP.
- Private HTTPS root: **https://m710q-a2d606c.tail94e893.ts.net**, proxying only to **127.0.0.1:4174**. Root was unused before setup. HTTPS app loading and `/api/printer` returning `ready: true` were verified.
- `npm run check`, all **53 tests**, `npm run lint`, static build and printer build passed. HTTP tests require unsandboxed loopback access; sandboxed HTTP tests timed out.
- A Git-ignored, machine-specific `start-printer.local` launcher saves the actual Node path, working directory, queue and origin. Run `./start-printer.local` from this checkout to restart the foreground service when no instance is running. This does not provide boot startup.

The Galaxy S10e was online in Tailscale. The owner opened the Mint HTTPS URL, selected Linux USB / CUPS, acknowledged the successful CUPS test and tapped **Print Test Ticket** once. The service journal recorded accepted job **Star_TSP143-2**, attempt `7eacfd18e1a08b9c25f127bb6399a479`, ticket `8c9d32b614dc5f886fc5cee9b7c3f95b`. CUPS independently reported **completed**, **one sheet**, with the queue idle and no pending jobs afterward. Asked about the browser result, readable output, end marker and partial cut, the owner confirmed: “Yeah, it all worked.” This establishes the first phone-to-USB smoke test; reprint, interruption and recovery behavior remain untested on hardware.

## Update and test the order builder

Follow README’s [Postgres setup and upgrade steps](../README.md#set-up-postgres-and-upgrade-the-station): configure `.env`, start PostgreSQL 18, apply committed migrations with `npm run db:deploy`, then rebuild both outputs. When no print attempt or CUPS job is pending, stop the old service and restart with `npm run start:printer`. A direct launcher such as `./start-printer.local` must load `.env` with Node’s `--env-file=.env` or export `DATABASE_URL` and `ORDER_PAD_CAPTURE_FROM` itself. Reload browser tabs together. Keep the cutoff fixed across restarts.

Before rollout, reconcile old drafts, unpublished orders, pending attempts, paper and CUPS jobs with the old version. Preserve `.print-data/` and IndexedDB as archives; neither is imported or modified. Apply the station persistence migration explicitly and deploy app/service together. The new shared draft and last-receipt history start empty; existing Postgres order events are preserved. Back up the whole Postgres volume and never remove it to resolve an ambiguous print.

With `ORDER_PAD_TRACKING_ENABLED=false`, the builder hides the queue link and `/queue/` shows a disabled message. GET queue/SSE endpoints return 404 with `ORDER_TRACKING_DISABLED`, while all order POSTs remain available. Submissions, completion, and reopening are persisted regardless of visibility. Completion is explicit, never inferred from print acceptance. Database access is required even with tracking off. An unavailable database prevents service startup; an outage during operation blocks all API work and the builder. Restore Postgres, then reload to recover durable state. Queue actions are disabled while disconnected.

Restart and reload after changing visibility. To re-enable, use `true` or unset the flag. Verify the running flag with uncached `/api/features`.

With tracking enabled, verify streaming through the existing Mint HTTPS origin:

```sh
curl --no-buffer --header 'Accept: text/event-stream' 'https://YOUR-MINT-HOST.YOUR-TAILNET.ts.net/api/orders/events'
```

Expect `retry: 3000`, an immediate `event: orders` with the complete queue, and
`event: ping` every 15 seconds. Stop this read-only check with Ctrl+C. Saved order
changes should arrive without waiting for a polling interval. The service sends
`Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no`; verify the
existing Tailscale HTTPS proxy forwards the initial event and heartbeat promptly
before changing proxy configuration. A dropped connection retains the last view,
shows a warning and reconnects automatically. Mark done/Undo still use the same
POST APIs and never resend a print.

On the phone, reload or reopen the same Mint HTTPS URL. Pages load network-first, and an open tab applies the new service worker itself (reloading when hidden or idle, never during a send), so closing every tab is no longer needed. Keep the Postgres volume and legacy archives; clearing browser data cannot repair database failures.

For physical acceptance of the simplified workflow:

1. Choose Vanilla and Cup without pressing Add serving. Tap **Print order** once. Verify one serving with one Vanilla scoop, the generated two-word label, end marker, legibility, and partial cut. Confirm a fresh order opens with all flavor counts at zero and no container selected.
2. Enter a name and choose 2 Chocolate Chip scoops + 1 Strawberry scoop in a Cup with all eight toppings, then add that serving. Choose 5 Vanilla scoops in a Cake Cone with no toppings and press Print directly. Verify the trimmed name, exactly two serving blocks, total scoop counts of 3 and 5, correct per-flavor counts, full toppings, and the no-toppings line. The mixed flavors must remain together in one serving block.
3. Begin another draft with a different name and unfinished selections. Deliberately **Reprint last order**. Verify REPRINT, original label/content/ID/timestamp, and that the new draft is unchanged.
4. Open **Order tools**, inspect the `Star_TSP143` queue under Printer settings, tap **Check printer**, and close Order tools. Verify the draft survives. Reload and verify the draft and USB destination recover without selection or setup confirmation.
5. Inspect printer output and pending jobs during a controlled connection interruption. Verify the UI retains an unknown order and requires acknowledgment before continuing, without automatically resending.

6. With no print in progress, stop local Postgres and verify editing, New order, reprints and Print order become blocked. Verify no CUPS job is created. Restore Postgres and reload; confirm the saved draft and order number return. Also verify the service refuses to start while Postgres is down.
7. Open another browser profile and confirm the same draft/last receipt appears. Keep one active ordering tab; verify stale edits cannot replace newer saved state.

These are physical acceptance steps, not claims that this interaction update has already been tested on hardware.

## Still to test

Detailed content/glyph inspection beyond the first owner-confirmed readable sample; REPRINT and stable ID; rapid taps; host restart/browser recovery; disconnect/cover/paper errors and delayed jobs; network loss during submission; cached phone reopening with host reachable. The successful smoke test does not establish these recovery and failure cases.

Inspect pending jobs before retrying:

```sh
lpstat -o Star_TSP143
lpstat -p Star_TSP143 -l
```

Cancel a specific job in CUPS only after inspecting physical output. Never automatically clear jobs or journal records.

## Official sources

[Mint base](https://linuxmint.com/download_all.php), [Star driver/support](https://starmicronics.com/support/download/cups-driver-for-linux/), [Star manual](https://starmicronics.com/support/Mannualfolder/common_tsp_linux_en.pdf) (USB/model pp. 8–11, variable length p. 29, cutting p. 31, command values p. 51), [CUPS lp](https://www.cups.org/doc/man-lp.html), [media/options](https://www.cups.org/doc/options.html), [lpstat](https://www.cups.org/doc/man-lpstat.html), [error policy](https://www.cups.org/doc/man-lpadmin.html), [PDFKit fonts](https://pdfkit.org/docs/text.html), [page sizing](https://pdfkit.org/docs/getting_started.html), [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve).
