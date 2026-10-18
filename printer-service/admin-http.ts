import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, lstat, stat, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname } from 'node:path';
import { formatAccessCode } from '../src/lib/auth/model';
import type { AccessResult } from './access-admin';
import { BadRequest, readJson } from './http';

export const adminAccessPath = '/api/admin/access';
type AccessCommand = 'mint' | 'status' | 'revoke';

/** Whether Serve's capability header grants `capability` to the requesting device. */
export function hasCapability(value: unknown, capability: string): boolean {
  if (typeof value !== 'string' || value.length > 16384) return false;
  try {
    const caps: unknown = JSON.parse(value);
    return (
      !!caps &&
      typeof caps === 'object' &&
      !Array.isArray(caps) &&
      Object.hasOwn(caps, capability) &&
      Array.isArray((caps as Record<string, unknown>)[capability])
    );
  } catch {
    return false;
  }
}

/**
 * Tailnet-only access-code administration. Tailscale Serve forwards the
 * device's granted app capabilities and strips client copies; only devices the
 * tailnet policy grants `capability` on the exact admin origin get through, and
 * a change is never retried or run twice at once.
 */
export function createAdminApp({
  origin,
  capability,
  access,
  slip,
  slipMode = 'cups',
  log = console.log,
}: {
  origin: URL;
  capability: string;
  access: (command: AccessCommand) => Promise<AccessResult>;
  slip: (code: string, expiresAt: Date) => Promise<string>;
  slipMode?: 'cups' | 'pdf';
  log?: (message: string) => void;
}): Server {
  let changing = false;
  // Browsers can resend a POST whose connection closed before any reply bytes,
  // so each confirmation carries an ID that is handled at most once.
  const handled = new Set<string>();
  return createServer(async (req, res) => {
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Serve overwrites X-Forwarded-For with the device's tailnet address.
    const forwarded = req.headers['x-forwarded-for'];
    const device =
      typeof forwarded === 'string' && isIP(forwarded)
        ? forwarded
        : 'an unidentified device';
    // Serve sends Host: localhost to socket backends and always overwrites
    // X-Forwarded-Host with the host the browser used.
    const viewedHost =
      req.headers.host === 'localhost'
        ? req.headers['x-forwarded-host']
        : req.headers.host;
    if (viewedHost !== origin.host) {
      json(403, { error: 'Unrecognized host.' });
      return;
    }
    if (!hasCapability(req.headers['tailscale-app-capabilities'], capability)) {
      json(403, { error: 'This device can’t manage access codes.' });
      return;
    }
    try {
      const path = new URL(req.url ?? '/', origin).pathname;
      if (['GET', 'HEAD'].includes(req.method ?? '') && path === '/') {
        const page = Buffer.from(adminPage(nonce));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': page.length,
        });
        res.end(req.method === 'HEAD' ? undefined : page);
        return;
      }
      if (req.method === 'GET' && path === adminAccessPath) {
        let result;
        try {
          result = await access('status');
        } catch {
          json(503, {
            error: 'Database unavailable. Check Postgres on the station.',
          });
          return;
        }
        if (result.kind !== 'status') throw new Error('Unexpected result.');
        json(200, {
          active: !!result.expiresAt,
          expiresAt: result.expiresAt?.toISOString(),
          sessions: result.sessions,
        });
        return;
      }
      if (req.method === 'POST' && path === adminAccessPath) {
        if (
          req.headers.origin !== origin.origin ||
          req.headers['content-type']?.split(';')[0] !== 'application/json'
        ) {
          json(403, { error: 'Use the station’s tailnet admin page.' });
          return;
        }
        const body = (await readJson(req, 1024)) as {
          command?: unknown;
          confirm?: unknown;
          requestId?: unknown;
        } | null;
        const command = body?.command;
        const requestId = body?.requestId;
        if (
          (command !== 'mint' && command !== 'revoke') ||
          body?.confirm !== true ||
          typeof requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)
        )
          throw new BadRequest(400, 'Confirm mint or revoke. Nothing changed.');
        if (handled.has(requestId)) {
          json(409, {
            error:
              'The station already received this request, so it wasn’t repeated. A new code may already be valid; check the slip or reload status before trying again.',
          });
          return;
        }
        if (changing) {
          json(409, {
            error:
              'Another access change is still running. Nothing new was sent; wait for its result.',
          });
          return;
        }
        changing = true;
        handled.add(requestId);
        if (handled.size > 200) handled.delete(handled.values().next().value!);
        try {
          let result;
          try {
            result = await access(command);
          } catch {
            log(
              `Access ${command} from tailnet by ${device} was not confirmed.`,
            );
            json(503, {
              error:
                'The station couldn’t confirm the change. Check status before trying again. Nothing was retried.',
            });
            return;
          }
          log(`Access ${command} from tailnet by ${device}.`);
          if (result.kind === 'revoked') {
            json(200, { kind: 'revoked', revoked: result.revoked });
            return;
          }
          if (result.kind !== 'minted') throw new Error('Unexpected result.');
          let printed;
          // The code is already valid; a slip failure only means staff copy it by hand.
          try {
            const job = await slip(result.code, result.expiresAt);
            printed = {
              printed: true,
              job,
              message:
                slipMode === 'pdf'
                  ? `Slip saved as ${job}.`
                  : `Slip submitted to the printer (${job}).`,
            };
          } catch (error) {
            printed = {
              printed: false,
              message: `The slip did not print: ${(error as Error).message} The code above is valid; write it down for staff.`,
            };
          }
          json(200, {
            kind: 'minted',
            code: formatAccessCode(result.code),
            expiresAt: result.expiresAt.toISOString(),
            slip: printed,
          });
        } finally {
          changing = false;
        }
        return;
      }
      json(404, { error: 'Not found.' });
    } catch (error) {
      if (res.headersSent) res.end();
      else if (error instanceof BadRequest)
        json(error.status, { error: error.message });
      else json(503, { error: 'Admin request failed. Check the station.' });
    }
  });
}

