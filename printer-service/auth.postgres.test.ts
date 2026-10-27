import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { resetMenu } from '../tests/helpers/menu-postgres';
import { createOrderDatabase } from './order-database';
import { PostgresAuth, digest, secret, type AuthContext } from './auth';
import {
  AccessRefused,
  accessStatus,
  mintCodes,
  revokeAccess,
} from './access-admin';
import { PostgresStationRepository } from './station-database';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a separate *_test database.');
const database = createOrderDatabase(url);
const origin = new URL('https://orders.example.test');
let now = new Date('2026-10-16T12:00:00.000Z');
const verified = async () =>
  new Response(
    JSON.stringify({
      success: true,
      hostname: origin.hostname,
      action: 'login',
    }),
  );
const send = vi.fn<typeof fetch>(verified);
let auth: PostgresAuth;
let context: AuthContext;
beforeEach(async () => {
  await database.$executeRaw`TRUNCATE access_workspaces, auth_events, auth_rates, auth_sessions, access_codes, workspaces, tickets, print_attempts, print_dispatches, station, order_events RESTART IDENTITY CASCADE`;
  await resetMenu(database);
  now = new Date('2026-10-16T12:00:00.000Z');
  send.mockReset();
  send.mockImplementation(verified);
  auth = await new PostgresAuth(
    database,
    origin,
    { proxy: 'direct', sitekey: 'sitekey', turnstileSecret: 'secret' },
    () => now,
    send,
  ).initialize();
  context = { ip: '192.0.2.1', browser: secret() };
});
afterAll(() => database.$disconnect());
const ipad =
  'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
async function mint(count = 1) {
  return mintCodes(database, count, now);
}
function login(code: string, ctx = context) {
  return auth.handle(
    '/api/auth/login',
    'POST',
    { code, turnstile: 'verified-token' },
    ctx,
  );
}
async function signedIn(code: string, ctx = context) {
  const reply = await login(code, ctx);
  const identity = (await auth.session(reply.token))!;
  return { ...ctx, token: reply.token, identity };
}
const elsewhere = () => ({ ...context, browser: secret() });
const used = {
  status: 401,
  message:
    'That code isn’t valid. Each code works once, within an hour of printing. Ask for a new slip.',
};

