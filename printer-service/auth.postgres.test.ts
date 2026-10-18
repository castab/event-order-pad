import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createOrderDatabase } from './order-database';
import { PostgresAuth, digest, secret, type AuthContext } from './auth';
import { manageAccess } from './access-admin';
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
async function mint() {
  const result = await manageAccess(database, 'mint', now);
  if (result.kind !== 'minted') throw new Error('Expected a minted code.');
  return result;
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

it('stores only hashes and ends every session when the code’s 8 hours run out', async () => {
  const { code, expiresAt } = await mint();
  expect(expiresAt.getTime() - now.getTime()).toBe(8 * 3600000);
  const stored = await database.accessCode.findFirstOrThrow();
  expect(stored.codeHash).toMatch(/^\$argon2id\$/);
  expect(stored.codeHash).not.toContain(code);
  // Lowercase with a hyphen, as staff might type it.
  const early = await login(
    `${code.slice(0, 5)}-${code.slice(5)}`.toLowerCase(),
  );
  const row = await database.authSession.findFirstOrThrow();
  expect(row.tokenHash).toBe(digest(early.token!));
  now = new Date(now.getTime() + 7 * 3600000);
  const late = await login(code, { ...context, browser: secret() });
  for (const token of [early.token, late.token])
    expect((await auth.session(token))?.expiresAt).toBe(
      expiresAt.toISOString(),
    );
  now = new Date(expiresAt);
  expect(await auth.session(early.token)).toBeUndefined();
  expect(await auth.session(late.token)).toBeUndefined();
  await expect(login(code)).rejects.toMatchObject({ status: 401 });
});

it('minting voids the previous code and signs out every device that used it', async () => {
  const first = await mint();
  const a = await signedIn(first.code);
  const b = await signedIn(first.code, { ...context, browser: secret() });
  const second = await mint();
  expect(second.code).not.toBe(first.code);
  expect(second.signedOut).toBe(2);
  expect(await auth.session(a.token)).toBeUndefined();
  expect(await auth.session(b.token)).toBeUndefined();
  expect(await database.authSession.count()).toBe(0);
  await expect(login(first.code)).rejects.toMatchObject({
    status: 401,
    message:
      'That code isn’t active. It may have been replaced by a newer one. Check the latest slip at the station.',
  });
  expect((await login(second.code)).token).toBeTruthy();
  expect(await database.accessCode.count({ where: { revokedAt: null } })).toBe(
    1,
  );
});

it('keeps at most one active code under concurrent minting', async () => {
  // The service allows two Argon2 hashes at once; the CLI is one process.
  const results = await Promise.all([mint(), mint()]);
  expect(await database.accessCode.count()).toBe(2);
  expect(await database.accessCode.count({ where: { revokedAt: null } })).toBe(
    1,
  );
  const accepted = await Promise.allSettled(
    results.map((result) => login(result.code)),
  );
  expect(accepted.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  await expect(
    database.$executeRaw`INSERT INTO access_codes (id, code_hash, created_at, expires_at) VALUES ('extra', 'x', ${now}, ${new Date(now.getTime() + 1000)})`,
  ).rejects.toThrow();
});

it('revoke ends access without minting and status never reveals the code', async () => {
  expect(await manageAccess(database, 'status', now)).toEqual({
    kind: 'status',
    expiresAt: undefined,
    sessions: 0,
  });
  const { code, expiresAt } = await mint();
  const ctx = await signedIn(code);
  const status = await manageAccess(database, 'status', now);
  expect(status).toEqual({ kind: 'status', expiresAt, sessions: 1 });
  expect(JSON.stringify(status)).not.toContain(code);
  expect(await manageAccess(database, 'revoke', now)).toEqual({
    kind: 'revoked',
    revoked: true,
    signedOut: 1,
  });
  expect(await auth.session(ctx.token)).toBeUndefined();
  await expect(login(code)).rejects.toMatchObject({ status: 401 });
  expect(await manageAccess(database, 'revoke', now)).toEqual({
    kind: 'revoked',
    revoked: false,
    signedOut: 0,
  });
  await expect(manageAccess(database, 'invite', now)).rejects.toThrow();
});

it('requires correct Turnstile hostname/action and rejects outages and malformed codes', async () => {
  const { code } = await mint();
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
  const { code } = await mint();
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
  for (let n = 0; n < 8; n++)
    expect(
      (await login(code, { ...context, ip: '203.0.113.10' })).token,
    ).toBeTruthy();
  const pages = await Promise.allSettled(
    Array.from({ length: 125 }, () => auth.ratePage('198.51.100.1')),
  );
  expect(pages.filter((r) => r.status === 'fulfilled')).toHaveLength(120);
});

it('keeps each browser’s workspace across code rotations and never adopts anonymous data', async () => {
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
  const first = await signedIn((await mint()).code);
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
  const second = await mint();
  await expect(
    auth.workspace(first.identity, first.browser),
  ).rejects.toMatchObject({ status: 401 });
  const other = await signedIn(second.code, { ...context, browser: secret() });
  expect(await auth.workspace(other.identity, other.browser)).not.toBe(key);
  const rotated = await signedIn(second.code, first);
  expect(await auth.workspace(rotated.identity, first.browser)).toBe(key);
  expect((await station.load(key)).draft.name).toBe('Saved draft');
  expect((await station.load('old-anonymous')).draft.name).toBe('Anonymous');
});

it('logs out only this device and cleans up expired rows in small batches', async () => {
  const { code } = await mint();
  const a = await signedIn(code);
  const b = await signedIn(code, { ...context, browser: secret() });
  expect(await auth.handle('/api/auth/logout', 'POST', {}, a)).toMatchObject({
    clearSession: true,
  });
  expect(await auth.session(a.token)).toBeUndefined();
  expect(await auth.session(b.token)).toBeTruthy();
  await mint();
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
  // The revoked code has no sessions left; the active one stays.
  expect(await database.accessCode.count()).toBe(1);
  now = new Date(now.getTime() + 8 * 3600000);
  await auth.cleanup();
  expect(await database.accessCode.count()).toBe(0);
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
