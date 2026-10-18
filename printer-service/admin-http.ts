import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, lstat, readFile, stat, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { formatAccessCode } from '../src/lib/auth/model';
import type { AccessResult } from './access-admin';
import { BadRequest, readJson } from './http';

export const adminAccessPath = '/api/admin/access';
type AccessCommand = 'mint' | 'status' | 'revoke';
// The page shares the app's self-hosted logo and font, read from the static build.
const pageAssets: Record<string, string> = {
  '/logo.svg': 'image/svg+xml',
  ...Object.fromEntries(
    [400, 500, 600, 700].map((weight) => [
      `/fonts/poppins-${weight}.ttf`,
      'font/ttf',
    ]),
  ),
};

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
  assets,
  log = console.log,
}: {
  origin: URL;
  capability: string;
  assets?: string;
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
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
        const page = Buffer.from(adminPage(nonce, origin.host));
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': page.length,
        });
        res.end(req.method === 'HEAD' ? undefined : page);
        return;
      }
      if (
        ['GET', 'HEAD'].includes(req.method ?? '') &&
        assets &&
        Object.hasOwn(pageAssets, path)
      ) {
        let file;
        try {
          file = await readFile(join(assets, path));
        } catch {
          json(404, { error: 'Not found.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': pageAssets[path],
          'Content-Length': file.length,
        });
        res.end(req.method === 'HEAD' ? undefined : file);
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
            json(200, {
              kind: 'revoked',
              revoked: result.revoked,
              signedOut: result.signedOut,
            });
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
              message: `The slip didn’t print: ${(error as Error).message} The code above still works, so write it down for staff.`,
            };
          }
          json(200, {
            kind: 'minted',
            code: formatAccessCode(result.code),
            expiresAt: result.expiresAt.toISOString(),
            signedOut: result.signedOut,
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

function adminPage(nonce: string, host: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Access codes · Order Pad</title>
<style nonce="${nonce}">
@font-face{font-family:Poppins;src:url('/fonts/poppins-400.ttf') format('truetype');font-weight:400;font-display:swap}
@font-face{font-family:Poppins;src:url('/fonts/poppins-500.ttf') format('truetype');font-weight:500;font-display:swap}
@font-face{font-family:Poppins;src:url('/fonts/poppins-600.ttf') format('truetype');font-weight:600;font-display:swap}
@font-face{font-family:Poppins;src:url('/fonts/poppins-700.ttf') format('truetype');font-weight:700;font-display:swap}
:root{--olive-900:#3d3a2b;--olive-800:#4a4733;--olive-700:#5f5b40;--olive-300:#aaa68e;--olive-100:#d9d6c6;--cream-100:#f6f1e4;--cream-200:#ede5d3;--cream-300:#e2d8c3;--paper-100:#ddd6cc;--ink-700:#2b2921;--ink-500:#55523f;--rust-600:#a3492f;--moss-600:#6b7a4a;--alert-bg:#f3e0d8;--alert-ink:#6e2d1b;--focus-ring:rgba(95,91,64,.45);--shadow-card:0 2px 6px rgba(61,58,43,.08),0 12px 28px rgba(61,58,43,.1);--radius-card:16px;--radius-input:10px;--font-sans:'Poppins','Helvetica Neue',sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-family:var(--font-sans);color:var(--ink-700);background:var(--cream-200)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column}
header{height:64px;flex-shrink:0;padding:0 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--olive-700)}
.brand{display:flex;align-items:center;gap:14px}
.brand img{display:block;height:30px;width:auto}
.divider{width:1px;height:26px;background:rgba(237,229,211,.3)}
h1{margin:0;font:600 13px/1 var(--font-sans);letter-spacing:.24em;text-transform:uppercase;color:var(--cream-200)}
.host{display:none;font:500 13px/1 var(--font-sans);color:var(--cream-300)}
main{flex-grow:1;padding:24px 16px 32px}
.column{max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{padding:20px;border-radius:var(--radius-card);background:var(--cream-100);box-shadow:var(--shadow-card);display:flex;flex-direction:column;gap:16px}
.top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;padding:4px 12px;border-radius:999px;font:600 12px/1.4 var(--font-sans);letter-spacing:.13em;text-transform:uppercase;background:var(--olive-100);color:var(--olive-900)}
.badge.active{background:var(--moss-600);color:var(--cream-100)}
.badge.unavailable{background:var(--rust-600);color:var(--cream-100)}
.badge.busy{background:var(--olive-700);color:var(--cream-200)}
.status{display:flex;flex-direction:column;gap:6px}
h2{margin:0;color:var(--olive-900)}
.status h2{font:700 26px/1.2 var(--font-sans);letter-spacing:-.015em}
p{margin:0}
.detail{font:400 15px/1.55 var(--font-sans)}
.small{font:400 13px/1.5 var(--font-sans);color:var(--ink-500)}
.stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.stat{padding:12px 14px;border-radius:var(--radius-input);background:var(--cream-200);display:flex;flex-direction:column;gap:4px}
.stat span:first-child{font:600 11px/1.3 var(--font-sans);letter-spacing:.2em;text-transform:uppercase;color:var(--ink-500)}
.stat span:last-child{font:700 22px/1.2 var(--font-sans);color:var(--olive-900)}
.actions{display:flex;flex-wrap:wrap;gap:10px}
.actions>*{flex:1 1 220px;min-width:0}
.row{display:flex;flex-wrap:wrap;gap:8px}
button{min-height:44px;padding:0 20px;border:2px solid transparent;border-radius:999px;display:inline-flex;align-items:center;justify-content:center;gap:6px;font:600 12px/1 var(--font-sans);letter-spacing:.13em;text-transform:uppercase;cursor:pointer;background:transparent;color:var(--olive-800)}
button:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
button:disabled{opacity:.45;cursor:default}
button.primary{background:var(--olive-700);color:var(--cream-200)}
button.primary:hover:not(:disabled){background:var(--olive-800)}
button.secondary{border-color:var(--olive-700)}
button.secondary:hover:not(:disabled),button.ghost:hover:not(:disabled){background:var(--olive-100)}
button.danger{border-color:var(--rust-600);color:var(--rust-600)}
button.danger-solid{background:var(--rust-600);color:var(--cream-100)}
button.large{min-height:52px;font-size:14px}
button.link{padding:0 10px;font-size:13px;letter-spacing:0;text-transform:none}
.code-card h2,.eyebrow{font:600 12px/1.4 var(--font-sans);letter-spacing:.26em;text-transform:uppercase;color:var(--ink-500)}
.code-box{padding:18px 12px;border-radius:var(--radius-input);border:2px dashed var(--olive-300);background:var(--cream-200);display:flex;justify-content:center}
.code{font:700 34px/1.1 var(--font-mono);letter-spacing:.12em;color:var(--olive-900);overflow-wrap:anywhere;text-align:center}
.code .dash{color:var(--olive-300);padding:0 4px}
.expiry{font:500 15px/1.5 var(--font-sans);color:var(--olive-900)}
.body{font:400 14px/1.55 var(--font-sans)}
.note{padding:10px 12px;border-radius:var(--radius-input);display:flex;gap:10px;align-items:flex-start;font:500 14px/1.5 var(--font-sans);background:var(--olive-100);color:var(--olive-900)}
.note svg,.footnote svg,.alert-title svg{flex-shrink:0;margin-top:1px}
.note.failed{background:var(--alert-bg);border:1.5px solid var(--rust-600);color:var(--alert-ink)}
.note.failed svg{color:var(--rust-600)}
.notice{padding:14px 16px;border-radius:var(--radius-card);font-size:15px}
.alert{padding:18px;border-radius:var(--radius-card);background:var(--alert-bg);border:1.5px solid var(--rust-600);display:flex;flex-direction:column;gap:12px;color:var(--alert-ink)}
.alert-title{display:flex;gap:10px;align-items:center;font:700 17px/1.3 var(--font-sans);color:var(--alert-ink)}
.alert-title svg{color:var(--rust-600)}
.alert button{align-self:flex-start}
.footnote{margin:4px 4px 0;display:flex;gap:8px;align-items:flex-start;font:400 13px/1.55 var(--font-sans);color:var(--ink-500)}
.footnote svg{margin-top:3px}
dialog{width:calc(100% - 32px);max-width:420px;border:0;border-radius:var(--radius-card);padding:24px;background:var(--cream-100);color:var(--ink-700);box-shadow:var(--shadow-card)}
dialog::backdrop{background:rgba(18,16,12,.45)}
dialog h2{font:700 22px/1.25 var(--font-sans)}
dialog form{display:flex;flex-direction:column;gap:14px}
dialog .detail{margin:0}
.devices{padding:10px 12px;border-radius:var(--radius-input);background:var(--paper-100);font:600 14px/1.45 var(--font-sans)}
dialog .row{justify-content:flex-end;margin-top:4px}
[hidden]{display:none!important}
@media (min-width:640px){.host{display:inline}}
</style>
</head>
<body>
<header>
<span class="brand"><img src="/logo.svg" alt="Fiona’s Ice Cream" width="56" height="30"><span class="divider" aria-hidden="true"></span><h1>Access codes</h1></span>
<span class="host">${host}</span>
</header>
<main>
<div class="column">
<section class="card" aria-labelledby="status-title">
<div class="top">
<span id="badge" class="badge">Checking</span>
<button type="button" class="link" id="refresh"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>Check again</button>
</div>
<div class="status" role="status">
<h2 id="status-title">Checking status…</h2>
<p class="detail" id="detail"></p>
<p class="small" id="checked"></p>
</div>
<div class="stats" id="stats" hidden>
<div class="stat"><span>Time left</span><span id="time-left"></span></div>
<div class="stat"><span>Signed in</span><span id="devices"></span></div>
</div>
<div class="actions">
<button type="button" class="primary large" id="mint" disabled>Mint a code</button>
<button type="button" class="danger large" id="revoke" hidden>Revoke code</button>
<button type="button" class="primary large" id="retry" hidden>Try again</button>
</div>
</section>
<section class="card code-card" id="code-card" aria-labelledby="code-title" hidden>
<h2 id="code-title">New access code</h2>
<div class="code-box"><span class="code" id="code"></span></div>
<p class="expiry" id="expiry"></p>
<p class="body" id="replaced"></p>
<p class="note" id="slip"></p>
<div class="row">
<button type="button" class="secondary" id="copy">Copy code</button>
<button type="button" class="ghost" id="hide">Hide code</button>
</div>
</section>
<p class="note notice" id="notice" hidden></p>
<section class="alert" id="alert" role="alert" hidden>
<span class="alert-title"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/></svg><span id="alert-title"></span></span>
<p class="body" id="alert-text"></p>
<button type="button" class="danger-solid" id="check-status">Check status</button>
</section>
<p class="footnote"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>Only admin-tagged devices on the station’s tailnet can open this page. Each change asks first, runs once and is never retried.</p>
</div>
</main>
<dialog id="confirm" aria-labelledby="confirm-title">
<form method="dialog">
<h2 id="confirm-title"></h2>
<p class="detail" id="confirm-text"></p>
<p class="devices" id="confirm-devices" hidden></p>
<div class="row">
<button type="button" class="ghost" id="cancel">Cancel</button>
<button type="button" id="go"></button>
</div>
</form>
</dialog>
<script nonce="${nonce}">
const $ = (id) => document.getElementById(id);
const icons = {
  printer: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/></svg>',
  alert: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
  check: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};
const buttons = ['refresh', 'mint', 'revoke', 'retry', 'check-status'].map($);
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const clock = (date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const time = (iso) => {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? clock(date) : date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
const left = (iso) => {
  const minutes = Math.floor((Date.parse(iso) - Date.now()) / 60000);
  if (minutes < 1) return 'Under 1 min';
  return minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h' + (minutes % 60 ? ' ' + (minutes % 60) + ' min' : '');
};
const withIcon = (element, icon, text) => { element.innerHTML = icons[icon]; const span = document.createElement('span'); span.textContent = text; element.append(span); };
const lost = {
  mint: 'A new code may already be valid. Nothing was retried. Check the printer for a slip and check status before minting again.',
  revoke: 'The code may already be revoked. Nothing was retried. Check status before trying again.',
};
let state = { kind: 'loading' };
let busy;
let pending;
let shownCode = '';
function render() {
  const s = state;
  const active = s.kind === 'active';
  const badge = $('badge');
  badge.className = 'badge' + (busy ? ' busy' : active ? ' active' : s.kind === 'unavailable' ? ' unavailable' : '');
  badge.textContent = busy === 'mint' ? 'Minting' : busy === 'revoke' ? 'Revoking' : active ? 'Active' : s.kind === 'none' ? 'No code' : s.kind === 'unavailable' ? 'Can’t reach the station' : 'Checking';
  $('status-title').textContent = busy === 'mint' ? 'Minting a new code…' : busy === 'revoke' ? 'Revoking the code…'
    : active ? 'Code works until ' + time(s.expiresAt) : s.kind === 'none' ? 'No code is active' : s.kind === 'unavailable' ? 'Couldn’t read the status' : 'Checking status…';
  $('detail').textContent = busy ? 'Wait for the result. Don’t close this page.'
    : active ? 'Staff sign in with it on any order pad. It ends on its own after 8 hours.'
    : s.kind === 'none' ? 'Nobody can sign in until you mint a code.'
    : s.kind === 'unavailable' ? s.error : '';
  $('checked').textContent = s.checkedAt ? 'Status checked ' + clock(s.checkedAt) + '.' : '';
  $('stats').hidden = !active || !!busy;
  if (active) { $('time-left').textContent = left(s.expiresAt); $('devices').textContent = plural(s.sessions, 'device'); }
  $('mint').hidden = s.kind === 'unavailable';
  $('mint').textContent = active ? 'Replace code' : 'Mint a code';
  $('revoke').hidden = !active;
  $('retry').hidden = s.kind !== 'unavailable';
  for (const button of buttons) button.disabled = !!busy;
  $('mint').disabled = !!busy || s.kind === 'loading';
}
async function refresh() {
  if (busy) return;
  try {
    const response = await fetch('/api/admin/access', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '');
    state = body.active ? { kind: 'active', expiresAt: body.expiresAt, sessions: body.sessions } : { kind: 'none' };
  } catch (error) {
    state = { kind: 'unavailable', error: error.message || 'Check that the station and its database are running, then check again.' };
  }
  state.checkedAt = new Date();
  render();
}
function hideCode() {
  shownCode = '';
  $('code').textContent = '';
  $('code-card').hidden = true;
}
function showCode(body) {
  shownCode = body.code;
  const [first, second] = body.code.split('-');
  const dash = document.createElement('span');
  dash.className = 'dash';
  dash.textContent = '-';
  $('code').replaceChildren(first, dash, second);
  $('expiry').textContent = 'Works until ' + time(body.expiresAt) + ' (8 hours).';
  $('replaced').textContent = body.signedOut > 0
    ? 'The old code stopped working and ' + plural(body.signedOut, 'device') + ' signed in with it ' + (body.signedOut === 1 ? 'was' : 'were') + ' signed out.'
    : 'Any previous code stopped working. Hand this one to staff or let them read it off the slip.';
  $('slip').className = 'note' + (body.slip.printed ? '' : ' failed');
  $('slip').setAttribute('role', body.slip.printed ? 'status' : 'alert');
  withIcon($('slip'), body.slip.printed ? 'printer' : 'alert', body.slip.message);
  $('copy').textContent = 'Copy code';
  $('code-card').hidden = false;
}
function showAlert(title, text) {
  $('alert-title').textContent = title;
  $('alert-text').textContent = text;
  $('alert').hidden = false;
}
function ask(command) {
  if (busy) return;
  pending = command;
  const active = state.kind === 'active';
  const revoke = command === 'revoke';
  $('confirm-title').textContent = revoke ? 'Revoke the access code?' : active ? 'Replace the access code?' : 'Mint an access code?';
  $('confirm-text').textContent = revoke ? 'Nobody can sign in until you mint a new code.'
    : active ? 'A new code works for 8 hours and prints a slip. The current code stops working right away.'
    : 'It works for 8 hours and prints a slip for staff.';
  $('confirm-devices').hidden = !active || !state.sessions;
  $('confirm-devices').textContent = active ? plural(state.sessions, 'device') + ' signed in now will be signed out.' : '';
  $('go').className = revoke ? 'danger-solid' : 'primary';
  $('go').textContent = revoke ? 'Revoke and sign out' : active ? 'Replace code' : 'Mint code';
  $('confirm').showModal();
}
$('mint').addEventListener('click', () => ask('mint'));
$('revoke').addEventListener('click', () => ask('revoke'));
$('cancel').addEventListener('click', () => $('confirm').close());
for (const id of ['refresh', 'retry', 'check-status'])
  $(id).addEventListener('click', () => { $('alert').hidden = true; refresh(); });
$('hide').addEventListener('click', hideCode);
$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shownCode);
    $('copy').textContent = 'Copied';
  } catch {
    $('copy').textContent = 'Couldn’t copy';
  }
});
$('go').addEventListener('click', async () => {
  $('confirm').close();
  if (busy || !pending) return;
  const command = pending;
  pending = undefined;
  busy = command;
  hideCode();
  $('notice').hidden = true;
  $('alert').hidden = true;
  render();
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
    if (!body || (!response.ok && typeof body.error !== 'string')) showAlert('The station didn’t answer', lost[command]);
    else if (!response.ok) showAlert('Check before trying again', body.error);
    else if (body.kind === 'minted') showCode(body);
    else {
      withIcon($('notice'), 'check', body.revoked
        ? 'Code revoked. ' + plural(body.signedOut, 'device') + ' signed out. Nobody can sign in until you mint a new code.'
        : 'No access code was active, so nothing changed.');
      $('notice').hidden = false;
    }
  } catch {
    showAlert('The station didn’t answer', lost[command]);
  }
  busy = undefined;
  render();
  refresh();
});
render();
refresh();
</script>
</body>
</html>
`;
}