it('stores only hashes; each code signs in one device for 8 hours from when it is used', async () => {
  const minted = await mint(3);
  expect(minted).toHaveLength(3);
  expect(new Set(minted.map((m) => m.code)).size).toBe(3);
  for (const m of minted)
    expect(m.redeemBy.getTime() - now.getTime()).toBe(60 * 60000);
  for (const stored of await database.accessCode.findMany()) {
    expect(stored.codeHash).toMatch(/^\$argon2id\$/);
    for (const m of minted) expect(stored.codeHash).not.toContain(m.code);
  }
  now = new Date(now.getTime() + 30 * 60000);
  const code = minted[0].code;
  // Lowercase with a hyphen, as staff might type it.
  const reply = await login(
    `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase(),
    { ...context, userAgent: ipad },
  );
  const until = new Date(now.getTime() + 8 * 3600000);
  expect(reply.body).toEqual({ ok: true, expiresAt: until.toISOString() });
  const row = await database.authSession.findFirstOrThrow();
  expect(row.tokenHash).toBe(digest(reply.token!));
  expect(row.device).toBe('Safari on iPad');
  await expect(login(code, elsewhere())).rejects.toMatchObject(used);
  expect((await login(minted[1].code, elsewhere())).token).toBeTruthy();
  // An unused code lapses an hour after it was minted.
  now = new Date(minted[2].redeemBy);
  await expect(login(minted[2].code, elsewhere())).rejects.toMatchObject(used);
  now = new Date(until.getTime() - 1);
  expect((await auth.session(reply.token))?.expiresAt).toBe(
    until.toISOString(),
  );
  now = until;
  expect(await auth.session(reply.token)).toBeUndefined();
});

it('lets only one of two devices racing with the same code in', async () => {
  const [{ code, id }] = await mint();
  const results = await Promise.allSettled([
    login(code, elsewhere()),
    login(code, elsewhere()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await database.authSession.count()).toBe(1);
  await expect(
    database.$executeRaw`INSERT INTO auth_sessions (token_hash, code_id, device, authenticated_at, expires_at) VALUES ('extra', ${id}, 'x', ${now}, ${new Date(now.getTime() + 1000)})`,
  ).rejects.toThrow();
});

it('mints 1 to 5 at a time with at most 10 unused, and mints nothing when refused', async () => {
  for (const count of [0, 6, 2.5, '3', undefined])
    await expect(mintCodes(database, count, now)).rejects.toThrow(
      AccessRefused,
    );
  await mint(5);
  await mint(4);
  await expect(mint(2)).rejects.toThrow(
    '9 unused codes are still out, and at most 10 can be. Void some or let them expire first. Nothing was minted.',
  );
  // Concurrent mints serialize, so the limit holds for both.
  const results = await Promise.allSettled([mint(1), mint(1)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await database.accessCode.count()).toBe(10);
  now = new Date(now.getTime() + 60 * 60000);
  expect(await mint(5)).toHaveLength(5);
});

it('voids one code or every code, signing out only the devices they opened', async () => {
  const [a, b, c] = await mint(3);
  const first = await signedIn(a.code, { ...elsewhere(), userAgent: ipad });
  const second = await signedIn(b.code, elsewhere());
  const status = await accessStatus(database, now);
  expect(status).toEqual({
    unused: [{ id: c.id, createdAt: now, redeemBy: c.redeemBy }],
    devices: expect.arrayContaining([
      {
        id: a.id,
        device: 'Safari on iPad',
        signedInAt: now,
        expiresAt: new Date(now.getTime() + 8 * 3600000),
      },
      expect.objectContaining({ id: b.id, device: 'Unknown browser' }),
    ]),
  });
  for (const m of [a, b, c])
    expect(JSON.stringify(status)).not.toContain(m.code);
  expect(await revokeAccess(database, { id: a.id }, now)).toEqual({
    kind: 'revoked',
    voided: 0,
    signedOut: 1,
  });
  expect(await auth.session(first.token)).toBeUndefined();
  expect(await auth.session(second.token)).toBeTruthy();
  expect(await revokeAccess(database, { id: a.id }, now)).toEqual({
    kind: 'gone',
  });
  expect(await revokeAccess(database, { id: c.id }, now)).toEqual({
    kind: 'revoked',
    voided: 1,
    signedOut: 0,
  });
  await expect(login(c.code, elsewhere())).rejects.toMatchObject(used);
  const [d] = await mint();
  expect(await revokeAccess(database, 'all', now)).toEqual({
    kind: 'revoked',
    voided: 1,
    signedOut: 1,
  });
  expect(await auth.session(second.token)).toBeUndefined();
  await expect(login(d.code, elsewhere())).rejects.toMatchObject(used);
  expect(await accessStatus(database, now)).toEqual({
    unused: [],
    devices: [],
  });
  expect(await revokeAccess(database, 'all', now)).toEqual({
    kind: 'revoked',
    voided: 0,
    signedOut: 0,
  });
});

it('requires correct Turnstile hostname/action and rejects outages and malformed codes', async () => {
  const [{ code }] = await mint();
  for (const result of [
    { success: false },
    { success: true, hostname: 'attacker.test', action: 'login' },
    { success: true, hostname: origin.hostname, action: 'enroll' },
  ]) {
    send.mockImplementationOnce(
      async () => new Response(JSON.stringify(result)),
    );
    await expect(login(code)).rejects.toMatchObject({ status: 403 });
  }
  send.mockRejectedValueOnce(new Error('offline'));
  await expect(login(code)).rejects.toMatchObject({ status: 403 });
  await expect(
    auth.handle('/api/auth/login', 'POST', { code }, context),
  ).rejects.toMatchObject({ status: 400 });
  await expect(login('not a code')).rejects.toMatchObject({ status: 400 });
  expect(send).toHaveBeenCalledTimes(4);
  const [url, request] = send.mock.calls[0];
  expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(JSON.parse(request!.body as string)).toEqual({
    secret: 'secret',
    response: 'verified-token',
    remoteip: context.ip,
  });
  expect(await database.authSession.count()).toBe(0);
});

it('limits wrong codes per address and across all addresses, persistently', async () => {
  // One code out keeps each wrong guess to a single Argon2 check.
  const [{ code }] = await mint();
  const wrong = code.startsWith('2')
    ? '3' + code.slice(1)
    : '2' + code.slice(1);
  for (let n = 0; n < 5; n++)
    await expect(login(wrong)).rejects.toMatchObject({ status: 401 });
  const other = await new PostgresAuth(
    database,
    origin,
    auth.config,
    () => now,
    send,
  ).initialize();
  // The right code is still refused while this address is cooling down.
  await expect(
    other.handle('/api/auth/login', 'POST', { code, turnstile: 't' }, context),
  ).rejects.toMatchObject({ status: 429, retryAfter: 900 });
  for (let n = 5; n < 100; n++)
    await expect(
      login(wrong, {
        ...context,
        ip: `198.51.${Math.floor(n / 4)}.${n % 4}`,
      }),
    ).rejects.toMatchObject({ status: 401 });
  await expect(
    login(code, { ...context, ip: '203.0.113.9' }),
  ).rejects.toMatchObject({ status: 429 });
  now = new Date(now.getTime() + 900001);
  // Successful sign-ins return their reservations.
  const codes = [...(await mint(5)), ...(await mint(3))].map((m) => m.code);
  for (const each of codes)
    expect(
      (await login(each, { ...elsewhere(), ip: '203.0.113.10' })).token,
    ).toBeTruthy();
  const pages = await Promise.allSettled(
    Array.from({ length: 125 }, () => auth.ratePage('198.51.100.1')),
  );
  expect(pages.filter((r) => r.status === 'fulfilled')).toHaveLength(120);
});

it('keeps each browser’s workspace across its codes and never adopts anonymous data', async () => {
  const station = new PostgresStationRepository(
    database,
    '2026-10-01T00:00:00.000Z',
  );
  const old = await station.load('old-anonymous');
  await station.mutate(
    {
      operation: 'saveDraft',
      revision: old.revision,
      draft: { ...old.draft, name: 'Anonymous' },
    },
    'old-anonymous',
  );
  const [a, b, c] = await mint(3);
  const first = await signedIn(a.code);
  const [key, again] = await Promise.all([
    auth.workspace(first.identity, first.browser),
    auth.workspace(first.identity, first.browser),
  ]);
  expect(again).toBe(key);
  const state = await station.load(key);
  expect(state.draft.name).toBe('');
  await station.mutate(
    {
      operation: 'saveDraft',
      revision: state.revision,
      draft: { ...state.draft, name: 'Saved draft' },
    },
    key,
  );
  await revokeAccess(database, { id: a.id }, now);
  await expect(
    auth.workspace(first.identity, first.browser),
  ).rejects.toMatchObject({ status: 401 });
  const other = await signedIn(b.code, elsewhere());
  expect(await auth.workspace(other.identity, other.browser)).not.toBe(key);
  const rotated = await signedIn(c.code, first);
  expect(await auth.workspace(rotated.identity, first.browser)).toBe(key);
  expect((await station.load(key)).draft.name).toBe('Saved draft');
  expect((await station.load('old-anonymous')).draft.name).toBe('Anonymous');
});

it('logs out only this device, leaves its code used up and cleans up in small batches', async () => {
  const [one, two, spare] = await mint(3);
  const a = await signedIn(one.code);
  const b = await signedIn(two.code, elsewhere());
  expect(await auth.handle('/api/auth/logout', 'POST', {}, a)).toMatchObject({
    clearSession: true,
  });
  expect(await auth.session(a.token)).toBeUndefined();
  expect(await auth.session(b.token)).toBeTruthy();
  await expect(login(one.code, a)).rejects.toMatchObject(used);
  await database.authRate.createMany({
    data: Array.from({ length: 150 }, (_, n) => ({
      key: 'old-' + n,
      count: 1,
      expiresAt: new Date(now.getTime() - 1),
    })),
  });
  await auth.cleanup();
  expect(
    await database.authRate.count({ where: { key: { startsWith: 'old-' } } }),
  ).toBe(50);
  // The signed-out code goes; the one in use and the unused one stay.
  expect(
    (await database.accessCode.findMany({ orderBy: { id: 'asc' } })).map(
      (c) => c.id,
    ),
  ).toEqual([two.id, spare.id].sort());
  now = new Date(spare.redeemBy);
  await auth.cleanup();
  expect(await database.accessCode.count()).toBe(1);
  now = new Date(now.getTime() + 8 * 3600000);
  await auth.cleanup();
  expect(await database.accessCode.count()).toBe(0);
  expect(await database.authSession.count()).toBe(0);
});

it('the per-device migration voids shared codes and ends their sessions', async () => {
  const sql = readFileSync(
    new URL(
      '../prisma/migrations/20261020000000_device_access_codes/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const voiding = sql
    .slice(0, sql.indexOf('DROP INDEX'))
    .replace(/^\s*--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  expect(voiding).toHaveLength(2);
  const [used, unused] = await mint(2);
  await signedIn(used.code);
  const rows = await database
    .$transaction(async (tx) => {
      for (const statement of voiding) await tx.$executeRawUnsafe(statement);
      const result = {
        active: await tx.accessCode.count({ where: { revokedAt: null } }),
        sessions: await tx.authSession.count(),
      };
      throw Object.assign(new Error('rollback'), { result });
    })
    .catch((error) => (error as { result: unknown }).result);
  expect(rows).toEqual({ active: 0, sessions: 0 });
  expect(await database.accessCode.count({ where: { revokedAt: null } })).toBe(
    2,
  );
  expect(unused.id).not.toBe(used.id);
});

it('the migration reattaches a browser’s workspace only when it had one account', async () => {
  const sql = readFileSync(
    new URL(
      '../prisma/migrations/20261017000000_access_codes/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const seed = sql.slice(
    sql.indexOf('INSERT INTO access_workspaces'),
    sql.indexOf(';', sql.indexOf('INSERT INTO access_workspaces')),
  );
  const rows = await database
    .$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE auth_workspaces (user_id TEXT, browser_hash TEXT, workspace_key TEXT) ON COMMIT DROP',
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO auth_workspaces VALUES ('u1', 'single', 'w1'), ('u1', 'shared', 'w2'), ('u2', 'shared', 'w3')`,
      );
      await tx.$executeRawUnsafe(seed);
      const result = await tx.accessWorkspace.findMany();
      throw Object.assign(new Error('rollback'), { result });
    })
    .catch((error) => (error as { result: unknown }).result);
  expect(rows).toEqual([{ browserHash: 'single', workspaceKey: 'w1' }]);
  expect(await database.accessWorkspace.count()).toBe(0);
});