/** Listens on a private socket; only the service user (and root's tailscaled) can connect. */
export async function listenAdmin(server: Server, socket: string) {
  const parent = await stat(dirname(socket));
  if (
    !parent.isDirectory() ||
    parent.mode & 0o077 ||
    (process.getuid && parent.uid !== process.getuid())
  )
    throw new Error(
      'The ORDER_PAD_ADMIN_SOCKET directory must exist, belong to the service user and have mode 700.',
    );
  try {
    if (!(await lstat(socket)).isSocket())
      throw new Error(
        'ORDER_PAD_ADMIN_SOCKET names a file that is not a socket.',
      );
    // The main port is already bound, so this is a stale socket, not a live service.
    await unlink(socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socket, 0o600);
}

function adminPage(nonce: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Access codes · Order Pad</title>
<style nonce="${nonce}">
:root{--olive-900:#3d3a2b;--olive-800:#4a4733;--olive-700:#5f5b40;--cream-100:#f6f1e4;--cream-200:#ede5d3;--ink-700:#2b2921;--ink-500:#55523f;--rust-600:#a3492f;--border-soft:rgba(61,58,43,.16);--focus-ring:rgba(95,91,64,.45);--radius-card:16px;--radius-input:10px;font-family:'Helvetica Neue',sans-serif;color:var(--ink-700);background:var(--cream-200)}
body{margin:0;padding:24px 16px}
main{max-width:520px;margin:0 auto;display:grid;gap:16px}
h1{margin:0;color:var(--olive-900);font-size:1.6rem}
section{background:var(--cream-100);border:1px solid var(--border-soft);border-radius:var(--radius-card);padding:16px;display:grid;gap:12px}
p{margin:0;line-height:1.5}
.muted{color:var(--ink-500)}
.actions{display:flex;flex-wrap:wrap;gap:8px}
button{min-height:44px;padding:0 16px;border-radius:var(--radius-input);border:1px solid var(--olive-700);background:var(--cream-100);color:var(--olive-900);font:inherit;font-weight:600}
button.primary{background:var(--olive-700);color:var(--cream-200)}
button.danger{border-color:var(--rust-600);color:var(--rust-600)}
button:disabled{opacity:.5}
button:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
.code{font:700 2rem/1.2 ui-monospace,monospace;letter-spacing:.08em;color:var(--olive-900)}
dialog{border:0;border-radius:var(--radius-card);padding:16px;max-width:420px;background:var(--cream-100);color:var(--ink-700)}
dialog::backdrop{background:rgba(18,16,12,.4)}
dialog .actions{margin-top:16px;justify-content:flex-end}
[hidden]{display:none!important}
</style>
</head>
<body>
<main>
<h1>Access codes</h1>
<section aria-label="Status">
<p id="status" role="status">Checking…</p>
<div class="actions">
<button type="button" class="primary" data-command="mint">Mint new code</button>
<button type="button" class="danger" data-command="revoke">Revoke code</button>
<button type="button" id="refresh">Refresh status</button>
</div>
<p class="muted">Only reachable on the station’s tailnet. Each change runs once and is never retried.</p>
</section>
<section id="result" aria-live="polite" aria-label="Result" hidden>
<div id="code-box" hidden>
<p class="muted">New access code</p>
<p class="code" id="code"></p>
<p id="expiry"></p>
</div>
<p id="message"></p>
<div class="actions"><button type="button" id="hide" hidden>Hide code</button></div>
</section>
</main>
<dialog id="confirm" aria-labelledby="confirm-title">
<h2 id="confirm-title"></h2>
<p id="confirm-text"></p>
<div class="actions">
<button type="button" id="cancel">Cancel</button>
<button type="button" class="primary" id="go"></button>
</div>
</dialog>
<script nonce="${nonce}">
const $ = (id) => document.getElementById(id);
const actions = [...document.querySelectorAll('[data-command]'), $('refresh')];
const time = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const copy = {
  mint: ['Mint a new code?', 'Minting signs out every staff device and prints a slip.', 'Mint and sign out devices', 'The station didn’t answer. A new code may already be valid, so check the slip or reload status before minting again. Nothing was retried.'],
  revoke: ['Revoke the access code?', 'Revoking signs out every staff device. Nobody can sign in until you mint a new code.', 'Revoke and sign out devices', 'The station didn’t answer. The code may already be revoked, so reload status before trying again. Nothing was retried.'],
};
let pending;
let busy = false;
const setBusy = (value) => { busy = value; for (const button of actions) button.disabled = value; };
const hideCode = () => { $('code').textContent = ''; $('expiry').textContent = ''; $('code-box').hidden = true; $('hide').hidden = true; };
async function refresh() {
  $('status').textContent = 'Checking…';
  try {
    const response = await fetch('/api/admin/access', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) { $('status').textContent = body.error ?? 'Status unavailable.'; return; }
    $('status').textContent = body.active
      ? 'Access code active until ' + time(body.expiresAt) + ' · ' + body.sessions + (body.sessions === 1 ? ' signed-in device' : ' signed-in devices')
      : 'No access code is active.';
  } catch {
    $('status').textContent = 'Status unavailable. Check the station, then refresh.';
  }
}
for (const button of document.querySelectorAll('[data-command]'))
  button.addEventListener('click', () => {
    if (busy) return;
    pending = button.dataset.command;
    $('confirm-title').textContent = copy[pending][0];
    $('confirm-text').textContent = copy[pending][1];
    $('go').textContent = copy[pending][2];
    $('confirm').showModal();
  });
$('cancel').addEventListener('click', () => $('confirm').close());
$('refresh').addEventListener('click', () => { if (!busy) refresh(); });
$('hide').addEventListener('click', hideCode);
$('go').addEventListener('click', async () => {
  $('confirm').close();
  if (busy || !pending) return;
  const command = pending;
  pending = undefined;
  setBusy(true);
  hideCode();
  $('result').hidden = false;
  $('message').textContent = command === 'mint' ? 'Minting…' : 'Revoking…';
  try {
    const response = await fetch('/api/admin/access', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, confirm: true, requestId: crypto.randomUUID() }),
      signal: AbortSignal.timeout(90000),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!body || (!response.ok && typeof body.error !== 'string')) $('message').textContent = copy[command][3];
    else if (!response.ok) $('message').textContent = body.error;
    else if (body.kind === 'minted') {
      $('code').textContent = body.code;
      $('expiry').textContent = 'Valid until ' + time(body.expiresAt) + '. The previous code and every device signed in with it have been signed out.';
      $('code-box').hidden = false;
      $('hide').hidden = false;
      $('message').textContent = body.slip.message;
    } else
      $('message').textContent = body.revoked
        ? 'The access code is void and every device signed in with it has been signed out.'
        : 'No access code was active.';
  } catch {
    $('message').textContent = copy[command][3];
  }
  setBusy(false);
  refresh();
});
refresh();
</script>
</body>
</html>
`;
}
