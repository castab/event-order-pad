import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client';
import {
  ACCESS_CODE_ALPHABET,
  ACCESS_CODE_HOURS,
  ACCESS_CODE_LENGTH,
} from '../src/lib/auth/model';
import { codeHash } from './auth';
import type { PrintOutput } from './output';
import { accessCodePdf, accessSlipHeightMm } from './receipt';

export const accessCommands = ['mint', 'status', 'revoke'] as const;
export type AccessResult =
  | {
      readonly kind: 'minted';
      readonly code: string;
      readonly expiresAt: Date;
      readonly signedOut: number;
    }
  | {
      readonly kind: 'revoked';
      readonly revoked: boolean;
      readonly signedOut: number;
    }
  | {
      readonly kind: 'status';
      readonly expiresAt?: Date;
      readonly sessions: number;
      readonly requests: readonly WaitingDevice[];
    };
export interface WaitingDevice {
  readonly id: string;
  readonly match: string;
  readonly device: string;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
}
export type SignInDecision = 'approve' | 'deny';
export type DecisionResult =
  | {
      readonly kind: 'approved' | 'denied';
      readonly id: string;
      readonly match: string;
      readonly device: string;
    }
  | { readonly kind: 'gone' };
export function newAccessCode(pick = randomInt): string {
  let code = '';
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++)
    code += ACCESS_CODE_ALPHABET[pick(ACCESS_CODE_ALPHABET.length)];
  return code;
}
/** Local CLI and tailnet admin access control; minting voids the previous code and every session it opened. */
export async function manageAccess(
  database: PrismaClient,
  command: string,
  now = new Date(),
): Promise<AccessResult> {
  if (!accessCommands.includes(command as (typeof accessCommands)[number]))
    throw new Error('Use mint, status or revoke.');
  if (command === 'status') {
    const active = await database.accessCode.findFirst({
      where: { revokedAt: null, expiresAt: { gt: now } },
      include: { _count: { select: { sessions: true } } },
    });
    const requests = active
      ? await database.signInRequest.findMany({
          where: {
            codeId: active.id,
            status: 'pending',
            expiresAt: { gt: now },
          },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    return {
      kind: 'status',
      expiresAt: active?.expiresAt,
      sessions: active?._count.sessions ?? 0,
      requests: requests.map((r) => ({
        id: r.id,
        match: r.matchNumber,
        device: r.device,
        requestedAt: r.createdAt,
        expiresAt: r.expiresAt,
      })),
    };
  }
  const code = command === 'mint' ? newAccessCode() : undefined;
  const encoded = code ? await codeHash(code) : undefined;
  return database.$transaction(async (tx): Promise<AccessResult> => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
    const previous = await tx.$queryRaw<{ id: string }[]>`
      UPDATE access_codes SET revoked_at = ${now} WHERE revoked_at IS NULL RETURNING id`;
    let signedOut = 0;
    for (const { id } of previous) {
      const { count } = await tx.authSession.deleteMany({
        where: { codeId: id },
      });
      signedOut += count;
      // Devices still waiting on the old code see their request expire.
      await tx.signInRequest.deleteMany({ where: { codeId: id } });
      await tx.authEvent.create({ data: { kind: 'code-revoked', codeId: id } });
    }
    if (!code)
      return { kind: 'revoked', revoked: previous.length > 0, signedOut };
    const expiresAt = new Date(now.getTime() + ACCESS_CODE_HOURS * 3600000);
    const id = randomUUID();
    await tx.accessCode.create({
      data: { id, codeHash: encoded!, createdAt: now, expiresAt },
    });
    await tx.authEvent.create({ data: { kind: 'code-minted', codeId: id } });
    return { kind: 'minted', code, expiresAt, signedOut };
  });
}

/**
 * Approves or denies one waiting device. Only approval creates a session, and
 * it serializes with mint and revoke, so a replaced code never gains one.
 */
export async function decideSignIn(
  database: PrismaClient,
  target: { readonly id: string } | { readonly match: string },
  decision: SignInDecision,
  now = new Date(),
): Promise<DecisionResult> {
  return database.$transaction(async (tx): Promise<DecisionResult> => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
    const rows =
      'id' in target
        ? await tx.$queryRaw<{ token_hash: string }[]>`
          SELECT token_hash FROM sign_in_requests
          WHERE id = ${target.id} AND status = 'pending' FOR UPDATE`
        : await tx.$queryRaw<{ token_hash: string }[]>`
          SELECT token_hash FROM sign_in_requests
          WHERE match_number = ${target.match} AND status = 'pending' FOR UPDATE`;
    if (!rows.length) return { kind: 'gone' };
    const request = await tx.signInRequest.findUniqueOrThrow({
      where: { tokenHash: rows[0].token_hash },
      include: { code: true },
    });
    if (
      request.expiresAt <= now ||
      request.code.revokedAt ||
      request.code.expiresAt <= now
    )
      return { kind: 'gone' };
    const approve = decision === 'approve';
    if (approve)
      await tx.authSession.create({
        data: {
          tokenHash: request.tokenHash,
          codeId: request.codeId,
          authenticatedAt: now,
          expiresAt: request.code.expiresAt,
        },
      });
    await tx.signInRequest.update({
      where: { tokenHash: request.tokenHash },
      data: { status: approve ? 'approved' : 'denied', decidedAt: now },
    });
    await tx.authEvent.create({
      data: {
        kind: approve ? 'sign-in-approved' : 'sign-in-denied',
        codeId: request.codeId,
      },
    });
    return {
      kind: approve ? 'approved' : 'denied',
      id: request.id,
      match: request.matchNumber,
      device: request.device,
    };
  });
}

/** One submission of the slip; it never enters the order dispatch journal. */
export async function printAccessSlip(
  output: Pick<PrintOutput, 'check' | 'waitUntilIdle' | 'prepare' | 'submit'>,
  code: string,
  expiresAt: Date,
  font: string,
): Promise<string> {
  await output.check();
  await output.waitUntilIdle();
  const { media, heightMm, jobOptions } =
    await output.prepare(accessSlipHeightMm);
  const pdf = await accessCodePdf(code, expiresAt, font, heightMm);
  return output.submit(
    pdf,
    media,
    'access-' + randomBytes(8).toString('hex'),
    jobOptions,
  );
}
