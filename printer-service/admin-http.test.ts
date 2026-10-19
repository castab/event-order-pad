import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  adminAccessPath,
  adminRequestsPath,
  createAdminApp,
  listenAdmin,
} from './admin-http';
import type {
  AccessResult,
  DecisionResult,
  SignInDecision,
} from './access-admin';

const origin = new URL('https://station.example.ts.net:8443');
const host = origin.host;
const capability = 'fionasicecream.com/cap/order-pad-admin';
const granted = JSON.stringify({ [capability]: [{}] });
const phone = '100.101.102.104';
const expiresAt = new Date('2026-10-18T23:00:00.000Z');
const waiting = {
  id: '6f1c2f8e-5d0b-4c47-9a35-1f9c1b7e2a10',
  match: '4821',
  device: 'Safari on iPhone',
  requestedAt: new Date('2026-10-18T15:41:00.000Z'),
  expiresAt: new Date('2026-10-18T15:51:00.000Z'),
};
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'order-pad-admin-'));
  await chmod(path, 0o700);
  closers.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function admin(
  access = vi.fn(async (command: string): Promise<AccessResult> => {
    if (command === 'status')
      return { kind: 'status', expiresAt, sessions: 2, requests: [waiting] };
    if (command === 'revoke')
      return { kind: 'revoked', revoked: true, signedOut: 3 };
    return { kind: 'minted', code: 'K7QM4XTD9A', expiresAt, signedOut: 2 };
  }),
  slip = vi.fn(async () => 'Star_TSP143-9'),
  decide = vi.fn(
    async (id: string, decision: SignInDecision): Promise<DecisionResult> =>
      id === waiting.id
        ? {
            kind: decision === 'approve' ? 'approved' : 'denied',
            id,
            match: waiting.match,
            device: waiting.device,
          }
        : { kind: 'gone' },
  ),
) {
  const socket = join(await directory(), 'admin.sock');
  const log = vi.fn();
  const server = createAdminApp({
    origin,
    capability,
    access,
    decide,
    slip,
    assets: 'static',
    log,
  });
  await listenAdmin(server, socket);
  closers.push(
    () => new Promise((resolve) => server.close(() => resolve(undefined))),
  );
  const send = (
    path: string,
    {
      method = 'GET',
      headers = {},
      body,
    }: {
      method?: string;
      headers?: Record<string, string | string[] | undefined>;
      body?: string;
    } = {},
  ) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      const req = request(
        {
          socketPath: socket,
          path,
          method,
          headers: Object.fromEntries(
            Object.entries({
              // What Tailscale Serve sends to a Unix socket backend.
              host: 'localhost',
              'x-forwarded-host': host,
              'x-forwarded-for': phone,
              'tailscale-app-capabilities': granted,
              ...headers,
            }).filter(([, value]) => value !== undefined),
          ) as Record<string, string | string[]>,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              body: text,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const post = (
    body: unknown,
    headers: Record<string, string | string[] | undefined> = {},
    path = adminAccessPath,
  ) =>
    send(path, {
      method: 'POST',
      headers: {
        origin: origin.origin,
        'content-type': 'application/json',
        ...headers,
      },
      // Objects get a fresh confirmation ID unless the test supplies its own.
      body:
        typeof body === 'string'
          ? body
          : JSON.stringify(
              body && typeof body === 'object' && !('requestId' in body)
                ? { ...body, requestId: randomUUID() }
                : body,
            ),
    });
  const decision = (
    body: unknown,
    headers: Record<string, string | string[] | undefined> = {},
  ) => post(body, headers, adminRequestsPath);
  return { socket, access, slip, decide, log, send, post, decision };
}

describe('tailnet admin listener', () => {
  it('serves a private, uncached page with a nonce-only policy', async () => {
    const { socket, send } = await admin();
    expect((await stat(socket)).mode & 0o777).toBe(0o600);
    const page = await send('/');
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-frame-options']).toBe('DENY');
    const csp = String(page.headers['content-security-policy']);
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    expect(page.body).toContain('Mint a code');
    expect(page.body).toContain(
      '<span class="host">station.example.ts.net:8443</span>',
    );
  });

  it('serves only the logo and font the page uses', async () => {
    const { send } = await admin();
    const logo = await send('/logo.svg');
    expect(logo.status).toBe(200);
    expect(logo.headers['content-type']).toBe('image/svg+xml');
    expect((await send('/fonts/poppins-600.ttf')).headers['content-type']).toBe(
      'font/ttf',
    );
    for (const path of ['/icon.svg', '/fonts/OFL.txt', '/../package.json'])
      expect((await send(path)).status).toBe(404);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not JSON', capability],
    ['a JSON array', JSON.stringify([capability])],
    ['another capability', JSON.stringify({ 'example.com/cap/other': [{}] })],
    ['a non-array value', JSON.stringify({ [capability]: true })],
    ['an inherited key', '{"__proto__":{"x":1}}'],
    ['repeated', [granted, granted]],
  ])(
    'refuses a device whose capabilities are %s before any access work',
    async (_, caps) => {
      const { send, post, access } = await admin();
      const headers = { 'tailscale-app-capabilities': caps };
      for (const response of [
        await send('/', { headers }),
        await send(adminAccessPath, { headers }),
        await post({ command: 'mint', confirm: true }, headers),
      ])
        expect(response.status).toBe(403);
      expect(access).not.toHaveBeenCalled();
    },
  );

  it('ignores a login header; only the granted capability counts', async () => {
    const { send } = await admin();
    const headers = {
      'tailscale-app-capabilities': undefined,
      'tailscale-user-login': 'owner@example.com',
    };
    expect((await send(adminAccessPath, { headers })).status).toBe(403);
    const extra = JSON.stringify({
      'example.com/cap/other': [],
      [capability]: [{ note: 'from a grant' }],
    });
    expect(
      (
        await send(adminAccessPath, {
          headers: { 'tailscale-app-capabilities': extra },
        })
      ).status,
    ).toBe(200);
  });

  it.each([
    ['localhost', undefined],
    ['localhost', 'orders.example.com'],
    ['localhost', 'station.example.ts.net'],
    ['localhost', `${host}, ${host}`],
    ['orders.example.com', host],
    ['127.0.0.1', undefined],
    ['station.example.ts.net', undefined],
  ])(
    'refuses Host %s with X-Forwarded-Host %s',
    async (wrongHost, forwarded) => {
      const { send, access } = await admin();
      const headers = { host: wrongHost, 'x-forwarded-host': forwarded };
      expect((await send('/', { headers })).status).toBe(403);
      expect((await send(adminAccessPath, { headers })).status).toBe(403);
      expect(access).not.toHaveBeenCalled();
    },
  );

  it('accepts the admin host directly, as on a TCP test listener', async () => {
    const { send } = await admin();
    const response = await send(adminAccessPath, {
      headers: { host, 'x-forwarded-host': undefined },
    });
    expect(response.status).toBe(200);
  });

  it('reports status and waiting devices without the code', async () => {
    const { send } = await admin();
    const response = await send(adminAccessPath);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      active: true,
      expiresAt: expiresAt.toISOString(),
      sessions: 2,
      requests: [
        {
          id: waiting.id,
          match: '4821',
          device: 'Safari on iPhone',
          requestedAt: '2026-10-18T15:41:00.000Z',
          expiresAt: '2026-10-18T15:51:00.000Z',
        },
      ],
    });
  });

  it('reports an unavailable database for status', async () => {
    const { send } = await admin(
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    expect((await send(adminAccessPath)).status).toBe(503);
  });

  it.each([
    ['another origin', { origin: 'https://orders.example.com' }],
    ['the main tailnet origin', { origin: 'https://station.example.ts.net' }],
    ['no origin', { origin: '' }],
    ['a form body', { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('refuses a change from %s', async (_, headers) => {
    const { post, access } = await admin();
    expect(
      (await post({ command: 'mint', confirm: true }, headers)).status,
    ).toBe(403);
    expect(access).not.toHaveBeenCalled();
  });

  it.each([
    { command: 'mint' },
    { command: 'mint', confirm: 'yes' },
    { command: 'status', confirm: true },
    { command: 'reset', confirm: true },
    { command: 'mint', confirm: true, requestId: undefined },
    { command: 'mint', confirm: true, requestId: 'short' },
    {
      command: 'mint',
      confirm: true,
      requestId: 'has spaces in it, too long?',
    },
    null,
  ])('rejects unconfirmed or unknown change %j', async (body) => {
    const { post, access } = await admin();
    expect((await post(body)).status).toBe(400);
    expect(access).not.toHaveBeenCalled();
  });

  it('rejects oversize bodies and unknown routes', async () => {
    const { post, send, access } = await admin();
    expect(
      (await post(`{"command":"mint","x":"${'a'.repeat(2000)}"}`)).status,
    ).toBe(413);
    expect((await send('/api/station')).status).toBe(404);
    expect((await send('/api/admin/access/mint')).status).toBe(404);
    expect(access).not.toHaveBeenCalled();
  });

  it('mints once, prints one slip and logs the login but never the code', async () => {
    const { post, access, slip, log } = await admin();
    const response = await post({ command: 'mint', confirm: true });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      kind: 'minted',
      code: 'K7QM4-XTD9A',
      expiresAt: expiresAt.toISOString(),
      signedOut: 2,
      slip: {
        printed: true,
        job: 'Star_TSP143-9',
        message: 'Slip submitted to the printer (Star_TSP143-9).',
      },
    });
    expect(access).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledWith('mint');
    expect(slip).toHaveBeenCalledExactlyOnceWith('K7QM4XTD9A', expiresAt);
    expect(log).toHaveBeenCalledWith(`Access mint from tailnet by ${phone}.`);
    expect(JSON.stringify(log.mock.calls)).not.toContain('K7QM4');
  });

  it('returns the valid code when the slip fails', async () => {
    const { post } = await admin(
      undefined,
      vi.fn(async () => {
        throw new Error('Queue paused.');
      }),
    );
    const body = JSON.parse(
      (await post({ command: 'mint', confirm: true })).body,
    );
    expect(body.code).toBe('K7QM4-XTD9A');
    expect(body.slip).toEqual({
      printed: false,
      message:
        'The slip didn’t print: Queue paused. The code above still works, so write it down for staff.',
    });
  });

  it('never prints a slip when the mint is unconfirmed', async () => {
    const access = vi.fn(async () => {
      throw new Error('connection lost');
    });
    const { post, slip } = await admin(access);
    const response = await post({ command: 'mint', confirm: true });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toContain('Nothing was retried');
    expect(access).toHaveBeenCalledTimes(1);
    expect(slip).not.toHaveBeenCalled();
  });

  it('refuses a concurrent change until the first finishes, including its slip', async () => {
    let release!: () => void;
    const slip = vi.fn(
      () =>
        new Promise<string>((resolve) => (release = () => resolve('job-1'))),
    );
    const { post, access } = await admin(undefined, slip);
    const first = post({ command: 'mint', confirm: true });
    await vi.waitFor(() => expect(slip).toHaveBeenCalled());
    const second = await post({ command: 'revoke', confirm: true });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(access).toHaveBeenCalledTimes(1);
    expect((await post({ command: 'revoke', confirm: true })).status).toBe(200);
  });

  it('handles each confirmation ID at most once, even after it finishes', async () => {
    const { post, access, slip } = await admin();
    const body = { command: 'mint', confirm: true, requestId: randomUUID() };
    expect((await post(body)).status).toBe(200);
    const resend = await post(body);
    expect(resend.status).toBe(409);
    expect(JSON.parse(resend.body).error).toContain('wasn’t repeated');
    expect((await post({ ...body, command: 'revoke' })).status).toBe(409);
    expect(access).toHaveBeenCalledTimes(1);
    expect(slip).toHaveBeenCalledTimes(1);
  });

  it('revokes', async () => {
    const { post, access, slip } = await admin();
    const response = await post({ command: 'revoke', confirm: true });
    expect(JSON.parse(response.body)).toEqual({
      kind: 'revoked',
      revoked: true,
      signedOut: 3,
    });
    expect(access).toHaveBeenCalledWith('revoke');
    expect(slip).not.toHaveBeenCalled();
  });

  it.each([
    ['another origin', { origin: 'https://orders.example.com' }],
    ['no origin', { origin: '' }],
    ['a form body', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['a device without the capability', { 'tailscale-app-capabilities': '{}' }],
    ['the wrong host', { 'x-forwarded-host': 'orders.example.com' }],
  ])('refuses a sign-in decision from %s', async (_, headers) => {
    const { decision, decide } = await admin();
    expect(
      (await decision({ decision: 'approve', id: waiting.id }, headers)).status,
    ).toBe(403);
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    { decision: 'allow', id: waiting.id },
    { decision: 'approve' },
    { decision: 'approve', id: '' },
    { decision: 'approve', id: 'has spaces' },
    { decision: 'approve', id: waiting.id, requestId: 'short' },
    null,
  ])('rejects an invalid sign-in decision %j', async (body) => {
    const { decision, decide } = await admin();
    expect((await decision(body)).status).toBe(400);
    expect(decide).not.toHaveBeenCalled();
  });

  it('approves and denies a waiting device and logs who decided', async () => {
    const { decision, decide, log } = await admin();
    const approved = await decision({ decision: 'approve', id: waiting.id });
    expect(approved.status).toBe(200);
    expect(JSON.parse(approved.body)).toEqual({
      kind: 'approved',
      id: waiting.id,
      match: '4821',
    });
    const denied = await decision({ decision: 'deny', id: waiting.id });
    expect(JSON.parse(denied.body).kind).toBe('denied');
    expect(decide.mock.calls).toEqual([
      [waiting.id, 'approve'],
      [waiting.id, 'deny'],
    ]);
    expect(log).toHaveBeenCalledWith(
      `Sign-in approve from tailnet by ${phone}.`,
    );
  });

  it('says when a device is no longer waiting', async () => {
    const { decision } = await admin();
    const response = await decision({ decision: 'approve', id: 'gone-id' });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).error).toContain(
      'That device is no longer waiting.',
    );
  });

  it('reports an unconfirmed decision without retrying it', async () => {
    const decide = vi.fn(async (): Promise<DecisionResult> => {
      throw new Error('connection lost');
    });
    const { decision } = await admin(undefined, undefined, decide);
    const response = await decision({ decision: 'approve', id: waiting.id });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toContain('Nothing was retried');
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('handles each decision ID at most once', async () => {
    const { decision, decide } = await admin();
    const body = {
      decision: 'approve',
      id: waiting.id,
      requestId: randomUUID(),
    };
    expect((await decision(body)).status).toBe(200);
    expect((await decision(body)).status).toBe(409);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('decides while a mint is still printing its slip', async () => {
    let release!: () => void;
    const slip = vi.fn(
      () =>
        new Promise<string>((resolve) => (release = () => resolve('job-1'))),
    );
    const { post, decision } = await admin(undefined, slip);
    const minting = post({ command: 'mint', confirm: true });
    await vi.waitFor(() => expect(slip).toHaveBeenCalled());
    expect((await decision({ decision: 'deny', id: waiting.id })).status).toBe(
      200,
    );
    release();
    expect((await minting).status).toBe(200);
  });
});

describe('listenAdmin', () => {
  const server = () =>
    createAdminApp({
      origin,
      capability,
      access: vi.fn(),
      decide: vi.fn(),
      slip: vi.fn(),
    });

  it('requires a private socket directory', async () => {
    const parent = await directory();
    await chmod(parent, 0o755);
    await expect(
      listenAdmin(server(), join(parent, 'admin.sock')),
    ).rejects.toThrow('mode 700');
    await expect(
      listenAdmin(server(), join(parent, 'missing', 'admin.sock')),
    ).rejects.toThrow();
  });

  it('refuses to replace a regular file', async () => {
    const socket = join(await directory(), 'admin.sock');
    await writeFile(socket, 'keep me');
    await expect(listenAdmin(server(), socket)).rejects.toThrow('not a socket');
  });

  it('replaces a stale socket', async () => {
    const socket = join(await directory(), 'admin.sock');
    // A process that exits without closing its server leaves the socket file behind.
    spawnSync(process.execPath, [
      '-e',
      `require('node:net').createServer().listen(${JSON.stringify(socket)}, () => process.exit(0))`,
    ]);
    expect((await stat(socket)).isSocket()).toBe(true);
    const fresh = server();
    await listenAdmin(fresh, socket);
    closers.push(() => new Promise((resolve) => fresh.close(resolve)));
    expect((await stat(socket)).isSocket()).toBe(true);
  });
});
