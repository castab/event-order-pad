import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { hash, verify } from '@node-rs/argon2';
import type { Prisma, PrismaClient } from './generated/prisma/client';
import { newDraft } from '../src/lib/tickets/order';
import {
  OUTSTANDING_CODE_LIMIT,
  parseAccessCode,
  parseAuthSession,
  SESSION_HOURS,
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
  readonly codeId: string;
  readonly sessionHash: string;
}
export interface AuthContext {
  readonly ip: string;
  readonly browser: string;
  readonly token?: string;
  readonly identity?: Identity;
  readonly userAgent?: string;
}
export interface AuthReply {
  readonly body: unknown;
  readonly token?: string;
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
export const publicAuthPosts = new Set(['/api/auth/login']);
export const authPosts = new Set([...publicAuthPosts, '/api/auth/logout']);
export const secret = () => randomBytes(32).toString('hex');
export const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
export const sessionCookie = '__Host-order-pad-session';
export const browserCookie = '__Host-order-pad-browser';
/** Cookie lifetime only; revoking the session's code also ends it. */
export const sessionSeconds = SESSION_HOURS * 60 * 60;
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
/** A short browser and platform name for the admin page; it is a hint, never trusted. */
export function deviceLabel(agent: unknown): string {
  if (typeof agent !== 'string') return 'Unknown browser';
  const ua = agent.slice(0, 512);
  // iPadOS Safari asks for desktop sites, so it reads as a Mac.
  const platform = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone|iPod/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Windows/.test(ua)
            ? 'Windows'
            : /Macintosh|Mac OS X/.test(ua)
              ? 'Mac'
              : /Linux/.test(ua)
                ? 'Linux'
                : '';
  const browser = /Edg(?:A|iOS)?\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /SamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /Firefox\/|FxiOS\//.test(ua)
          ? 'Firefox'
          : /Chrome\/|CriOS\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : '';
  if (browser && platform) return `${browser} on ${platform}`;
  if (platform) return `Browser on ${platform}`;
  return browser || 'Unknown browser';
}
const invalid = () =>
  new AuthError(
    401,
    'That code isn’t valid. Each code works once, within an hour of printing. Ask for a new slip.',
  );
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AuthError(400, 'Invalid authentication request.');
  return value as Record<string, unknown>;
}
function accessCode(value: unknown) {
  try {
    return parseAccessCode(value);
  } catch (error) {
    throw new AuthError(400, (error as Error).message);
  }
}
let hashing = 0;
const hashQueue: (() => void)[] = [];
async function hashWork<T>(work: () => Promise<T>, wait = false): Promise<T> {
  if (hashing < 2) hashing++;
  else if (wait) await new Promise<void>((resolve) => hashQueue.push(resolve));
  else throw new AuthError(429, 'Sign-in is busy. Try again shortly.', 2);
  try {
    return await work();
  } finally {
    // A waiting mint inherits the slot, so sign-ins can't starve it.
    const next = hashQueue.shift();
    if (next) next();
    else hashing--;
  }
}
/** Waits for a hashing slot, so a sign-in in progress never fails a mint. */
export const codeHash = (value: string) =>
  hashWork(
    () =>
      hash(value, {
        algorithm: 2,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
    true,
  );
/** The index of the hash `value` matches, or -1; one slot covers every check. */
const matchingCode = (encoded: readonly string[], value: string) =>
  hashWork(async () => {
    for (const [index, candidate] of encoded.entries())
      if (await verify(candidate, value)) return index;
    return -1;
  });

/** Database-backed one-time access codes; each opens one session, which never survives its code. */
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
    this.dummy = await codeHash(secret());
    await this.check();
    return this;
  }
  async check() {
    await this.database.$queryRaw`SELECT
      (SELECT id FROM access_codes LIMIT 1), (SELECT token_hash FROM auth_sessions LIMIT 1),
      (SELECT key FROM auth_rates LIMIT 1), (SELECT code_id FROM auth_events LIMIT 1),
      (SELECT workspace_key FROM access_workspaces LIMIT 1)`;
  }
  private valid(
    row: { expiresAt: Date; code: { revokedAt: Date | null } } | null,
  ) {
    return !!row && !row.code.revokedAt && row.expiresAt > this.now();
  }
  async session(token?: string): Promise<Identity | undefined> {
    if (!opaque(token)) return undefined;
    const row = await this.database.authSession.findUnique({
      where: { tokenHash: digest(token) },
      include: { code: true },
    });
    if (!row || !this.valid(row)) return undefined;
    return Object.freeze({
      ...parseAuthSession({
        expiresAt: row.expiresAt.toISOString(),
        authenticatedAt: row.authenticatedAt.toISOString(),
      }),
      codeId: row.codeId,
      sessionHash: row.tokenHash,
    });
  }
  async workspace(identity: Identity, browser: string) {
    return this.database.$transaction(async (tx) => {
      const browserHash = digest(browser);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'access-workspace:' + browserHash}, 0))::text`;
      // Share-locking the code makes a concurrent revoke wait, never interleave.
      await tx.$queryRaw`SELECT id FROM access_codes WHERE id = ${identity.codeId} FOR SHARE`;
      const session = await tx.authSession.findUnique({
        where: { tokenHash: identity.sessionHash },
        include: { code: true },
      });
      if (!this.valid(session))
        throw new AuthError(401, 'Sign in to continue.');
      const existing = await tx.accessWorkspace.findUnique({
        where: { browserHash },
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
      await tx.accessWorkspace.create({ data: { browserHash, workspaceKey } });
      return workspaceKey;
    });
  }
  private async audit(
    tx: Transaction | PrismaClient,
    kind: string,
    codeId?: string,
    ip?: string,
  ) {
    await tx.authEvent.create({
      data: { kind, codeId, ipHash: ip ? digest(ip) : undefined },
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
    if (method === 'GET' && path === '/api/auth/config')
      return { body: { sitekey: this.config.sitekey } };
    if (method === 'GET' && path === '/api/auth/session') {
      if (!context.identity) throw new AuthError(401, 'Sign in to continue.');
      return { body: parseAuthSession(context.identity) };
    }
    if (method !== 'POST' || !authPosts.has(path))
      throw new AuthError(404, 'Not found.');
    const body = object(input);
    if (path === '/api/auth/logout') {
      if (!context.identity) throw new AuthError(401, 'Sign in to continue.');
      await this.database.$transaction(async (tx) => {
        await tx.authSession.deleteMany({
          where: { tokenHash: context.identity!.sessionHash },
        });
        await this.audit(
          tx,
          'signed-out',
          context.identity!.codeId,
          context.ip,
        );
      });
      return { body: { ok: true }, clearSession: true };
    }
    await this.rate('operation:' + context.ip, 10, 60);
    const code = accessCode(body.code);
    await this.turnstile(body.turnstile, 'login', context.ip);
    // The global limit bounds guessing spread across many addresses.
    const keys = ['code-ip:' + context.ip, 'code-global'];
    await this.rate(keys[0], 5, 900);
    await this.rate(keys[1], 100, 900);
    const outstanding = await this.database.accessCode.findMany({
      where: {
        revokedAt: null,
        redeemedAt: null,
        redeemBy: { gt: this.now() },
      },
      orderBy: { createdAt: 'asc' },
      take: OUTSTANDING_CODE_LIMIT,
    });
    // With no code out, the dummy hash keeps a rejection as slow as a real check.
    const index = await matchingCode(
      outstanding.length ? outstanding.map((c) => c.codeHash) : [this.dummy],
      code,
    );
    const match = outstanding[index];
    if (!match) {
      await this.audit(this.database, 'code-rejected', undefined, context.ip);
      throw invalid();
    }
    return this.database.$transaction(async (tx) => {
      // Of two devices typing the same code, only the first to lock it gets in.
      await tx.$queryRaw`SELECT id FROM access_codes WHERE id = ${match.id} FOR UPDATE`;
      const current = await tx.accessCode.findUniqueOrThrow({
        where: { id: match.id },
      });
      const now = this.now();
      if (current.revokedAt || current.redeemedAt || current.redeemBy <= now)
        throw invalid();
      await this.clearFailureReservations(tx, keys);
      if (opaque(context.token))
        await tx.authSession.deleteMany({
          where: { tokenHash: digest(context.token) },
        });
      await tx.accessCode.update({
        where: { id: current.id },
        data: { redeemedAt: now },
      });
      const token = secret();
      const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3600000);
      await tx.authSession.create({
        data: {
          tokenHash: digest(token),
          codeId: current.id,
          device: deviceLabel(context.userAgent),
          authenticatedAt: now,
          expiresAt,
        },
      });
      await this.audit(tx, 'signed-in', current.id, context.ip);
      return { body: { ok: true, expiresAt: expiresAt.toISOString() }, token };
    });
  }
  async cleanup() {
    const now = this.now();
    // Small batches keep maintenance from monopolizing station transactions.
    for (const [table, column] of [
      ['auth_sessions', 'token_hash'],
      ['auth_rates', 'key'],
    ] as const) {
      const { Prisma } = await import('./generated/prisma/client');
      await this.database
        .$executeRaw(Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE ${Prisma.raw(column)} IN
        (SELECT ${Prisma.raw(column)} FROM ${Prisma.raw(table)} WHERE expires_at <= ${now} LIMIT 100)`);
    }
    // A used code is kept while its session lasts, then has nothing left to open.
    await this.database.$executeRaw`DELETE FROM access_codes WHERE id IN
      (SELECT id FROM access_codes c
        WHERE (c.redeem_by <= ${now} OR c.redeemed_at IS NOT NULL OR c.revoked_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM auth_sessions s WHERE s.code_id = c.id) LIMIT 100)`;
    await this.database.$executeRaw`DELETE FROM auth_events WHERE id IN
      (SELECT id FROM auth_events WHERE created_at < ${new Date(now.getTime() - 90 * 86400000)} LIMIT 100)`;
  }
}
