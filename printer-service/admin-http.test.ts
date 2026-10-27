import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  adminAccessPath,
  adminMenuPath,
  createAdminApp,
  listenAdmin,
} from './admin-http';
import { MemoryMenu } from '../tests/helpers/menu';
import { AccessRefused, type MintedCode } from './access-admin';

const origin = new URL('https://station.example.ts.net:8443');
const host = origin.host;
const capability = 'fionasicecream.com/cap/order-pad-admin';
const granted = JSON.stringify({ [capability]: [{}] });
const phone = '100.101.102.104';
const redeemBy = new Date('2026-10-18T16:00:00.000Z');
const minted = (count: number): MintedCode[] =>
  ['K7QM4XTD9A', 'B3NR8PWX2C', 'HJ5TZ7Q9MV', 'D2F4G6H8JK', 'M3P5R7T9VX']
    .slice(0, count)
    .map((code, index) => ({ id: `code-${index}`, code, redeemBy }));
function fakeAccess() {
  return {
    status: vi.fn(async () => ({
      unused: [
        {
          id: 'code-1',
          createdAt: new Date('2026-10-18T15:00:00.000Z'),
          redeemBy,
        },
      ],
      devices: [
        {
          id: 'code-0',
          device: 'Safari on iPad',
          signedInAt: new Date('2026-10-18T15:05:00.000Z'),
          expiresAt: new Date('2026-10-18T23:05:00.000Z'),
        },
      ],
    })),
    mint: vi.fn(async (count: number) => minted(count)),
    revoke: vi.fn(
      async (): Promise<
        | { kind: 'revoked'; voided: number; signedOut: number }
        | { kind: 'gone' }
      > => ({ kind: 'revoked', voided: 1, signedOut: 1 }),
    ),
  };
}
const calls = (access: ReturnType<typeof fakeAccess>) =>
  access.status.mock.calls.length +
  access.mint.mock.calls.length +
  access.revoke.mock.calls.length;
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
  access = fakeAccess(),
  slip = vi.fn(async (code: string, _redeemBy: Date) => `Star_TSP143-${code}`),
  menu: Pick<MemoryMenu, 'load' | 'change'> = new MemoryMenu(),
) {
  const socket = join(await directory(), 'admin.sock');
  const log = vi.fn();
  const server = createAdminApp({
    origin,
    capability,
    access,
    menu,
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
  const postMenu = (
    body: unknown,
    headers: Record<string, string | string[] | undefined> = {},
  ) => post(body, headers, adminMenuPath);
  return { socket, access, menu, slip, log, send, post, postMenu };
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
    expect(page.body).toContain(
      'How many access codes would you like to mint?',
    );
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
        await post({ command: 'mint', count: 1 }, headers),
      ])
        expect(response.status).toBe(403);
      expect(calls(access)).toBe(0);
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
      expect((await send('/menu', { headers })).status).toBe(403);
      expect((await send(adminAccessPath, { headers })).status).toBe(403);
      expect((await send(adminMenuPath, { headers })).status).toBe(403);
      expect(calls(access)).toBe(0);
    },
  );

  it('accepts the admin host directly, as on a TCP test listener', async () => {
    const { send } = await admin();
    const response = await send(adminAccessPath, {
      headers: { host, 'x-forwarded-host': undefined },
    });
    expect(response.status).toBe(200);
  });

  it('reports unused codes and signed-in devices, never a code', async () => {
    const { send } = await admin();
    const response = await send(adminAccessPath);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      unused: [
        {
          id: 'code-1',
          createdAt: '2026-10-18T15:00:00.000Z',
          redeemBy: redeemBy.toISOString(),
        },
      ],
      devices: [
        {
          id: 'code-0',
          device: 'Safari on iPad',
          signedInAt: '2026-10-18T15:05:00.000Z',
          expiresAt: '2026-10-18T23:05:00.000Z',
        },
      ],
    });
  });

  it('reports an unavailable database for status', async () => {
    const access = fakeAccess();
    access.status.mockRejectedValue(new Error('down'));
    const { send } = await admin(access);
    expect((await send(adminAccessPath)).status).toBe(503);
  });

  it.each([
    ['another origin', { origin: 'https://orders.example.com' }],
    ['the main tailnet origin', { origin: 'https://station.example.ts.net' }],
    ['no origin', { origin: '' }],
    ['a form body', { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('refuses a change from %s', async (_, headers) => {
    const { post, access } = await admin();
    expect((await post({ command: 'mint', count: 1 }, headers)).status).toBe(
      403,
    );
    expect(calls(access)).toBe(0);
  });

  it.each([
    { command: 'mint' },
    { command: 'mint', count: 0 },
    { command: 'mint', count: 6 },
    { command: 'mint', count: 2.5 },
    { command: 'mint', count: '3' },
    { command: 'revoke', target: 'all' },
    { command: 'revoke', target: 'all', confirm: 'yes' },
    { command: 'revoke', confirm: true },
    { command: 'revoke', target: 'not an id!', confirm: true },
    { command: 'status', confirm: true },
    { command: 'reset', confirm: true },
    { command: 'mint', count: 1, requestId: undefined },
    { command: 'mint', count: 1, requestId: 'short' },
    { command: 'mint', count: 1, requestId: 'has spaces in it, too long?' },
    null,
  ])('rejects an unknown or unconfirmed change %j', async (body) => {
    const { post, access } = await admin();
    expect((await post(body)).status).toBe(400);
    expect(calls(access)).toBe(0);
  });

  it('rejects oversize bodies and unknown routes', async () => {
    const { post, send, access } = await admin();
    expect(
      (await post(`{"command":"mint","x":"${'a'.repeat(2000)}"}`)).status,
    ).toBe(413);
    expect((await send('/api/station')).status).toBe(404);
    expect((await send('/api/admin/access/mint')).status).toBe(404);
    expect(calls(access)).toBe(0);
  });

  it('mints the count asked for, prints one slip per code and never logs a code', async () => {
    const { post, access, slip, log } = await admin();
    const response = await post({ command: 'mint', count: 3 });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      kind: 'minted',
      codes: ['K7QM4-XTD9A', 'B3NR8-PWX2C', 'HJ5TZ-7Q9MV'].map((code) => ({
        code,
        redeemBy: redeemBy.toISOString(),
        slip: {
          printed: true,
          job: `Star_TSP143-${code.replace('-', '')}`,
          message: `Slip submitted to the printer (Star_TSP143-${code.replace('-', '')}).`,
        },
      })),
    });
    expect(access.mint).toHaveBeenCalledExactlyOnceWith(3);
    expect(slip.mock.calls).toEqual([
      ['K7QM4XTD9A', redeemBy],
      ['B3NR8PWX2C', redeemBy],
      ['HJ5TZ7Q9MV', redeemBy],
    ]);
    expect(log).toHaveBeenCalledWith(
      `Access mint of 3 from tailnet by ${phone}.`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('K7QM4');
  });

  it('mints without printing any slip when asked, and still never logs a code', async () => {
    const { post, access, slip, log } = await admin();
    const response = await post({ command: 'mint', count: 2, print: false });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      kind: 'minted',
      codes: ['K7QM4-XTD9A', 'B3NR8-PWX2C'].map((code) => ({
        code,
        redeemBy: redeemBy.toISOString(),
      })),
    });
    expect(access.mint).toHaveBeenCalledExactlyOnceWith(2);
    expect(slip).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      `Access mint of 2 without slips from tailnet by ${phone}.`,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('K7QM4');
  });

  it('prints a slip per code when print is true', async () => {
    const { post, slip } = await admin();
    const body = JSON.parse(
      (await post({ command: 'mint', count: 2, print: true })).body,
    );
    expect(
      body.codes.map((c: { slip: { printed: boolean } }) => c.slip.printed),
    ).toEqual([true, true]);
    expect(slip).toHaveBeenCalledTimes(2);
  });

  it.each(['no', 0, null, 'false'])(
    'rejects %j as print before minting anything',
    async (print) => {
      const { post, access, slip } = await admin();
      const response = await post({ command: 'mint', count: 1, print });
      expect(response.status).toBe(400);
      expect(access.mint).not.toHaveBeenCalled();
      expect(slip).not.toHaveBeenCalled();
    },
  );

  it('returns every valid code when a slip fails, and stops printing after it', async () => {
    const slip = vi
      .fn(async (code: string, _redeemBy: Date) => `job-${code}`)
      .mockResolvedValueOnce('job-1')
      .mockRejectedValueOnce(new Error('Queue paused.'));
    const { post } = await admin(undefined, slip);
    const body = JSON.parse((await post({ command: 'mint', count: 3 })).body);
    expect(body.codes.map((c: { code: string }) => c.code)).toEqual([
      'K7QM4-XTD9A',
      'B3NR8-PWX2C',
      'HJ5TZ-7Q9MV',
    ]);
    expect(body.codes.map((c: { slip: unknown }) => c.slip)).toEqual([
      {
        printed: true,
        job: 'job-1',
        message: 'Slip submitted to the printer (job-1).',
      },
      {
        printed: false,
        message:
          'The slip didn’t print: Queue paused. This code still works, so write it down for staff.',
      },
      {
        printed: false,
        message:
          'Not printed, because an earlier slip failed. This code still works, so write it down for staff.',
      },
    ]);
    expect(slip).toHaveBeenCalledTimes(2);
  });

  it('passes on a refusal that minted nothing', async () => {
    const access = fakeAccess();
    access.mint.mockRejectedValue(
      new AccessRefused('9 unused codes are still out. Nothing was minted.'),
    );
    const { post, slip } = await admin(access);
    const response = await post({ command: 'mint', count: 2 });
    expect(response.status).toBe(409);
    expect(JSON.parse(response.body).error).toBe(
      '9 unused codes are still out. Nothing was minted.',
    );
    expect(slip).not.toHaveBeenCalled();
  });

  it('never prints a slip when the mint is unconfirmed', async () => {
    const access = fakeAccess();
    access.mint.mockRejectedValue(new Error('connection lost'));
    const { post, slip } = await admin(access);
    const response = await post({ command: 'mint', count: 1 });
    expect(response.status).toBe(503);
    expect(JSON.parse(response.body).error).toContain('Nothing was retried');
    expect(access.mint).toHaveBeenCalledTimes(1);
    expect(slip).not.toHaveBeenCalled();
  });

  it('refuses a concurrent change until the first finishes, including its slips', async () => {
    let release!: () => void;
    const slip = vi.fn(
      () =>
        new Promise<string>((resolve) => (release = () => resolve('job-1'))),
    );
    const { post, access } = await admin(undefined, slip);
    const first = post({ command: 'mint', count: 1 });
    await vi.waitFor(() => expect(slip).toHaveBeenCalled());
    const second = await post({
      command: 'revoke',
      target: 'all',
      confirm: true,
    });
    expect(second.status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(access.revoke).not.toHaveBeenCalled();
    expect(
      (await post({ command: 'revoke', target: 'all', confirm: true })).status,
    ).toBe(200);
  });

  it('handles each request ID at most once, even after it finishes', async () => {
    const { post, access, slip } = await admin();
    const body = { command: 'mint', count: 1, requestId: randomUUID() };
    expect((await post(body)).status).toBe(200);
    const resend = await post(body);
    expect(resend.status).toBe(409);
    expect(JSON.parse(resend.body).error).toContain('wasn’t repeated');
    expect(
      (
        await post({
          command: 'revoke',
          target: 'all',
          confirm: true,
          requestId: body.requestId,
        })
      ).status,
    ).toBe(409);
    expect(access.mint).toHaveBeenCalledTimes(1);
    expect(access.revoke).not.toHaveBeenCalled();
    expect(slip).toHaveBeenCalledTimes(1);
  });

  it('voids one code or signs out everyone, and reports a code that is gone', async () => {
    const { post, access, slip, log } = await admin();
    const one = await post({
      command: 'revoke',
      target: 'code-1',
      confirm: true,
    });
    expect(JSON.parse(one.body)).toEqual({
      kind: 'revoked',
      voided: 1,
      signedOut: 1,
    });
    expect(access.revoke).toHaveBeenLastCalledWith({ id: 'code-1' });
    expect(log).toHaveBeenCalledWith(
      `Access revoke of one code from tailnet by ${phone}.`,
    );
    await post({ command: 'revoke', target: 'all', confirm: true });
    expect(access.revoke).toHaveBeenLastCalledWith('all');
    access.revoke.mockResolvedValueOnce({ kind: 'gone' });
    const gone = await post({
      command: 'revoke',
      target: 'code-9',
      confirm: true,
    });
    expect(gone.status).toBe(409);
    expect(JSON.parse(gone.body).error).toContain('Nothing changed');
    expect(slip).not.toHaveBeenCalled();
  });
});

