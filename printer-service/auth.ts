import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { hash, verify } from '@node-rs/argon2';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  AuthenticatorTransport,
} from '@simplewebauthn/server';
import type { Prisma, PrismaClient } from './generated/prisma/client';
import { newDraft } from '../src/lib/tickets/order';
import {
  parsePassword,
  parseUsername,
  parseAuthSession,
  type AuthSession,
} from '../src/lib/auth/model';

type Transaction = Prisma.TransactionClient;
export class AuthError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}
export interface Identity extends AuthSession {
  readonly sessionHash: string;
  readonly version: number;
}
export interface AuthContext {
  readonly ip: string;
  readonly browser: string;
  readonly token?: string;
  readonly challenge?: string;
  readonly identity?: Identity;
}
export interface AuthReply {
  readonly body: unknown;
  readonly token?: string;
  readonly challenge?: string;
  readonly clearSession?: boolean;
}
export interface Authentication {
  check(): Promise<void>;
  session(token?: string): Promise<Identity | undefined>;
  workspace(identity: Identity, browser: string): Promise<string>;
  ratePage(ip: string): Promise<void>;
  handle(
    path: string,
    method: string,
    body: unknown,
    context: AuthContext,
  ): Promise<AuthReply>;
}
export const publicAuthPosts = new Set([
  '/api/auth/login',
  '/api/auth/passkey/login/options',
  '/api/auth/passkey/login/verify',
  '/api/auth/enroll',
  '/api/auth/recover',
]);
export const authPosts = new Set([
  ...publicAuthPosts,
  '/api/auth/logout',
  '/api/auth/logout-all',
  '/api/auth/reauthenticate',
  '/api/auth/password',
  '/api/auth/passkey/register/options',
  '/api/auth/passkey/register/verify',
  '/api/auth/passkey/remove',
  '/api/auth/passkey/reauth/options',
  '/api/auth/passkey/reauth/verify',
]);
export const secret = () => randomBytes(32).toString('hex');
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const sessionCookie = '__Host-order-pad-session';
export const browserCookie = '__Host-order-pad-browser';
export const challengeCookie = '__Host-order-pad-challenge';
export const sessionSeconds = 16 * 60 * 60;
export function opaque(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value)
  );
}
export function clientIp(
  remote: string | undefined,
  header: string | string[] | undefined,
  proxy: 'direct' | 'cloudflare',
) {
  const address = remote?.replace(/^::ffff:/, '');
  if (proxy === 'direct') return address && isIP(address) ? address : 'unknown';
  if (
    !['127.0.0.1', '::1'].includes(address ?? '') ||
    typeof header !== 'string' ||
    !isIP(header)
  )
    throw new AuthError(403, 'Trusted Cloudflare connection required.');
  // Canonicalize IPv6 so alternate spellings cannot create independent limits.
  return isIP(header) === 6
    ? new URL(`http://[${header}]/`).hostname.slice(1, -1)
    : header;
}
export function parseAuthConfig(env: NodeJS.ProcessEnv) {
  const proxy = env.ORDER_PAD_PROXY ?? 'direct';
  if (proxy !== 'direct' && proxy !== 'cloudflare')
    throw new Error('ORDER_PAD_PROXY must be direct or cloudflare.');
  const sitekey = env.ORDER_PAD_TURNSTILE_SITE_KEY;
  const turnstileSecret = env.ORDER_PAD_TURNSTILE_SECRET_KEY;
  if (
    !sitekey ||
    sitekey.length < 3 ||
    sitekey.length > 200 ||
    /[^\w-]/.test(sitekey) ||
    !turnstileSecret ||
    turnstileSecret.length < 3 ||
    turnstileSecret.length > 200 ||
    /[^\w-]/.test(turnstileSecret)
  )
    throw new Error(
      'Configure ORDER_PAD_TURNSTILE_SITE_KEY and ORDER_PAD_TURNSTILE_SECRET_KEY.',
    );
  return Object.freeze({ proxy, sitekey, turnstileSecret });
}
export type AuthConfig = ReturnType<typeof parseAuthConfig>;
const invalid = () =>
  new AuthError(401, 'Sign-in failed. Check your credentials and try again.');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AuthError(400, 'Invalid authentication request.');
  return value as Record<string, unknown>;
}
function username(value: unknown) {
  try {
    return parseUsername(value);
  } catch (error) {
    throw new AuthError(400, (error as Error).message);
  }
}
function password(value: unknown) {
  try {
    return parsePassword(value);
  } catch (error) {
    throw new AuthError(400, (error as Error).message);
  }
}
let hashing = 0;
async function hashWork<T>(work: () => Promise<T>): Promise<T> {
  if (hashing >= 2)
    throw new AuthError(429, 'Sign-in is busy. Try again shortly.', 2);
  hashing++;
  try {
    return await work();
  } finally {
    hashing--;
  }
}
export const passwordHash = (value: string) =>
  hashWork(() =>
    hash(value, {
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    }),
  );
