# Linux USB printing

Target: **TSP143IIIU**, USB-B to Intel/AMD Mint **22.3 Cinnamon 64-bit**. On 2026-10-11 the owner reported a successful CUPS test page/receipt, followed by a successful Order Pad receipt from the Galaxy S10e browser over Tailscale HTTPS. Queue/driver options and CUPS job completion were inspected directly; physical readability, end marker and partial cut were owner-confirmed. Mint shares Ubuntu 24.04's base; Star lists Ubuntu 24.04 64-bit, not Mint explicitly. Compatibility is an inference supported by these tests, not certification.

The service hosts the static app and accepts same-origin print requests. The phone remains a browser client; this mode uses neither phone USB nor PassPRNT. Separate browser profiles/devices can take orders concurrently; use one active ordering tab per profile. Orders with separately configured ice cream servings and optional names use the same print route. This Linux route follows the owner's move to a separate USB host after Android PassPRNT testing.

## Start on Mint

Stations now install verified releases with `install-station.sh`, which brings its own Node runtime and updates itself inside a maintenance window. Follow [Station releases and automatic updates](../README.md#station-releases-and-automatic-updates) for a new station or to move this one over; the queue, Cloudflare Tunnel, Turnstile and admin-page steps below still apply. On a release-installed station, use `sudo order-pad-access …` wherever this guide says `npm run access -- …`, and keep settings in `/etc/order-pad/order-pad.env` instead of `.env`. The checkout steps below remain for development.

Prerequisites: a working local USB CUPS queue with **Star TSP100 Cutter (en)**, Node **22.17+ or 24**, Git, PostgreSQL 18 running on this same machine, a Cloudflare-managed domain, a named Cloudflare Tunnel, and Turnstile keys for the final hostname. Check `node --version`; distribution Node packages may be older. Use the [official Node installation guide](https://nodejs.org/en/download) if needed. Run the app as your normal user. Use the existing queue's exact name; creating or renaming a queue is unnecessary.

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
npm run access -- mint 2   # one code per device you sign in now
```

Configure `.env` using [.env.example](../.env.example): `ORDER_PAD_ORIGIN=https://orders.example.com`, the real CUPS queue, local database URL, fixed capture cutoff, `ORDER_PAD_PROXY=cloudflare` and both Turnstile keys. Keep the secret key out of Git and browser builds. The widget must allow the exact final hostname. `npm run start:printer` loads `.env`; exported shell variables override it. Start the app from the repository root.

### Cloudflare Tunnel and HTTPS

1. Install `cloudflared` on the same Linux host using [Cloudflare’s installation instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/).
2. Authenticate the connector and create a named tunnel. Use the final subdomain consistently; Turnstile and the session cookies are bound to it.

   ```sh
   cloudflared tunnel login
   cloudflared tunnel create order-pad
   cloudflared tunnel route dns order-pad orders.example.com
   ```

3. Copy [deploy/cloudflared.example.yml](../deploy/cloudflared.example.yml) to the connector’s configuration location, fill in the tunnel UUID, hostname and credentials-file path, and restrict access to the credentials file. Route only that hostname to `http://127.0.0.1:4174`, preserve its Host header, and retain the final `http_status:404` ingress rule. The app and connector share a machine; local HTTP stays on loopback, while the tunnel and browser connections are encrypted.
4. In Cloudflare, enable HTTPS redirects for this hostname and add a **Bypass cache** rule covering the entire application hostname, including HTML and `/api/*`. Do not add “Cache Everything” rules or edge challenges to authenticated API/SSE routes. Application login performs its own Turnstile validation.
5. Check the configuration, then run the tunnel:

   ```sh
   cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
   cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://orders.example.com
   cloudflared tunnel --config /etc/cloudflared/config.yml run order-pad
   ```

6. Once validated, install the connector as a system service using Cloudflare’s [Linux service instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/as-a-service/linux/). Use the explicit configuration path; the credentials/configuration must be readable by the service identity. Keep the Node service managed separately by systemd.
7. Test the public URL from a device with Tailscale disabled. Unauthenticated `/` and `/queue/` redirect to login; `/api/printer`, `/api/station`, `/api/orders/events` and all operational POSTs require a session. Sign in with a fresh access code and Turnstile, and keep the queue open through several heartbeat intervals.

`ORDER_PAD_PROXY=cloudflare` trusts a valid `CF-Connecting-IP` only from the loopback connector. Arbitrary `X-Forwarded-For` values are ignored. Missing or malformed Cloudflare client-IP headers reject public authentication requests. Local processes and connector configuration are trusted host administration; do not bind the app to a public interface. No inbound router port forwarding is required. Never expose Postgres 5432 or CUPS 631 through a tunnel.

For an alternative trusted local HTTPS proxy, including Tailscale Serve, use `ORDER_PAD_PROXY=direct` and configure Turnstile for that exact hostname too. Login remains mandatory. Direct mode rate-limits the proxy’s socket address, so Cloudflare mode is preferred for this deployment.

### Access codes and upgrading

There are no personal accounts. Each device signs in with its own one-time code. At the start of a shift, run `npm run access -- mint <count>` on the station with one code per device (1 to 5 at a time, at most 10 unused at once). It shows codes such as `K7QM4-XTD9A` in the terminal and prints one slip per code; hand one slip to each device. A code must be used within 60 minutes, works once, and signs that device in for 8 hours. After signing out or when the 8 hours end, the device needs a new code. Minting never signs anyone out. `npm run access -- revoke` voids every unused code and signs every device out (for example at closing, or if a slip went missing and you can’t tell which), and `npm run access -- status` lists unused codes and signed-in devices without revealing any code. If a slip doesn’t print, the terminal says so and the code is still valid. Nobody can mint codes through the public website; the owner can also use the tailnet admin page below. See [README access codes](../README.md#access-codes-and-sign-in).

Before upgrading or switching from the old Tailscale hostname: finish/reconcile every draft and pending/unknown print, back up PostgreSQL, close old tabs and stop the old Node process. Run `npm run db:deploy` explicitly, rebuild both targets, configure the final origin/Turnstile/tunnel, mint access codes, and restart the managed service. Preserve the capture cutoff. Upgrading from personal accounts deletes accounts, passwords and passkeys; browsers that only one account used keep that account’s workspace, and other workspaces stay in the database untouched. The new domain receives new browser cookies and empty workspaces. Existing-domain cookies never transfer automatically.

On the S10e, open the configured public HTTPS URL and sign in. The builder checks the server’s USB queue automatically on load. Use +/− to choose 1–5 scoops across any flavors for one serving, choose its container, optionally select toppings/name, then tap **Print order**. It adds or saves the complete current serving before submitting. Use **Add serving** for earlier servings in a multi-serving order. After queue acceptance, a fresh order opens automatically; **Reprint last order** keeps the original ticket, even while another draft is being built. **Order tools → Printer settings** shows the queue, its readiness message, setup notes and **Check printer**. No printer selection or recurring setup acknowledgment is needed.

Drafts, tickets, numbers, attempts and dispatches stay in local Postgres. Each browser profile has its own workspace, resolved by a persistent opaque browser cookie. Signing in, including with a later access code, restores that browser’s draft, latest receipt and recovery state. Separate profiles/devices edit independently; stale tabs within the same profile are blocked by revision checks. The header displays “New order” until the service allocates a number while committing print intent. Clearing cookies starts a new workspace without deleting old records.

### Tailnet admin page

This lets chosen devices mint codes, see unused codes and signed-in devices, void codes and sign devices out from a browser on the station’s tailnet, without a terminal. Staff use the public Cloudflare hostname and are not on the tailnet. The page is served on a private Unix socket that cloudflared never forwards to. Tailscale Serve publishes it on a separate HTTPS port.

Which devices may use the page is decided by the **tailnet policy**, not by the service. The policy grants a Tailscale app capability to devices with a tag. Serve forwards the requesting device’s capabilities to the service and deletes any copy a client sends. The service refuses every request without the configured capability, including requests from devices signed in as the owner. To grant the ability, tag the device; to take it away, remove the tag. Neither removes the device from the tailnet.

1. In the Tailscale admin console, edit the policy file. Add the tag owner, a host alias for the station (`tailscale ip -4` on the station) and the grant, keeping your existing rules:

   ```json
   {
     "tagOwners": {
       "tag:order-pad-admin": ["autogroup:admin"]
     },
     "hosts": {
       "order-pad-station": "100.101.102.103"
     },
     "grants": [
       {
         "src": ["tag:order-pad-admin"],
         "dst": ["order-pad-station"],
         "ip": ["tcp:443"],
         "app": {
           "fionasicecream.com/cap/order-pad-admin": [{}]
         }
       }
     ]
   }
   ```

   Merge these keys into the existing file rather than replacing it. The `ip` entry keeps HTTPS on the station reachable for tagged devices even if other rules are tightened later.

2. Tag each device that may manage access: **Machines → ⋯ → Edit ACL tags → `tag:order-pad-admin`**. A tagged device is owned by the tag instead of a user, and its key expiry is disabled by default. Rules that grant access by user no longer apply to it, so make sure the policy still gives it whatever else it needs. To revoke the ability, remove the tag the same way, or delete the grant to revoke it for every device. See Tailscale’s [tags](https://tailscale.com/kb/1068/tags) and [grants](https://tailscale.com/kb/1324/grants) documentation.
3. Add to `.env`. Use the station’s full tailnet name, which `tailscale status --json` shows under `Self.DNSName` without the trailing dot:

   ```sh
   ORDER_PAD_ADMIN_ORIGIN=https://station.example.ts.net
   ORDER_PAD_ADMIN_SOCKET=/run/order-pad/admin.sock
   ORDER_PAD_ADMIN_CAPABILITY=fionasicecream.com/cap/order-pad-admin
   ```

4. Give the service a private runtime directory with `sudo systemctl edit order-pad.service`, then restart:

   ```ini
   [Service]
   RuntimeDirectory=order-pad
   RuntimeDirectoryMode=0700
   ```

   ```sh
   npm run build:printer
   sudo systemctl daemon-reload
   sudo systemctl restart order-pad.service
   journalctl -u order-pad.service -n 5   # “Tailnet access-code admin listening on /run/order-pad/admin.sock …”
   ```

   The service refuses to start if the directory is missing, belongs to another user or is readable by anyone else. It also refuses if a non-socket file sits at the path, if the admin settings are incomplete, or if the retired `ORDER_PAD_ADMIN_LOGINS` is still set. systemd removes the directory when the service stops.

5. Publish the socket on the tailnet only, passing the capability through. Use `serve`, never `funnel`:

   ```sh
   sudo tailscale serve --bg --https=443 --accept-app-caps=fionasicecream.com/cap/order-pad-admin unix:/run/order-pad/admin.sock
   tailscale serve status   # https://…ts.net (tailnet only) |-- / proxy unix:/run/order-pad/admin.sock
   ```

   Without `--accept-app-caps`, Serve forwards no capabilities and every device is refused. Never add the socket to the cloudflared ingress. This takes the station’s tailnet port 443, so do not also proxy the staff app there; staff use the public hostname. Serve sends `Host: localhost` to socket backends, so the service checks Serve’s `X-Forwarded-Host` against `ORDER_PAD_ADMIN_ORIGIN`.

6. Acceptance:
   - On a tagged device, `https://station.example.ts.net/` shows the mint form, unused codes and signed-in devices without minting anything.
   - On an untagged tailnet device, the same address returns “This device can’t manage access codes.”
   - On a station terminal, `curl --unix-socket /run/order-pad/admin.sock -H 'X-Forwarded-Host: station.example.ts.net' http://localhost/api/admin/access` returns 403 because no capability header is present.
   - With Tailscale disabled, the tailnet address is unreachable and the public hostname’s `/api/admin/access` returns 401 or 404.
   - Enter 2 for **How many access codes would you like to mint?** and tap **Mint 2 codes**. The page shows both codes with their use-by times, two separate slips print, each code signs in one staff device, and a code that was already used is refused on a third device. Typing 9 in the field leaves 5. Both devices appear under **Signed-in devices**; **Sign out** on one returns only that device to sign-in. When signing everyone out is safe, **Sign out everyone** does that and empties **Unused codes**.
   - Remove the tag from that device and reload the page: it is refused, and the device stays on the tailnet.
   - `journalctl -u order-pad.service` shows the tailnet address of the device that made each change, and never a code.

To turn the page off, run `sudo tailscale serve --https=443 off`, remove the three `ORDER_PAD_ADMIN_*` variables and restart the service; the policy grant can stay or go. Codes already minted stay valid until they are used, lapse or are voided with `npm run access -- revoke`, and signed-in devices stay signed in until their 8 hours end.

## Behavior and limits

- PDFKit 0.20.2 renders the shared layout into one 72 mm wide PDF for 80 mm paper, embedding local DejaVu Sans Mono. Font/Unicode coverage requires output inspection. No remote receipt assets.
- The service reads installed `PageSize` choices and selects adequate 72 mm stock or supported custom size. It rejects unsupported options and tickets longer than 2000 mm. It never guesses a size keyword or shrinks to A4.
- `/usr/bin/lp` submits one copy of stdin PDF using installed Star keywords for variable-length output, no page cut and a partial document cut. The verified Mint driver exposes `PageType=0Variable`, `PageCutType=0NoCutPage`, `DocCutType=1PartialCutDoc`; the service also accepts the alternate `Variable0`, `NoCutPage0`, `PartialCutDoc1` spelling only when advertised by the queue. The driver rasterizes and controls USB. Variable length omits trailing blank stock.
- Accepted means **CUPS queue submission**, not physical output. Cover/paper/disconnection errors may occur after acceptance; no live hardware sensor claims. A queued job may print later. An admitted request checks pending CUPS jobs once per second for up to 30 seconds; if they remain, no new job is submitted.
- The browser commits the ticket, locked draft, attempt and queue event in Postgres first; the service independently commits an exclusive dispatch claim in Postgres before `lp`. Repeated recorded IDs return existing results; pending intent is unknown and never replayed after restart. Different content with the same ID is rejected. Concurrent requests use an in-process FIFO with at most eight waiting requests and a 30-second slot timeout. The browser allows 240 seconds for the response. This waiting list is never replayed after restart; there is no durable background print queue or exactly-once guarantee. There is no browser outbox or automatic publication retry.
- Lost/malformed response, interrupted submission or failed outcome persistence is unknown. Reprinting requires an explicit new attempt marked REPRINT with the original ticket ID. Other applications using CUPS are outside the station lock.
- Order events persist centrally in PostgreSQL 18; `/queue/` subscribes to live SSE snapshots at `/api/orders/events`. Reprints never add or reopen orders, and completed IDs remain durable after leaving Recently done. Only explicit Undo reopens an order. First submissions can appear before CUPS acceptance, including failed or unknown prints.
- Back up the whole Postgres database. Keep legacy `.print-data/` and browser history as archives; the current app never reads, writes or automatically imports them. Never reset database history to resolve an ambiguous print.
- Host/POST Origin checks, JSON-only bounded requests and no CORS permission restrict printing to the configured same-origin app. Secure database-backed sessions control access, with Turnstile and persistent login rate limits. A structured `401 authentication-required` before dispatch means no job was submitted. Lost replies remain unknown and are never retried.
- The ordering interface uses this USB route exclusively. A static-only host or cached shell cannot edit/recover drafts or print. Both the app service and local Postgres are required. Simulation/PassPRNT adapters remain available for compatibility tests. Legacy v1/v2 browser records are left untouched.
- Printed ticket times use the **Mint host’s** local time zone, because the service renders the PDF. Check it with `timedatectl` before an event. Browser previews and the queue use each device’s own time zone.

Required: `DATABASE_URL` (loopback Postgres connection URL; remote hosts/host overrides are rejected), `ORDER_PAD_CAPTURE_FROM` (fixed UTC capture cutoff with milliseconds, set once at rollout; a cutoff later than the host clock makes every new order fail until that time, so check `date -u` first), the two Turnstile keys, and `ORDER_PAD_ORIGIN`, the root HTTPS origin (no path). Set `ORDER_PAD_PROXY=cloudflare` for the local connector; `direct` is the default for other local proxies. Effectively required: `ORDER_PAD_QUEUE`; it defaults to `OrderPad`, which is not the verified queue name. Optional: `ORDER_PAD_TRACKING_ENABLED` (`true`; set exactly `false` to hide the queue while retaining order capture; any other value stops startup), `ORDER_PAD_PORT` (4174; 1024–65535, loopback only), `ORDER_PAD_FONT` (`/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`). See the [configuration table in README](../README.md#configuration). Keep paths/environment stable across restarts.

Start the service **from the repository root**: it serves `./build`, checks the migrated database before listening, and exits if either is unavailable.

The npm launcher runs in the foreground. A release-installed station uses the shipped `order-pad.service` (user `order-pad`, `WorkingDirectory=/opt/order-pad/current`, `EnvironmentFile=/etc/order-pad/order-pad.env`); `order-pad-update.timer` installs new releases and restarts it. Before the move to releases, the verified Mint station's `order-pad.service` used the repository root as `WorkingDirectory` and its environment-file drop-in loads `.env`; restart the managed process after every service rebuild with `sudo systemctl restart order-pad.service`. After changing the unit or its drop-ins, run `sudo systemctl daemon-reload` first. Configure new systemd stations with the actual Node path, the repository working directory, and `EnvironmentFile` pointing to `.env`. The cloudflared system service persists the tunnel, not Node. Disable host sleep for event use.

## Verified Mint setup — 2026-10-11

This section is a dated record of the first station check, not current instructions. It predates the Postgres store, workspaces and the removal of the printer selector, so its test counts and the UI steps in its last paragraph (the printer selector and **Print Test Ticket**) no longer apply as written. Current status is in [verification.md](verification.md).

- Node **24.21.0**, npm **11.19.0**; locked dependencies installed with zero audit vulnerabilities.
- Existing queue **Star_TSP143**, local Star USB backend, accepting jobs and idle with no pending jobs before the phone test. Driver: **Star TSP100 Cutter**, PPD `FileVersion` **2.1**, `rastertostar` filter. PPD version does not establish the driver package version.
- Advertised media includes `X72MMY30MM` through `X72MMY200MM` and `X72MMY2000MM`. `Custom.WIDTHxHEIGHT` is a template; this host uses an advertised fixed stock keyword with variable-length trimming.
- Installed option spellings are `0Variable`, `0NoCutPage`, `1PartialCutDoc`. The service was corrected to select supported keywords rather than send assumed spellings. A regression test covers this Mint configuration.
- Owner applied `printer-error-policy=abort-job`; confirmed through CUPS IPP.
- Private HTTPS root: **https://station.example.ts.net**, proxying only to **127.0.0.1:4174**. Root was unused before setup. HTTPS app loading and `/api/printer` returning `ready: true` were verified.
- `npm run check`, all **53 tests**, `npm run lint`, static build and printer build passed. HTTP tests require unsandboxed loopback access; sandboxed HTTP tests timed out.
- A Git-ignored, machine-specific `start-printer.local` launcher saves the actual Node path, working directory, queue and origin. Run `./start-printer.local` from this checkout to restart the foreground service when no instance is running. This does not provide boot startup.

The Galaxy S10e was online in Tailscale. The owner opened the Mint HTTPS URL, selected Linux USB / CUPS, acknowledged the successful CUPS test and tapped **Print Test Ticket** once. The service journal recorded accepted job **Star_TSP143-2**, attempt `7eacfd18e1a08b9c25f127bb6399a479`, ticket `8c9d32b614dc5f886fc5cee9b7c3f95b`. CUPS independently reported **completed**, **one sheet**, with the queue idle and no pending jobs afterward. Asked about the browser result, readable output, end marker and partial cut, the owner confirmed: “Yeah, it all worked.” This establishes the first phone-to-USB smoke test; reprint, interruption and recovery behavior remain untested on hardware.

## Update and test the order builder

A release-installed station updates itself (see [Station releases and automatic updates](../README.md#station-releases-and-automatic-updates)); `sudo order-pad-ops status` shows what is installed and `journalctl -u order-pad-update` what the updater did. The rest of this paragraph is the checkout procedure.

Follow README’s [Postgres setup and upgrade steps](../README.md#set-up-postgres-and-upgrade-the-station): configure `.env`, start PostgreSQL 18, apply committed migrations with `npm run db:deploy`, then rebuild both outputs. When no print attempt or CUPS job is pending, stop the old service and restart with `npm run start:printer`. A direct launcher such as `./start-printer.local` must load `.env` with Node’s `--env-file=.env` or export `DATABASE_URL` and `ORDER_PAD_CAPTURE_FROM` itself. Reload browser tabs together. Keep the cutoff fixed across restarts.

Before rollout, reconcile old drafts, unpublished orders, pending attempts, paper and CUPS jobs with the old version. Preserve `.print-data/` and IndexedDB as archives; neither is imported or modified. Apply committed migrations explicitly and deploy app/service together. The workspace migration preserves the existing Postgres draft and last-receipt recovery history; the first browser opening the builder adopts them atomically. Open the intended recovery browser first. Later browsers get empty independent drafts. Unsubmitted drafts lose their provisional number; immutable tickets keep theirs, and the shared counter cannot reuse preserved numbers. Existing Postgres order events are preserved. Back up the whole Postgres volume and never remove it to resolve an ambiguous print.

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
6. On any printed ticket, verify each serving block starts with `SERVING n OF m` (for example `SERVING 1 OF 2`) at the left margin, with no empty box before it, and that the line stays clear of the black scoop-count tag below it.
7. With no print in progress, stop local Postgres and verify editing, New order, reprints and Print order become blocked. Verify no CUPS job is created. Restore Postgres and, without reloading, verify the builder reconnects within about five seconds (or at once with **Reconnect now**) and the saved draft and any committed ticket number return. Also verify the service refuses to start while Postgres is down.
8. Open two browser profiles/devices. Confirm independent names and servings, “New order” before submission, and no draft-save conflict when the other prints. Print concurrently and verify distinct numbers and one physical ticket per attempt. Reload/restart each browser and verify its own draft and receipt return. In two tabs of one profile, verify stale edits cannot replace newer saved state.
9. On the installed phone PWA, start a draft, lock the phone for several minutes and unlock it. Verify the builder either never shows “Database needs attention” or clears it by itself within a few seconds, with the draft intact and nothing printed.
10. During a controlled pending CUPS job, verify a second request waits and submits once after the queue clears. Keep a job pending beyond 30 seconds and verify the second attempt reports that no job was submitted. Restart during a wait and verify no waiting request replays; inspect output before acknowledging any unknown outcome.

These are physical acceptance steps, not claims that this interaction update has already been tested on hardware.

## Public-access acceptance checks

These remain deployment/device checks; automated fixtures do not establish them.

1. With Tailscale disabled, verify public HTTPS, HTTP-to-HTTPS redirect, correct Host forwarding and working Turnstile for access-code sign-in.
2. Before login and after logout, check protected pages, printer/backend APIs and SSE deny access. Confirm no protected HTML/API data is returned from browser or Cloudflare caches, including offline navigation and browser Back.
3. Mint two codes and sign in on two devices, one code each, and confirm they have independent drafts/recovery and a used code is refused on a third device. Run `npm run access -- revoke` and confirm both devices return to sign-in; fresh codes restore each device’s own draft.
4. Check that an unused code lapses after 60 minutes, that a session ends 8 hours after sign-in, and `npm run access -- revoke`, including an already-open queue. During a controlled print, session loss must wait for the send to settle; subsequent login must recover durable state without resending. Inspect physical output before acknowledging unknown results.
5. Run `npm run access -- mint 3` with the printer ready and confirm three separate slips print, each cut cleanly, and the code, use-by time and “Works once, on one device, for 8 hours.” are legible on each; then confirm a mint with the printer unplugged reports the failure and the terminal code still signs in. Verify wrong-code rate-limit feedback and recovery after cooldown. Keep station data backed up.
6. If the tailnet admin page is configured, complete its acceptance steps under [Tailnet admin page](#tailnet-admin-page), including a mint of 2 from the page with the printer unplugged: the page must keep showing both valid codes, report the failed slip and mark the other as not printed.

## Release-installed station acceptance checks

Automated tests stub `systemctl`, CUPS and GitHub; the packaged release is only smoke-tested in PDF mode. After moving a station to releases (or changing `deploy/systemd/`), check on the station:

1. `sudo order-pad-ops status` shows the installed release and an open/closed window that matches local time.
2. As the `order-pad` user, the service prints an order and a REPRINT on the USB queue with the expected cut, and `sudo order-pad-access mint 1` prints a slip. `systemctl show order-pad -p User` reports `order-pad`.
3. The tailnet admin page still loads through `tailscale serve` (`unix:/run/order-pad/admin.sock`) and mints a code; the Cloudflare hostname still signs in.
4. `sudo systemctl stop order-pad` during no print finishes within a few seconds; a print sent just before the stop finishes and is recorded, and a print attempted while stopping reports that no job was submitted.
5. With a prerelease on `CHANNEL=prerelease` (or `PIN`), the timer stages and installs it inside the window only after `QUIET_MINUTES` without activity, writes a backup to `/var/backups/order-pad/`, and does nothing while a draft is being edited.
6. A deliberately broken prerelease (for example one that exits at startup) is rolled back to the previous release, logged, and not retried.

## Still to test

Detailed content/glyph inspection beyond the first owner-confirmed readable sample; REPRINT and stable ID; rapid taps; host restart/browser recovery; disconnect/cover/paper errors and delayed jobs; network loss during submission; cached phone reopening with host reachable; the Postgres-outage, two-profile and pending-CUPS-job checks (acceptance steps 7–9 above). The successful smoke test does not establish these recovery and failure cases.

Inspect pending jobs before retrying:

```sh
lpstat -o Star_TSP143
lpstat -p Star_TSP143 -l
```

Cancel a specific job in CUPS only after inspecting physical output. Never automatically clear jobs or journal records.

## Official sources

[Mint base](https://linuxmint.com/download_all.php), [Star driver/support](https://starmicronics.com/support/download/cups-driver-for-linux/), [Star manual](https://starmicronics.com/support/Mannualfolder/common_tsp_linux_en.pdf) (USB/model pp. 8–11, variable length p. 29, cutting p. 31, command values p. 51), [CUPS lp](https://www.cups.org/doc/man-lp.html), [media/options](https://www.cups.org/doc/options.html), [lpstat](https://www.cups.org/doc/man-lpstat.html), [error policy](https://www.cups.org/doc/man-lpadmin.html), [PDFKit fonts](https://pdfkit.org/docs/text.html), [page sizing](https://pdfkit.org/docs/getting_started.html), [Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve).

## PDF development output

For receipt development without paper, set `ORDER_PAD_PRINT_MODE=pdf`. This runs on Windows, macOS and Linux with local PostgreSQL 18. Use a separate development database, an explicit readable `ORDER_PAD_FONT` TTF path, and optionally `ORDER_PAD_PDF_DIR` (default `.receipt-pdfs`). PDF mode permits loopback HTTP origins such as `http://localhost:4174`; CUPS mode still requires Linux and HTTPS. Follow [the complete development setup](../README.md#pdf-development-printing).

Print order saves one PDF per attempt and reports a simulated accepted result only after saving the file and dispatch outcome. Order tools provides View PDF; reprints create separate PDFs. No CUPS command runs in PDF mode. Files remain until manually removed, and viewing requires the owning workspace. The normal database, numbering, queue and unknown-outcome rules apply. Check physical printing and cutting using the existing hardware acceptance checklist before using layout changes in service.