describe('tailnet menu admin', () => {
  const add = (extra: Record<string, unknown> = {}) => ({
    command: 'add',
    revision: 0,
    category: 'flavor',
    displayName: 'Mint Chip',
    description: 'Cool and green.',
    ...extra,
  });

  it('serves the menu page with the shared header and page tabs', async () => {
    const { send } = await admin();
    const page = await send('/menu');
    expect(page.status).toBe(200);
    expect(page.headers['cache-control']).toBe('no-store');
    const nonce = /script-src 'nonce-([^']+)'/.exec(
      String(page.headers['content-security-policy']),
    )?.[1];
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    expect(page.body).toContain('<h1>Menu</h1>');
    expect(page.body).toContain('<a href="/menu" aria-current="page">Menu</a>');
    expect(page.body).toContain('<a href="/">Access codes</a>');
    expect((await send('/')).body).toContain(
      '<a href="/" aria-current="page">Access codes</a>',
    );
  });

  it('refuses a device without the capability before reading the menu', async () => {
    const menu = new MemoryMenu();
    const load = vi.spyOn(menu, 'load');
    const { send, postMenu } = await admin(undefined, undefined, menu);
    const headers = { 'tailscale-app-capabilities': undefined };
    expect((await send(adminMenuPath, { headers })).status).toBe(403);
    expect((await send('/menu', { headers })).status).toBe(403);
    expect((await postMenu(add(), headers)).status).toBe(403);
    expect(load).not.toHaveBeenCalled();
  });

  it('lists every choice with its id, position and description', async () => {
    const { send } = await admin();
    const body = JSON.parse((await send(adminMenuPath)).body);
    expect(body.revision).toBe(0);
    expect(body.choices).toHaveLength(15);
    expect(body.choices[0]).toEqual({
      id: 'flavor-0',
      category: 'flavor',
      position: 0,
      data: { category: 'flavor', displayName: 'Chocolate' },
    });
  });

  it('reports an unavailable database for the menu', async () => {
    const menu = new MemoryMenu();
    vi.spyOn(menu, 'load').mockRejectedValue(new Error('down'));
    const { send } = await admin(undefined, undefined, menu);
    expect((await send(adminMenuPath)).status).toBe(503);
  });

  it.each([
    ['another origin', { origin: 'https://orders.example.com' }],
    ['no origin', { origin: '' }],
    ['a form body', { 'content-type': 'application/x-www-form-urlencoded' }],
  ])('refuses a menu change from %s', async (_, headers) => {
    const menu = new MemoryMenu();
    const change = vi.spyOn(menu, 'change');
    const { postMenu } = await admin(undefined, undefined, menu);
    expect((await postMenu(add(), headers)).status).toBe(403);
    expect(change).not.toHaveBeenCalled();
  });

  it.each([
    add({ requestId: undefined }),
    add({ requestId: 'short' }),
    add({ category: 'cone' }),
    add({ displayName: '' }),
    add({ displayName: 'x'.repeat(41) }),
    add({ revision: -1 }),
    { command: 'move', revision: 0, id: 'flavor-0', direction: 'sideways' },
    { command: 'drop', revision: 0 },
  ])('rejects an invalid menu change %j before writing', async (body) => {
    const menu = new MemoryMenu();
    const change = vi.spyOn(menu, 'change');
    const { postMenu } = await admin(undefined, undefined, menu);
    const reply = await postMenu(body);
    expect(reply.status).toBe(400);
    expect(JSON.parse(reply.body).error).toContain('Nothing changed');
    expect(change).not.toHaveBeenCalled();
  });

  it('applies a change once, returns the new menu and logs it', async () => {
    const { postMenu, menu, log } = await admin();
    const requestId = randomUUID();
    const reply = await postMenu(add({ requestId }));
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body);
    expect(body.revision).toBe(1);
    expect(
      body.choices.find((c: { id: string }) => c.id === 'added-1'),
    ).toEqual({
      id: 'added-1',
      category: 'flavor',
      position: 4,
      data: {
        category: 'flavor',
        displayName: 'Mint Chip',
        description: 'Cool and green.',
      },
    });
    expect(log).toHaveBeenCalledWith(
      `Menu add of “Mint Chip” (flavor) from tailnet by ${phone}.`,
    );
    const again = await postMenu(add({ requestId, revision: 1 }));
    expect(again.status).toBe(409);
    expect(JSON.parse(again.body).error).toContain('wasn’t repeated');
    expect((await (menu as MemoryMenu).load()).flavor).toHaveLength(5);
  });

  it('refuses a stale revision and a refused change without writing', async () => {
    const { postMenu, menu } = await admin();
    expect((await postMenu(add())).status).toBe(200);
    const stale = await postMenu(add({ displayName: 'Pistachio' }));
    expect(stale.status).toBe(409);
    expect(JSON.parse(stale.body).error).toContain('changed on another device');
    const duplicate = await postMenu(
      add({ revision: 1, displayName: 'mint chip' }),
    );
    expect(duplicate.status).toBe(409);
    expect(JSON.parse(duplicate.body).error).toContain('already a flavor');
    expect((await (menu as MemoryMenu).load()).revision).toBe(1);
  });

  it('refuses removing the last container', async () => {
    const menu = new MemoryMenu();
    menu.set({ flavor: ['Vanilla'], container: ['Cup'] });
    const { postMenu } = await admin(undefined, undefined, menu);
    const reply = await postMenu({
      command: 'remove',
      revision: 1,
      id: 'container-0',
    });
    expect(reply.status).toBe(409);
    expect(JSON.parse(reply.body).error).toBe(
      'Keep at least one container so orders can be built. Nothing changed.',
    );
  });

  it('reports an unconfirmed write without retrying it', async () => {
    const menu = new MemoryMenu();
    const change = vi
      .spyOn(menu, 'change')
      .mockRejectedValue(new Error('connection lost'));
    const { postMenu, log } = await admin(undefined, undefined, menu);
    const reply = await postMenu({
      command: 'move',
      revision: 0,
      id: 'flavor-1',
      direction: 'up',
    });
    expect(reply.status).toBe(503);
    expect(JSON.parse(reply.body).error).toContain('Nothing was retried');
    expect(change).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      `Menu move of flavor-1 up from tailnet by ${phone} was not confirmed.`,
    );
  });

  it('runs one menu change at a time', async () => {
    const menu = new MemoryMenu();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = menu.change.bind(menu);
    vi.spyOn(menu, 'change').mockImplementation(async (...args) => {
      await gate;
      return real(...args);
    });
    const { postMenu } = await admin(undefined, undefined, menu);
    const first = postMenu(add());
    await vi.waitFor(() => expect(menu.change).toHaveBeenCalledTimes(1));
    const second = await postMenu(add({ displayName: 'Pistachio' }));
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body).error).toContain('still running');
    release();
    expect((await first).status).toBe(200);
  });
});

describe('listenAdmin', () => {
  const server = () =>
    createAdminApp({
      origin,
      capability,
      access: fakeAccess(),
      menu: new MemoryMenu(),
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