const passwordMatches = (encoded: string, value: string) =>
  hashWork(() => verify(encoded, value));

/** Database-backed authentication; all credentials and challenges are final once consumed. */
export class PostgresAuth implements Authentication {
  private dummy = '';
  constructor(
    readonly database: PrismaClient,
    readonly origin: URL,
    readonly config: AuthConfig,
    private now = () => new Date(),
    private send: typeof fetch = fetch,
  ) {}
  async initialize() {
    this.dummy = await passwordHash(secret());
    await this.check();
    return this;
  }
  async check() {
    await this.database.$queryRaw`SELECT
      (SELECT version FROM auth_users LIMIT 1), (SELECT token_hash FROM auth_sessions LIMIT 1),
      (SELECT id FROM auth_passkeys LIMIT 1), (SELECT token_hash FROM auth_challenges LIMIT 1),
      (SELECT token_hash FROM auth_tokens LIMIT 1), (SELECT key FROM auth_rates LIMIT 1),
      (SELECT id FROM auth_events LIMIT 1), (SELECT workspace_key FROM auth_workspaces LIMIT 1)`;
  }
  async session(token?: string): Promise<Identity | undefined> {
    if (!opaque(token)) return undefined;
    const row = await this.database.authSession.findUnique({
      where: { tokenHash: digest(token) },
      include: { user: true },
    });
    if (
      !row ||
      !row.user.enabled ||
      row.user.version !== row.version ||
      row.expiresAt <= this.now()
    )
      return undefined;
    return Object.freeze({
      ...parseAuthSession({
        user: { id: row.userId, username: row.user.username },
        expiresAt: row.expiresAt.toISOString(),
        authenticatedAt: row.authenticatedAt.toISOString(),
      }),
      sessionHash: row.tokenHash,
      version: row.version,
    });
  }
  async workspace(identity: Identity, browser: string) {
    return this.database.$transaction(async (tx) => {
      const browserHash = digest(browser);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'auth-workspace:' + identity.user.id + browserHash}, 0))::text`;
      await this.current(tx, identity);
      const key = { userId: identity.user.id, browserHash };
      const existing = await tx.authWorkspace.findUnique({
        where: { userId_browserHash: key },
      });
      if (existing) return existing.workspaceKey;
      const workspaceKey = secret();
      // Explicit creation prevents the legacy anonymous-workspace adoption path.
      await tx.workspace.create({
        data: {
          id: workspaceKey,
          cookieId: workspaceKey,
          draft: newDraft() as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.authWorkspace.create({ data: { ...key, workspaceKey } });
      return workspaceKey;
    });
  }
  private async audit(
    tx: Transaction | PrismaClient,
    kind: string,
    userId?: string,
    ip?: string,
  ) {
    await tx.authEvent.create({
      data: { kind, userId, ipHash: ip ? digest(ip) : undefined },
    });
  }
  private async rate(key: string, limit: number, seconds: number) {
    const now = this.now();
    const expires = new Date(now.getTime() + seconds * 1000);
    const rows = await this.database.$queryRaw<
      { count: number; expires_at: Date }[]
    >`
      INSERT INTO auth_rates (key, count, expires_at) VALUES (${digest(key)}, 1, ${expires})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE WHEN auth_rates.expires_at <= ${now} THEN 1 ELSE LEAST(auth_rates.count + 1, ${limit + 1}) END,
        expires_at = CASE WHEN auth_rates.expires_at <= ${now} THEN ${expires} ELSE auth_rates.expires_at END
      RETURNING count, expires_at`;
    if (rows[0].count > limit)
      throw new AuthError(
        429,
        'Too many attempts. Try again later.',
        Math.max(
          1,
          Math.ceil((rows[0].expires_at.getTime() - now.getTime()) / 1000),
        ),
      );
  }
  async ratePage(ip: string) {
    await this.rate('page:' + ip, 120, 60);
  }
  private async turnstile(value: unknown, action: string, ip: string) {
    if (typeof value !== 'string' || !value || value.length > 2048)
      throw new AuthError(400, 'Complete the verification and try again.');
    let valid = false;
    try {
      const response = await this.send(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({
            secret: this.config.turnstileSecret,
            response: value,
            remoteip: ip,
          }),
        },
      );
      const result = await response.json();
      valid =
        response.ok &&
        result?.success === true &&
        result.hostname === this.origin.hostname &&
        result.action === action;
    } catch {
      /* Verification outages never grant access. */
    }
    if (!valid) {
      await this.audit(this.database, 'turnstile-rejected', undefined, ip);
      throw new AuthError(
        403,
        'Verification failed. Refresh the verification and try again.',
      );
    }
  }
  private async current(tx: Transaction, identity: Identity, recent = false) {
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${identity.user.id} FOR UPDATE`;
    const session = await tx.authSession.findUnique({
      where: { tokenHash: identity.sessionHash },
      include: { user: true },
    });
    if (
      !session ||
      !session.user.enabled ||
      session.user.version !== session.version ||
      session.expiresAt <= this.now()
    )
      throw new AuthError(401, 'Sign in to continue.');
    if (
      recent &&
      this.now().getTime() - session.authenticatedAt.getTime() > 300000
    )
      throw new AuthError(
        403,
        'Confirm your password or passkey before changing credentials.',
      );
    return session.user;
  }
  private async issue(
    tx: Transaction,
    user: { id: string; version: number },
    ip?: string,
  ) {
    const token = secret();
    const now = this.now();
    await tx.authSession.create({
      data: {
        tokenHash: digest(token),
        userId: user.id,
        version: user.version,
        authenticatedAt: now,
        expiresAt: new Date(now.getTime() + sessionSeconds * 1000),
      },
    });
    await this.audit(tx, 'signed-in', user.id, ip);
    return { body: { ok: true }, token };
  }
  private async passwordUser(
    body: Record<string, unknown>,
    context: AuthContext,
  ) {
    const name = username(body.username);
    const value = password(body.password);
    const keys = [
      `password-pair:${name}:${context.ip}`,
      `password-user:${name}`,
    ];
    await this.rate(keys[0], 5, 900);
    await this.rate(keys[1], 20, 900);
    const user = await this.database.authUser.findUnique({
      where: { username: name },
    });
    const matches = await passwordMatches(
      user?.passwordHash ?? this.dummy,
      value,
    );
    if (!matches || !user?.enabled || !user.passwordHash) {
      await this.audit(
        this.database,
        'password-rejected',
        user?.id,
        context.ip,
      );
      throw invalid();
    }
    return { user, keys };
  }
  private async clearFailureReservations(tx: Transaction, keys: string[]) {
    for (const key of keys)
      await tx.$executeRaw`UPDATE auth_rates SET count = GREATEST(0, count - 1) WHERE key = ${digest(key)}`;
  }
  async handle(
    path: string,
    method: string,
    input: unknown,
    context: AuthContext,
  ): Promise<AuthReply> {
    try {
      return await this.execute(path, method, input, context);
    } catch (error) {
      if (
        error instanceof AuthError &&
        [400, 401, 403].includes(error.status) &&
        path.includes('/passkey/')
      )
        await this.audit(
          this.database,
          'passkey-rejected',
          context.identity?.user.id,
          context.ip,
        );
      throw error;
    }
  }
  private async execute(
    path: string,
    method: string,
    input: unknown,
    context: AuthContext,
  ): Promise<AuthReply> {
    if (method === 'GET' && path === '/api/auth/config')
      return { body: { sitekey: this.config.sitekey } };
    if (method === 'GET' && path === '/api/auth/session') {
      if (!context.identity) throw new AuthError(401, 'Sign in to continue.');
      return { body: parseAuthSession(context.identity) };
    }
    if (method === 'GET' && path === '/api/auth/passkeys') {
      if (!context.identity) throw invalid();
      const keys = await this.database.authPasskey.findMany({
        where: { userId: context.identity.user.id },
        orderBy: { createdAt: 'asc' },
      });
      return {
        body: {
          passkeys: keys.map((k) => ({
            id: k.id,
            name: k.name,
            createdAt: k.createdAt.toISOString(),
          })),
        },
      };
    }
    if (method !== 'POST' || !authPosts.has(path))
      throw new AuthError(404, 'Not found.');
    const body = object(input);
    const who = context.identity;
    if (publicAuthPosts.has(path))
      await this.rate('operation:' + context.ip, 10, 60);
    else if (!who) throw new AuthError(401, 'Sign in to continue.');
    if (path === '/api/auth/login' || path === '/api/auth/reauthenticate') {
      await this.turnstile(body.turnstile, 'login', context.ip);
      const { user, keys } = await this.passwordUser(body, context);
      return this.database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${user.id} FOR UPDATE`;
        const current = await tx.authUser.findUniqueOrThrow({
          where: { id: user.id },
        });
        if (!current.enabled || current.version !== user.version)
          throw invalid();
        if (path.endsWith('/reauthenticate')) {
          if (!who || who.user.id !== current.id) throw invalid();
          await this.current(tx, who);
          await tx.authSession.update({
            where: { tokenHash: who.sessionHash },
            data: { authenticatedAt: this.now() },
          });
          await this.audit(tx, 'reauthenticated', current.id, context.ip);
          await this.clearFailureReservations(tx, keys);
          return { body: { ok: true } };
        }
        await this.clearFailureReservations(tx, keys);
        if (opaque(context.token))
          await tx.authSession.deleteMany({
            where: { tokenHash: digest(context.token) },
          });
        return this.issue(tx, current, context.ip);
      });
    }
    if (path === '/api/auth/enroll' || path === '/api/auth/recover') {
      const kind = path.endsWith('/enroll') ? 'invite' : 'recover';
      await this.turnstile(
        body.turnstile,
        kind === 'invite' ? 'enroll' : 'recover',
        context.ip,
      );
      if (!opaque(body.token))
        throw new AuthError(
          400,
          'This enrollment or recovery link is invalid or expired.',
        );
      const tokenHash = digest(body.token);
      const encoded = await passwordHash(password(body.password));
      return this.database.$transaction(async (tx) => {
        // Serialize issuance, revocation and redemption for both token types.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
        const token = await tx.authToken.findUnique({ where: { tokenHash } });
        if (!token || token.kind !== kind || token.expiresAt <= this.now())
          throw new AuthError(
            400,
            'This enrollment or recovery link is invalid or expired.',
          );
        let user;
        if (kind === 'invite') {
          user = await tx.authUser.create({
            data: {
              id: randomUUID(),
              username: token.username,
              passwordHash: encoded,
            },
          });
        } else {
          if (!token.userId) throw invalid();
          await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${token.userId} FOR UPDATE`;
          user = await tx.authUser.update({
            where: { id: token.userId },
            data: {
              passwordHash: encoded,
              enabled: true,
              version: { increment: 1 },
            },
          });
          await tx.authSession.deleteMany({ where: { userId: user.id } });
          await tx.authPasskey.deleteMany({ where: { userId: user.id } });
        }
        await tx.authToken.delete({ where: { tokenHash } });
        await this.audit(
          tx,
          kind === 'invite' ? 'enrolled' : 'recovered',
          user.id,
          context.ip,
        );
        return this.issue(tx, user, context.ip);
      });
    }
    if (path === '/api/auth/logout' || path === '/api/auth/logout-all') {
      await this.database.$transaction(async (tx) => {
        await this.current(tx, who!);
        await tx.authSession.deleteMany({
          where: path.endsWith('/logout-all')
            ? { userId: who!.user.id }
            : { tokenHash: who!.sessionHash },
        });
        await this.audit(tx, 'signed-out', who!.user.id, context.ip);
      });
      return { body: { ok: true }, clearSession: true };
    }
    if (path === '/api/auth/password') {
      const encoded = await passwordHash(password(body.password));
      return this.database.$transaction(async (tx) => {
        const user = await this.current(tx, who!, true);
        const next = await tx.authUser.update({
          where: { id: user.id },
          data: { passwordHash: encoded, version: { increment: 1 } },
        });
        await tx.authSession.deleteMany({ where: { userId: user.id } });
        await this.audit(tx, 'password-changed', user.id, context.ip);
        return this.issue(tx, next, context.ip);
      });
    }
    if (path === '/api/auth/passkey/remove') {
      if (typeof body.id !== 'string' || body.id.length > 2048)
        throw new AuthError(400, 'Invalid passkey.');
      await this.database.$transaction(async (tx) => {
        await this.current(tx, who!, true);
        const removed = await tx.authPasskey.deleteMany({
          where: { id: body.id as string, userId: who!.user.id },
        });
        if (!removed.count) throw new AuthError(404, 'Passkey not found.');
        await this.audit(tx, 'passkey-removed', who!.user.id, context.ip);
      });
      return { body: { ok: true } };
    }
    if (path.endsWith('/options')) {
      const kind = path.includes('/register/')
        ? 'register'
        : path.includes('/reauth/')
          ? 'reauth'
          : 'login';
      if (kind === 'login' || kind === 'reauth')
        await this.turnstile(body.turnstile, 'login', context.ip);
      const options =
        kind === 'register'
          ? await generateRegistrationOptions({
              rpName: 'Fiona’s Order Pad',
              rpID: this.origin.hostname,
              userID: new TextEncoder().encode(who!.user.id),
              userName: who!.user.username,
              attestationType: 'none',
              authenticatorSelection: {
                residentKey: 'required',
                userVerification: 'required',
              },
              excludeCredentials: (
                await this.database.authPasskey.findMany({
                  where: { userId: who!.user.id },
                })
              ).map((k) => ({ id: k.id })),
            })
          : await generateAuthenticationOptions({
              rpID: this.origin.hostname,
              userVerification: 'required',
            });
      const challenge = secret();
      await this.database.$transaction(async (tx) => {
        if (kind !== 'login') await this.current(tx, who!, kind === 'register');
        await tx.authChallenge.create({
          data: {
            tokenHash: digest(challenge),
            browserHash: digest(context.browser),
            kind,
            challenge: options.challenge,
            sessionHash: kind === 'login' ? null : who!.sessionHash,
            userId: kind === 'login' ? null : who!.user.id,
            version: kind === 'login' ? null : who!.version,
            expiresAt: new Date(this.now().getTime() + 300000),
          },
        });
      });
      return { body: { options }, challenge };
    }
    if (path.endsWith('/verify')) {
      if (!opaque(context.challenge)) throw invalid();
      const tokenHash = digest(context.challenge);
      // Claim once before expensive verification, including failed assertions.
      const challenge = await this.database.$transaction(async (tx) => {
        const row = await tx.authChallenge.findUnique({ where: { tokenHash } });
        if (
          !row ||
          row.expiresAt <= this.now() ||
          row.browserHash !== digest(context.browser)
        )
          throw invalid();
        const removed = await tx.authChallenge.deleteMany({
          where: { tokenHash },
        });
        if (removed.count !== 1) throw invalid();
        return row;
      });
      const kind = path.includes('/register/')
        ? 'register'
        : path.includes('/reauth/')
          ? 'reauth'
          : 'login';
      if (
        kind !== challenge.kind ||
        (kind !== 'login' &&
          (challenge.sessionHash !== who?.sessionHash ||
            challenge.userId !== who.user.id))
      )
        throw invalid();
      const response = object(body.response);
      if (kind === 'register') {
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name))
          throw new AuthError(
            400,
            'Give the passkey a name of 1–80 characters.',
          );
        let registration;
        try {
          registration = await verifyRegistrationResponse({
            response: response as unknown as RegistrationResponseJSON,
            expectedChallenge: challenge.challenge,
            expectedOrigin: this.origin.origin,
            expectedRPID: this.origin.hostname,
            requireUserVerification: true,
          });
        } catch {
          throw invalid();
        }
        if (!registration.verified || !registration.registrationInfo)
          throw invalid();
        const info = registration.registrationInfo;
        await this.database.$transaction(async (tx) => {
          await this.current(tx, who!, true);
          if (who!.version !== challenge.version) throw invalid();
          await tx.authPasskey.create({
            data: {
              id: info.credential.id,
              userId: who!.user.id,
              name,
              publicKey: Buffer.from(info.credential.publicKey),
              counter: BigInt(info.credential.counter),
              transports: info.credential.transports ?? [],
              deviceType: info.credentialDeviceType,
              backedUp: info.credentialBackedUp,
            },
          });
          await this.audit(tx, 'passkey-added', who!.user.id, context.ip);
        });
        return { body: { ok: true } };
      }
      if (typeof response.id !== 'string') throw invalid();
      const passkey = await this.database.authPasskey.findUnique({
        where: { id: response.id },
        include: { user: true },
      });
      if (
        !passkey?.user.enabled ||
        (kind === 'reauth' && passkey.userId !== who!.user.id)
      )
        throw invalid();
      let authentication;
      try {
        authentication = await verifyAuthenticationResponse({
          response: response as unknown as AuthenticationResponseJSON,
          expectedChallenge: challenge.challenge,
          expectedOrigin: this.origin.origin,
          expectedRPID: this.origin.hostname,
          requireUserVerification: true,
          credential: {
            id: passkey.id,
            publicKey: new Uint8Array(passkey.publicKey),
            counter: Number(passkey.counter),
            transports: passkey.transports as AuthenticatorTransport[],
          },
        });
      } catch {
        throw invalid();
      }
      if (!authentication.verified) throw invalid();
      return this.database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${passkey.userId} FOR UPDATE`;
        const user = await tx.authUser.findUniqueOrThrow({
          where: { id: passkey.userId },
        });
        const current = await tx.authPasskey.findUnique({
          where: { id: passkey.id },
        });
        if (
          !user.enabled ||
          user.version !== passkey.user.version ||
          !current ||
          current.counter !== passkey.counter
        )
          throw invalid();
        await tx.authPasskey.update({
          where: { id: passkey.id },
          data: {
            counter: BigInt(authentication.authenticationInfo.newCounter),
          },
        });
        if (kind === 'reauth') {
          await this.current(tx, who!);
          await tx.authSession.update({
            where: { tokenHash: who!.sessionHash },
            data: { authenticatedAt: this.now() },
          });
          await this.audit(tx, 'reauthenticated', user.id, context.ip);
          return { body: { ok: true } };
        }
        if (opaque(context.token))
          await tx.authSession.deleteMany({
            where: { tokenHash: digest(context.token) },
          });
        return this.issue(tx, user, context.ip);
      });
    }
    throw new AuthError(404, 'Not found.');
  }
  async cleanup() {
    const now = this.now();
    // Small batches keep maintenance from monopolizing station transactions.
    for (const table of [
      'auth_sessions',
      'auth_challenges',
      'auth_tokens',
      'auth_rates',
    ] as const) {
      const { Prisma } = await import('./generated/prisma/client');
      const column = table === 'auth_rates' ? 'key' : 'token_hash';
      await this.database
        .$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(column)} IN
        (SELECT ${Prisma.raw(column)} FROM ${Prisma.raw(table)} WHERE expires_at <= ${now} LIMIT 100)`);
    }
    await this.database.$executeRaw`DELETE FROM auth_events WHERE id IN
      (SELECT id FROM auth_events WHERE created_at < ${new Date(now.getTime() - 90 * 86400000)} LIMIT 100)`;
  }
}
