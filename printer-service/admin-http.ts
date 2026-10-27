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
import { adminDocument } from './admin-page';
import { menuPage } from './admin-menu-page';
import type { MenuStore } from './menu-database';
import {
  MenuConflict,
  MenuRefused,
  menuBody,
  parseMenuChange,
  type MenuChange,
} from '../src/lib/tickets/menu';

export const adminAccessPath = '/api/admin/access';
export const adminMenuPath = '/api/admin/menu';
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

export type AdminMenu = Pick<MenuStore, 'load' | 'change'>;

function describeChange(change: MenuChange) {
  switch (change.command) {
    case 'add':
      return `add of “${change.displayName}” (${change.category})`;
    case 'edit':
      return `edit of ${change.id} to “${change.displayName}”`;
    case 'remove':
      return `removal of ${change.id}`;
    case 'move':
      return `move of ${change.id} ${change.direction}`;
  }
}

/**
 * Tailnet-only access-code and menu administration. Tailscale Serve forwards the
 * device's granted app capabilities and strips client copies; only devices the
 * tailnet policy grants `capability` on the exact admin origin get through, and
 * a change is never retried or run twice at once.
 */
export function createAdminApp({
  origin,
  capability,
  access,
  menu,
  slip,
  slipMode = 'cups',
  assets,
  log = console.log,
}: {
  origin: URL;
  capability: string;
  assets?: string;
  access: AdminAccess;
  menu: AdminMenu;
  slip: (code: string, redeemBy: Date) => Promise<string>;
  slipMode?: 'cups' | 'pdf';
  log?: (message: string) => void;
}): Server {
  let changing = false;
  let changingMenu = false;
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
    const sameOrigin = () => {
      if (
        req.headers.origin === origin.origin &&
        req.headers['content-type']?.split(';')[0] === 'application/json'
      )
        return true;
      json(403, { error: 'Use the station’s tailnet admin page.' });
      return false;
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
      json(403, { error: 'This device can’t manage the station.' });
      return;
    }
    try {
      const path = new URL(req.url ?? '/', origin).pathname;
      if (
        ['GET', 'HEAD'].includes(req.method ?? '') &&
        (path === '/' || path === '/menu')
      ) {
        const page = Buffer.from(
          path === '/'
            ? adminPage(nonce, origin.host)
            : menuPage(nonce, origin.host),
        );
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
        if (!sameOrigin()) return;
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
      if (req.method === 'GET' && path === adminMenuPath) {
        let current;
        try {
          current = await menu.load();
        } catch {
          json(503, {
            error: 'Database unavailable. Check Postgres on the station.',
          });
          return;
        }
        json(200, menuBody(current));
        return;
      }
      if (req.method === 'POST' && path === adminMenuPath) {
        if (!sameOrigin()) return;
        const body = (await readJson(req, 4096)) as {
          requestId?: unknown;
        } | null;
        const requestId = body?.requestId;
        if (
          typeof requestId !== 'string' ||
          !/^[A-Za-z0-9_-]{16,100}$/.test(requestId)
        )
          throw new BadRequest(
            400,
            'Use the menu page’s buttons. Nothing changed.',
          );
        let change;
        try {
          change = parseMenuChange(body);
        } catch (error) {
          throw new BadRequest(
            400,
            `${(error as Error).message} Nothing changed.`,
          );
        }
        if (handled.has(requestId)) {
          json(409, {
            error:
              'The station already received this request, so it wasn’t repeated. Check the menu before trying again.',
          });
          return;
        }
        if (changingMenu) {
          json(409, {
            error:
              'Another menu change is still running. Nothing new was sent; wait for its result.',
          });
          return;
        }
        changingMenu = true;
        handled.add(requestId);
        if (handled.size > 200) handled.delete(handled.values().next().value!);
        const action = describeChange(change);
        try {
          let result;
          try {
            result = await menu.change(change, change.revision);
          } catch (error) {
            if (error instanceof MenuConflict || error instanceof MenuRefused) {
              json(409, { error: error.message });
              return;
            }
            log(`Menu ${action} from tailnet by ${device} was not confirmed.`);
            json(503, {
              error:
                'The station couldn’t confirm the change. Check the menu before trying again. Nothing was retried.',
            });
            return;
          }
          log(`Menu ${action} from tailnet by ${device}.`);
          json(200, menuBody(result));
        } finally {
          changingMenu = false;
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
  return adminDocument({
    nonce,
    host,
    title: 'Access codes',
    body: `<main>
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
`,
    script: `const $ = (id) => document.getElementById(id);
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
`,
  });
}
