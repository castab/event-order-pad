import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createOrderDatabase } from './order-database';
import {
  AuthError,
  PostgresAuth,
  digest,
  secret,
  type AuthContext,
} from './auth';
import { manageAccount } from './auth-admin';
import { PostgresStationRepository } from './station-database';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a separate *_test database.');
const database = createOrderDatabase(url);
const origin = new URL('https://orders.example.test');
let now = new Date('2026-10-16T12:00:00.000Z');
const send = vi.fn<typeof fetch>(
  async () =>
    new Response(
      JSON.stringify({
        success: true,
        hostname: origin.hostname,
        action: 'login',
      }),
    ),
);
let auth: PostgresAuth;
let context: AuthContext;
const password = 'a long enough password';
beforeEach(async () => {
  await database.$executeRaw`TRUNCATE auth_workspaces, auth_events, auth_rates, auth_tokens, auth_challenges, auth_passkeys, auth_sessions, auth_users, workspaces, tickets, print_attempts, print_dispatches, station, order_events RESTART IDENTITY CASCADE`;
  now = new Date('2026-10-16T12:00:00.000Z');
  send.mockReset();
  send.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          hostname: origin.hostname,
          action: 'login',
        }),
      ),
  );
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
async function bootstrap(name = 'staff') {
  await manageAccount(database, 'bootstrap', name, password, now);
}
async function login(name = 'staff', value = password, ctx = context) {
  return auth.handle(
    '/api/auth/login',
    'POST',
    { username: name, password: value, turnstile: 'verified-token' },
    ctx,
  );
}
async function signedIn() {
  await bootstrap();
  const reply = await login();
  const identity = (await auth.session(reply.token))!;
  return { ...context, token: reply.token, identity };
}
function verifyAction(action: string) {
  send.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({ success: true, hostname: origin.hostname, action }),
      ),
  );
}
it('bootstraps once, including concurrent first-account attempts', async () => {
  const results = await Promise.allSettled([
    bootstrap('first'),
    bootstrap('second'),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await database.authUser.count()).toBe(1);
  expect((await database.authUser.findFirst())?.passwordHash).toMatch(
    /^\$argon2id\$/,
  );
});
it('persists only token hashes and expires sessions after exactly 16 hours', async () => {
  await bootstrap();
  const reply = await login('STAFF');
  const row = await database.authSession.findFirstOrThrow();
  expect(row.tokenHash).toBe(digest(reply.token!));
  expect(row.tokenHash).not.toBe(reply.token);
  expect(row.expiresAt.getTime() - now.getTime()).toBe(16 * 3600000);
  const other = await new PostgresAuth(
    database,
    origin,
    auth.config,
    () => now,
    send,
  ).initialize();
  expect((await other.session(reply.token))?.user.username).toBe('staff');
  now = new Date(row.expiresAt);
  expect(await auth.session(reply.token)).toBeUndefined();
});
it('requires correct Turnstile hostname/action and rejects outages and invalid tokens', async () => {
  await bootstrap();
  for (const result of [
    { success: false },
    { success: true, hostname: 'attacker.test', action: 'login' },
    { success: true, hostname: origin.hostname, action: 'enroll' },
  ]) {
    send.mockImplementationOnce(
      async () => new Response(JSON.stringify(result)),
    );
    await expect(login()).rejects.toMatchObject({ status: 403 });
  }
  send.mockRejectedValueOnce(new Error('offline'));
  await expect(login()).rejects.toMatchObject({ status: 403 });
  await expect(
    auth.handle(
      '/api/auth/login',
      'POST',
      { username: 'staff', password },
      context,
    ),
  ).rejects.toMatchObject({ status: 400 });
  expect(send).toHaveBeenCalledTimes(4);
  const [url, request] = send.mock.calls[0];
  expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
  expect(request?.method).toBe('POST');
  expect(JSON.parse(request!.body as string)).toEqual({
    secret: 'secret',
    response: 'verified-token',
    remoteip: context.ip,
  });
  expect(await database.authSession.count()).toBe(0);
});
it('enrolls a reserved username exactly once under concurrent redemption and survives lost replies', async () => {
  const invite = await manageAccount(
    database,
    'invite',
    'new-staff',
    undefined,
    now,
  );
  if (!('token' in invite)) throw new Error('Missing token');
  verifyAction('enroll');
  const redeem = () =>
    auth.handle(
      '/api/auth/enroll',
      'POST',
      { token: invite.token, password, turnstile: 'token' },
      context,
    );
  const results = await Promise.allSettled([redeem(), redeem()]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await database.authUser.count()).toBe(1);
  expect(await database.authToken.count()).toBe(0);
  expect(await database.authSession.count()).toBe(1);
  verifyAction('login');
  expect((await login('new-staff')).token).toBeTruthy();
});
it('rejects expired and revoked enrollment tokens', async () => {
  const invitation = await manageAccount(
    database,
    'invite',
    'staff',
    undefined,
    now,
  );
  if (!('token' in invitation)) throw new Error('Missing token');
  verifyAction('enroll');
  now = new Date(now.getTime() + 86400000);
  await expect(
    auth.handle(
      '/api/auth/enroll',
      'POST',
      { token: invitation.token, password, turnstile: 't' },
      context,
    ),
  ).rejects.toMatchObject({ status: 400 });
  await manageAccount(database, 'revoke', 'staff', undefined, now);
  expect(await database.authToken.count()).toBe(0);
});
it('recovers locally, immediately revokes credentials and sessions, and preserves workspace state', async () => {
  const ctx = await signedIn();
  const key = await auth.workspace(ctx.identity, ctx.browser);
  const station = new PostgresStationRepository(
    database,
    '2026-10-01T00:00:00.000Z',
  );
  const state = await station.load(key);
  await station.mutate(
    {
      operation: 'saveDraft',
      revision: state.revision,
      draft: { ...state.draft, name: 'Saved draft' },
    },
    key,
  );
  const recovery = await manageAccount(
    database,
    'recover',
    'staff',
    undefined,
    now,
  );
  expect(await auth.session(ctx.token)).toBeUndefined();
  await expect(login()).rejects.toMatchObject({ status: 401 });
  expect(await database.authPasskey.count()).toBe(0);
  expect(await database.authUser.findFirst()).toMatchObject({
    passwordHash: null,
    enabled: false,
  });
  if (!('token' in recovery)) throw new Error('Missing token');
  verifyAction('recover');
  const reply = await auth.handle(
    '/api/auth/recover',
    'POST',
    {
      token: recovery.token,
      password: 'a different long password',
      turnstile: 'token',
    },
    context,
  );
  const identity = (await auth.session(reply.token))!;
  expect(await auth.workspace(identity, ctx.browser)).toBe(key);
  expect((await station.load(key)).draft.name).toBe('Saved draft');
});
it('isolates users in one browser and the same user across browsers; never adopts anonymous data', async () => {
  const ctx = await signedIn();
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
  const first = await auth.workspace(ctx.identity, ctx.browser);
  const [same1, same2] = await Promise.all([
    auth.workspace(ctx.identity, ctx.browser),
    auth.workspace(ctx.identity, ctx.browser),
  ]);
  expect(same1).toBe(first);
  expect(same2).toBe(first);
  expect(await auth.workspace(ctx.identity, secret())).not.toBe(first);
  const invitation = await manageAccount(
    database,
    'invite',
    'second',
    undefined,
    now,
  );
  verifyAction('enroll');
  const reply = await auth.handle(
    '/api/auth/enroll',
    'POST',
    {
      token: 'token' in invitation ? invitation.token : '',
      password,
      turnstile: 't',
    },
    context,
  );
  const second = await auth.workspace(
    (await auth.session(reply.token))!,
    ctx.browser,
  );
  expect(second).not.toBe(first);
  expect((await station.load(first)).draft.name).toBe('');
  expect((await station.load('old-anonymous')).draft.name).toBe('Anonymous');
});
it('applies atomic persistent limits to unknown users, per-user failures and page requests', async () => {
  for (let n = 0; n < 5; n++)
    await expect(login('unknown')).rejects.toMatchObject({ status: 401 });
  const other = await new PostgresAuth(
    database,
    origin,
    auth.config,
    () => now,
    send,
  ).initialize();
  await expect(
    other.handle(
      '/api/auth/login',
      'POST',
      { username: 'unknown', password, turnstile: 't' },
      context,
    ),
  ).rejects.toMatchObject({ status: 429, retryAfter: 900 });
  for (let n = 5; n < 20; n++)
    await expect(
      login('unknown', password, { ...context, ip: '192.0.2.' + (n + 2) }),
    ).rejects.toMatchObject({ status: 401 });
  await expect(
    login('unknown', password, { ...context, ip: '192.0.2.99' }),
  ).rejects.toMatchObject({ status: 429 });
  const pages = await Promise.allSettled(
    Array.from({ length: 125 }, () => auth.ratePage('198.51.100.1')),
  );
  expect(pages.filter((r) => r.status === 'fulfilled')).toHaveLength(120);
  now = new Date(now.getTime() + 900001);
  await expect(login('unknown')).rejects.toMatchObject({ status: 401 });
});
it('requires recent authentication for changes and revokes all sessions on password change or disabling', async () => {
  const ctx = await signedIn();
  const other = await login();
  now = new Date(now.getTime() + 300001);
  await expect(
    auth.handle(
      '/api/auth/password',
      'POST',
      { password: 'new valid password phrase' },
      ctx,
    ),
  ).rejects.toMatchObject({ status: 403 });
  await auth.handle(
    '/api/auth/reauthenticate',
    'POST',
    { username: 'staff', password, turnstile: 't' },
    ctx,
  );
  const changed = await auth.handle(
    '/api/auth/password',
    'POST',
    { password: 'new valid password phrase' },
    ctx,
  );
  expect(await auth.session(ctx.token)).toBeUndefined();
  expect(await auth.session(other.token)).toBeUndefined();
  expect(await auth.session(changed.token)).toBeTruthy();
  await manageAccount(database, 'disable', 'staff', undefined, now);
  expect(await auth.session(changed.token)).toBeUndefined();
});
it('binds passkey challenges to browser, session and flow, consumes failures once, and expires challenges', async () => {
  const ctx = await signedIn();
  const options = await auth.handle(
    '/api/auth/passkey/login/options',
    'POST',
    { turnstile: 't' },
    context,
  );
  expect(options.challenge).toBeTruthy();
  const challenge = await database.authChallenge.findFirstOrThrow();
  expect(challenge.tokenHash).toBe(digest(options.challenge!));
  await expect(
    auth.handle(
      '/api/auth/passkey/login/verify',
      'POST',
      { response: {} },
      { ...context, browser: secret(), challenge: options.challenge },
    ),
  ).rejects.toMatchObject({ status: 401 });
  expect(await database.authChallenge.count()).toBe(1);
  await expect(
    auth.handle(
      '/api/auth/passkey/login/verify',
      'POST',
      { response: {} },
      { ...context, challenge: options.challenge },
    ),
  ).rejects.toBeInstanceOf(AuthError);
  expect(await database.authChallenge.count()).toBe(0);
  await expect(
    auth.handle(
      '/api/auth/passkey/login/verify',
      'POST',
      { response: {} },
      { ...context, challenge: options.challenge },
    ),
  ).rejects.toBeInstanceOf(AuthError);
  const registration = await auth.handle(
    '/api/auth/passkey/register/options',
    'POST',
    {},
    ctx,
  );
  const body = registration.body as {
    options: {
      authenticatorSelection: { residentKey: string; userVerification: string };
    };
  };
  expect(body.options.authenticatorSelection).toMatchObject({
    residentKey: 'required',
    userVerification: 'required',
  });
  now = new Date(now.getTime() + 300001);
  await expect(
    auth.handle(
      '/api/auth/passkey/register/verify',
      'POST',
      { response: {}, name: 'Phone' },
      { ...ctx, challenge: registration.challenge },
    ),
  ).rejects.toBeInstanceOf(AuthError);
});
it('cleans expired auth records in bounded batches without removing station data', async () => {
  await signedIn();
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
  expect(await database.authUser.count()).toBe(1);
});

it('registers and authenticates signed passkeys, updates counters, rejects origin/UV/replay errors and removes credentials', async () => {
  const { testAuthenticator } = await import('../tests/helpers/webauthn');
  const ctx = await signedIn();
  const authenticator = testAuthenticator(origin.hostname, origin.origin);
  const options = await auth.handle(
    '/api/auth/passkey/register/options',
    'POST',
    {},
    ctx,
  );
  const challenge = (options.body as { options: { challenge: string } }).options
    .challenge;
  const registration = authenticator.registration(challenge);
  await auth.handle(
    '/api/auth/passkey/register/verify',
    'POST',
    { response: registration, name: 'Phone' },
    { ...ctx, challenge: options.challenge },
  );
  expect(await database.authPasskey.count()).toBe(1);
  async function attempt(requestOrigin?: string, verified = true) {
    const opt = await auth.handle(
      '/api/auth/passkey/login/options',
      'POST',
      { turnstile: 't' },
      context,
    );
    const response = authenticator.authentication(
      (opt.body as { options: { challenge: string } }).options.challenge,
      1,
      requestOrigin,
      verified,
    );
    const request = { response };
    const flow = { ...context, challenge: opt.challenge };
    return { request, flow };
  }
  const badOrigin = await attempt('https://attacker.test');
  await expect(
    auth.handle(
      '/api/auth/passkey/login/verify',
      'POST',
      badOrigin.request,
      badOrigin.flow,
    ),
  ).rejects.toMatchObject({ status: 401 });
  const noUV = await attempt(origin.origin, false);
  await expect(
    auth.handle(
      '/api/auth/passkey/login/verify',
      'POST',
      noUV.request,
      noUV.flow,
    ),
  ).rejects.toMatchObject({ status: 401 });
  const valid = await attempt();
  const result = await auth.handle(
    '/api/auth/passkey/login/verify',
    'POST',
    valid.request,
    valid.flow,
  );
  expect((await auth.session(result.token))?.user.username).toBe('staff');
  expect((await database.authPasskey.findFirstOrThrow()).counter).toBe(1n);
  await expect(
    auth.handle(
      '/api/auth/passkey/login/verify',
      'POST',
      valid.request,
      valid.flow,
    ),
  ).rejects.toMatchObject({ status: 401 });
  const cloned = await attempt();
  await expect(
    auth.handle(
      '/api/auth/passkey/login/verify',
      'POST',
      cloned.request,
      cloned.flow,
    ),
  ).rejects.toMatchObject({ status: 401 });
  await auth.handle(
    '/api/auth/passkey/remove',
    'POST',
    { id: authenticator.id },
    ctx,
  );
  expect(await database.authPasskey.count()).toBe(0);
});
