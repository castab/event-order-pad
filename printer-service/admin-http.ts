import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chmod, lstat, readFile, stat, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import {
  CODE_REDEEM_MINUTES,
  formatAccessCode,
  MINT_LIMIT,
  OUTSTANDING_CODE_LIMIT,
  parseMintCount,
  SESSION_HOURS,
} from '../src/lib/auth/model';
import {
  AccessRefused,
  type AccessStatus,
  type MintedCode,
  type RevokeResult,
} from './access-admin';
import { BadRequest, readJson } from './http';

export const adminAccessPath = '/api/admin/access';
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

export interface AdminAccess {
  status(): Promise<AccessStatus>;
  mint(count: number): Promise<readonly MintedCode[]>;
  revoke(target: { readonly id: string } | 'all'): Promise<RevokeResult>;
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
  access: AdminAccess;
  slip: (code: string, redeemBy: Date) => Promise<string>;
  slipMode?: 'cups' | 'pdf';
  log?: (message: string) => void;
}): Server {
  let changing = false;
  // Browsers can resend a POST whose connection closed before any reply bytes,
  // so each change carries an ID that is handled at most once.
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
          result = await access.status();
        } catch {
          json(503, {
            error: 'Database unavailable. Check Postgres on the station.',
          });
          return;
        }
        json(200, {
          unused: result.unused.map((c) => ({
            id: c.id,
            createdAt: c.createdAt.toISOString(),
            redeemBy: c.redeemBy.toISOString(),
          })),
          devices: result.devices.map((d) => ({
            id: d.id,
            device: d.device,
            signedInAt: d.signedInAt.toISOString(),
            expiresAt: d.expiresAt.toISOString(),
          })),
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
          count?: unknown;
          print?: unknown;
          target?: unknown;
          confirm?: unknown;
          requestId?: unknown;
        } | null;
        const command = body?.command;
        const target = body?.target;
        const requestId = body?.requestId;
        if (
          typeof requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)
        )
          throw new BadRequest(
            400,
            'Use the admin page’s buttons. Nothing changed.',
          );
        let count = 0;
        let print = true;
        if (command === 'mint') {
          try {
            count = parseMintCount(body?.count);
          } catch (error) {
            throw new BadRequest(400, (error as Error).message);
          }
          if (body?.print !== undefined) {
            if (typeof body.print !== 'boolean')
              throw new BadRequest(
                400,
                'Use the admin page’s buttons. Nothing changed.',
              );
            print = body.print;
          }
        } else if (
          command !== 'revoke' ||
          body?.confirm !== true ||
          (target !== 'all' &&
            (typeof target !== 'string' ||
              !/^[A-Za-z0-9-]{1,100}$/.test(target)))
        )
          throw new BadRequest(
            400,
            'Confirm which code to void or device to sign out. Nothing changed.',
          );
        if (handled.has(requestId)) {
          json(409, {
            error:
              'The station already received this request, so it wasn’t repeated. Check the printer and the lists before trying again.',
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
        const action =
          command === 'mint'
            ? `mint of ${count}${print ? '' : ' without slips'}`
            : target === 'all'
              ? 'revoke of everything'
              : 'revoke of one code';
        try {
          if (command === 'revoke') {
            let result;
            try {
              result = await access.revoke(
                target === 'all' ? 'all' : { id: target as string },
              );
            } catch {
              log(
                `Access ${action} from tailnet by ${device} was not confirmed.`,
              );
              json(503, {
                error:
                  'The station couldn’t confirm the change. Check the lists before trying again. Nothing was retried.',
              });
              return;
            }
            if (result.kind === 'gone') {
              json(409, {
                error:
                  'That code is no longer active. It may have been used up, expired or voided already. Nothing changed.',
              });
              return;
            }
            log(`Access ${action} from tailnet by ${device}.`);
            json(200, result);
            return;
          }
          let codes;
          try {
            codes = await access.mint(count);
          } catch (error) {
            if (error instanceof AccessRefused) {
              json(409, { error: error.message });
              return;
            }
            log(
              `Access ${action} from tailnet by ${device} was not confirmed.`,
            );
            json(503, {
              error:
                'The station couldn’t confirm the change. Some codes may already be valid. Check the unused codes before trying again. Nothing was retried.',
            });
            return;
          }
          log(`Access ${action} from tailnet by ${device}.`);
          // The codes are already valid; a slip failure only means staff copy one by hand.
          const printed: { printed: boolean; job?: string; message: string }[] =
            [];
          let failed = false;
          for (const { code, redeemBy } of print ? codes : []) {
            if (failed) {
              printed.push({
                printed: false,
                message:
                  'Not printed, because an earlier slip failed. This code still works, so write it down for staff.',
              });
              continue;
            }
            try {
              const job = await slip(code, redeemBy);
              printed.push({
                printed: true,
                job,
                message:
                  slipMode === 'pdf'
                    ? `Slip saved as ${job}.`
                    : `Slip submitted to the printer (${job}).`,
              });
            } catch (error) {
              failed = true;
              printed.push({
                printed: false,
                message: `The slip didn’t print: ${(error as Error).message} This code still works, so write it down for staff.`,
              });
            }
          }
          json(200, {
            kind: 'minted',
            codes: codes.map((c, index) => ({
              code: formatAccessCode(c.code),
              redeemBy: c.redeemBy.toISOString(),
              ...(print && { slip: printed[index] }),
            })),
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
.eyebrow{font:600 12px/1.4 var(--font-sans);letter-spacing:.26em;text-transform:uppercase;color:var(--ink-500)}
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
.mint{display:flex;flex-direction:column;gap:10px}
.mint label{font:600 15px/1.45 var(--font-sans);color:var(--olive-900)}
.mint-row{display:flex;gap:10px;align-items:stretch}
.count{width:88px;min-height:52px;flex-shrink:0;border:2px solid var(--olive-300);border-radius:var(--radius-input);background:var(--cream-200);color:var(--olive-900);text-align:center;font:700 26px/1 var(--font-sans)}
.count:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px;border-color:var(--olive-700)}
.mint-row button{flex:1 1 auto;min-width:0}
.print-option{display:flex;align-items:center;gap:12px;min-height:44px;font:600 15px/1.45 var(--font-sans);color:var(--olive-900)}
.print-option input{width:24px;height:24px;flex-shrink:0;margin:0;accent-color:var(--olive-700)}
.print-option input:focus-visible{outline:3px solid var(--focus-ring);outline-offset:2px}
.codes,.items{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.minted{display:flex;flex-direction:column;gap:10px;padding-bottom:12px;border-bottom:1px solid var(--cream-300)}
.minted:last-child{padding-bottom:0;border-bottom:0}
.minted-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.item{padding:12px 14px;border-radius:var(--radius-input);background:var(--cream-200);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.who{display:flex;flex-direction:column;gap:2px;min-width:0}
.who .name{font:600 15px/1.4 var(--font-sans);color:var(--olive-900);overflow-wrap:anywhere}
#everyone{align-self:flex-start}
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
<section class="card" aria-labelledby="mint-title">
<div class="top">
<span id="badge" class="badge">Checking</span>
<button type="button" class="link" id="refresh"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>Check again</button>
</div>
<div class="status" role="status">
<h2 id="mint-title">Mint access codes</h2>
<p class="detail" id="detail">Each code signs in one device for ${SESSION_HOURS} hours. It works once and must be used within ${CODE_REDEEM_MINUTES} minutes.</p>
<p class="small" id="checked"></p>
</div>
<form class="mint" id="mint-form" novalidate>
<label for="count">How many access codes would you like to mint?</label>
<div class="mint-row">
<input id="count" class="count" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="1" autocomplete="off" value="1" aria-describedby="count-hint">
<button type="submit" class="primary large" id="mint" disabled>Mint 1 code</button>
</div>
<label class="print-option" for="print"><input type="checkbox" id="print" checked>Print a slip for each code</label>
<p class="small" id="count-hint">From 1 to ${MINT_LIMIT} at a time, with up to ${OUTSTANDING_CODE_LIMIT} unused at once. Slips print unless you turn them off.</p>
</form>
<div class="actions"><button type="button" class="primary large" id="retry" hidden>Try again</button></div>
</section>
<section class="card" id="codes-card" aria-labelledby="codes-title" hidden>
<h2 class="eyebrow" id="codes-title">New access codes</h2>
<ul class="codes" id="codes"></ul>
<div class="row"><button type="button" class="ghost" id="hide">Hide codes</button></div>
</section>
<p class="note notice" id="notice" hidden></p>
<section class="alert" id="alert" role="alert" hidden>
<span class="alert-title"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/></svg><span id="alert-title"></span></span>
<p class="body" id="alert-text"></p>
<button type="button" class="danger-solid" id="check-status">Check status</button>
</section>
<section class="card" id="unused-card" aria-labelledby="unused-title" hidden>
<div class="top">
<h2 class="eyebrow" id="unused-title">Unused codes</h2>
<span id="unused-count" class="badge">None</span>
</div>
<ul class="items" id="unused"></ul>
<p class="small" id="no-unused">No unused codes. Mint one for each device that needs to sign in.</p>
</section>
<section class="card" id="devices-card" aria-labelledby="devices-title" hidden>
<div class="top">
<h2 class="eyebrow" id="devices-title">Signed-in devices</h2>
<span id="devices-count" class="badge">None</span>
</div>
<ul class="items" id="devices"></ul>
<p class="small" id="no-devices">No devices are signed in.</p>
<button type="button" class="danger" id="everyone" hidden>Sign out everyone</button>
</section>
<p class="footnote"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>Only admin-tagged devices on the station’s tailnet can open this page. Each change runs once and is never retried. Voiding a code or signing a device out asks first.</p>
</div>
</main>
<dialog id="confirm" aria-labelledby="confirm-title">
<form method="dialog">
<h2 id="confirm-title"></h2>
<p class="detail" id="confirm-text"></p>
<p class="devices" id="confirm-devices" hidden></p>
<div class="row">
<button type="button" class="ghost" id="cancel">Cancel</button>
<button type="button" class="danger-solid" id="go"></button>
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
const limit = ${MINT_LIMIT};
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const clock = (date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const time = (iso) => {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? clock(date) : date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
const left = (iso) => {
  const minutes = Math.floor((Date.parse(iso) - Date.now()) / 60000);
  if (minutes < 1) return 'under 1 min';
  return minutes < 60 ? minutes + ' min' : Math.floor(minutes / 60) + ' h' + (minutes % 60 ? ' ' + (minutes % 60) + ' min' : '');
};
const withIcon = (element, icon, text) => { element.innerHTML = icons[icon]; const span = document.createElement('span'); span.textContent = text; element.append(span); };
const element = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const lost = {
  mint: 'Some codes may already be valid. Nothing was retried. Check the printer and the unused codes before minting again.',
  revoke: 'The change may already have happened. Nothing was retried. Check the lists before trying again.',
};
let state = { kind: 'loading' };
let busy;
let pending;
function count() {
  const n = Number($('count').value);
  return Number.isInteger(n) && n >= 1 && n <= limit ? n : 0;
}
function render() {
  const s = state;
  const ready = s.kind === 'ready';
  const badge = $('badge');
  badge.className = 'badge' + (busy ? ' busy' : ready ? ' active' : s.kind === 'unavailable' ? ' unavailable' : '');
  badge.textContent = busy === 'mint' ? 'Minting' : busy === 'revoke' ? 'Signing out' : ready ? plural(s.devices.length, 'device') + ' signed in' : s.kind === 'unavailable' ? 'Can’t reach the station' : 'Checking';
  $('checked').textContent = busy ? 'Wait for the result. Don’t close this page.'
    : s.kind === 'unavailable' ? s.error
    : s.checkedAt ? 'Checked ' + clock(s.checkedAt) + '.' : '';
  $('mint-form').hidden = s.kind === 'unavailable';
  $('retry').hidden = s.kind !== 'unavailable';
  const n = count();
  $('mint').textContent = busy === 'mint' ? 'Minting…' : n ? 'Mint ' + plural(n, 'code') : 'Mint codes';
  $('mint').disabled = !!busy || !ready || !n;
  $('count').disabled = !!busy;
  $('print').disabled = !!busy;
  for (const id of ['refresh', 'retry', 'check-status', 'everyone']) $(id).disabled = !!busy;
  $('unused-card').hidden = $('devices-card').hidden = !ready;
  if (!ready) return;
  list($('unused'), s.unused, (code) => [
    'Minted ' + clock(new Date(code.createdAt)),
    'Use by ' + time(code.redeemBy) + ' · ' + left(code.redeemBy) + ' left',
  ], 'Void', (code) => ask({ id: code.id, kind: 'code', when: clock(new Date(code.createdAt)) }));
  $('no-unused').hidden = s.unused.length > 0;
  $('unused-count').textContent = s.unused.length ? String(s.unused.length) : 'None';
  list($('devices'), s.devices, (device) => [
    device.device,
    'Signed in ' + clock(new Date(device.signedInAt)) + ' · until ' + time(device.expiresAt),
  ], 'Sign out', (device) => ask({ id: device.id, kind: 'device', name: device.device }));
  $('no-devices').hidden = s.devices.length > 0;
  $('devices-count').textContent = s.devices.length ? String(s.devices.length) : 'None';
  $('everyone').hidden = !s.unused.length && !s.devices.length;
}
function list(container, items, lines, label, action) {
  container.replaceChildren(...items.map((item) => {
    const row = element('li', 'item');
    const [name, detail] = lines(item);
    const who = element('span', 'who');
    who.append(element('span', 'name', name), element('span', 'small', detail));
    const button = element('button', 'danger', label);
    button.type = 'button';
    button.setAttribute('aria-label', label + ': ' + name);
    button.disabled = !!busy;
    button.addEventListener('click', () => action(item));
    row.append(who, button);
    return row;
  }));
}
async function refresh() {
  if (busy) return;
  try {
    const response = await fetch('/api/admin/access', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '');
    state = { kind: 'ready', unused: Array.isArray(body.unused) ? body.unused : [], devices: Array.isArray(body.devices) ? body.devices : [] };
  } catch (error) {
    state = { kind: 'unavailable', error: error.message || 'Check that the station and its database are running, then check again.' };
  }
  state.checkedAt = new Date();
  render();
}
function hideCodes() {
  $('codes').replaceChildren();
  $('codes-card').hidden = true;
}
function showCodes(codes) {
  $('codes').replaceChildren(...codes.map((minted) => {
    const row = element('li', 'minted');
    const box = element('div', 'code-box');
    const code = element('span', 'code');
    const [first, second] = minted.code.split('-');
    code.append(first, element('span', 'dash', '-'), second);
    box.append(code);
    // No slip means staff chose not to print; nothing was sent to the printer.
    const slip = element('p', 'note' + (!minted.slip || minted.slip.printed ? '' : ' failed'));
    if (minted.slip) {
      slip.setAttribute('role', minted.slip.printed ? 'status' : 'alert');
      withIcon(slip, minted.slip.printed ? 'printer' : 'alert', minted.slip.message);
    } else slip.textContent = 'No slip printed, as you chose.';
    const copy = element('button', 'secondary', 'Copy code');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy code ' + minted.code);
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(minted.code);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Couldn’t copy';
      }
    });
    const footer = element('div', 'minted-footer');
    footer.append(element('span', 'expiry', 'Use by ' + time(minted.redeemBy)), copy);
    row.append(box, footer, slip);
    return row;
  }));
  $('codes-card').hidden = false;
}
function showAlert(title, text) {
  $('alert-title').textContent = title;
  $('alert-text').textContent = text;
  $('alert').hidden = false;
}
function ask(target) {
  if (busy || state.kind !== 'ready') return;
  pending = target;
  const everyone = target === 'all';
  $('confirm-title').textContent = everyone ? 'Sign out everyone?' : target.kind === 'device' ? 'Sign out this device?' : 'Void this code?';
  $('confirm-text').textContent = everyone ? 'Nobody can sign in again until you mint new codes.'
    : target.kind === 'device' ? 'It goes back to the sign-in screen and needs a new code to return. Anything it was saving or printing finishes first.'
    : 'The code minted at ' + target.when + ' stops working. Throw its slip away.';
  $('confirm-devices').hidden = !everyone && target.kind !== 'device';
  $('confirm-devices').textContent = everyone
    ? plural(state.unused.length, 'unused code') + ' will be voided and ' + plural(state.devices.length, 'device') + ' signed out.'
    : target.name || '';
  $('go').textContent = everyone ? 'Sign out everyone' : target.kind === 'device' ? 'Sign out' : 'Void code';
  $('confirm').showModal();
}
async function change(command, payload) {
  busy = command;
  $('notice').hidden = true;
  $('alert').hidden = true;
  render();
  try {
    const response = await fetch('/api/admin/access', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command, ...payload, requestId: crypto.randomUUID() }),
      // Up to ${MINT_LIMIT} slips may each wait for the printer.
      signal: AbortSignal.timeout(command === 'mint' ? 240000 : 30000),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!body || (!response.ok && typeof body.error !== 'string')) showAlert('The station didn’t answer', lost[command]);
    else if (!response.ok) showAlert('Check before trying again', body.error);
    else if (body.kind === 'minted') showCodes(body.codes);
    else {
      withIcon($('notice'), 'check', [
        body.voided ? 'Voided ' + plural(body.voided, 'unused code') + '.' : '',
        body.signedOut ? 'Signed out ' + plural(body.signedOut, 'device') + '.' : '',
      ].filter(Boolean).join(' ') || 'Done.');
      $('notice').hidden = false;
    }
  } catch {
    showAlert('The station didn’t answer', lost[command]);
  }
  busy = undefined;
  render();
  refresh();
}
$('count').addEventListener('input', () => {
  const digits = $('count').value.replace(/[^0-9]/g, '');
  $('count').value = digits ? String(Math.min(limit, Math.max(1, Number(digits)))) : '';
  render();
});
$('mint-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const n = count();
  if (!busy && n && state.kind === 'ready') {
    hideCodes();
    change('mint', { count: n, print: $('print').checked });
  }
});
$('everyone').addEventListener('click', () => ask('all'));
$('cancel').addEventListener('click', () => $('confirm').close());
for (const id of ['refresh', 'retry', 'check-status'])
  $(id).addEventListener('click', () => { $('alert').hidden = true; refresh(); });
$('hide').addEventListener('click', hideCodes);
$('go').addEventListener('click', () => {
  $('confirm').close();
  if (busy || !pending) return;
  const target = pending === 'all' ? 'all' : pending.id;
  pending = undefined;
  change('revoke', { target, confirm: true });
});
render();
refresh();
// Sign-ins on other devices show up without a tap while the page is open.
setInterval(() => {
  if (document.visibilityState === 'visible' && !busy && !$('confirm').open) refresh();
}, 10000);
</script>
</body>
</html>
`;
}
