import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client';
import {
  ACCESS_CODE_ALPHABET,
  ACCESS_CODE_LENGTH,
  CODE_REDEEM_MINUTES,
  OUTSTANDING_CODE_LIMIT,
  parseMintCount,
} from '../src/lib/auth/model';
import { codeHash } from './auth';
import type { PrintOutput } from './output';
import { accessCodePdf, accessSlipHeightMm } from './receipt';

export interface MintedCode {
  readonly id: string;
  readonly code: string;
  readonly redeemBy: Date;
}
export interface AccessStatus {
  readonly unused: readonly {
    readonly id: string;
    readonly createdAt: Date;
    readonly redeemBy: Date;
  }[];
  readonly devices: readonly {
    readonly id: string;
    readonly device: string;
    readonly signedInAt: Date;
    readonly expiresAt: Date;
  }[];
}
export type RevokeResult =
  | {
      readonly kind: 'revoked';
      readonly voided: number;
      readonly signedOut: number;
    }
  | { readonly kind: 'gone' };
/** A change the station refused before doing anything; its message says why. */
export class AccessRefused extends Error {}
export function newAccessCode(pick = randomInt): string {
  let code = '';
  for (let i = 0; i < ACCESS_CODE_LENGTH; i++)
    code += ACCESS_CODE_ALPHABET[pick(ACCESS_CODE_ALPHABET.length)];
  return code;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const redeemable = (now: Date) => ({
  revokedAt: null,
  redeemedAt: null,
  redeemBy: { gt: now },
});

/** Mints `count` one-time codes for the local CLI and tailnet admin; nothing else changes. */
export async function mintCodes(
  database: PrismaClient,
  count: unknown,
  now = new Date(),
): Promise<readonly MintedCode[]> {
  let wanted;
  try {
    wanted = parseMintCount(count);
  } catch (error) {
    throw new AccessRefused((error as Error).message);
  }
  const codes = Array.from({ length: wanted }, () => newAccessCode());
  const hashes: string[] = [];
  for (const code of codes) hashes.push(await codeHash(code));
  return database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
    const out = await tx.accessCode.count({ where: redeemable(now) });
    if (out + wanted > OUTSTANDING_CODE_LIMIT)
      throw new AccessRefused(
        `${plural(out, 'unused code')} ${out === 1 ? 'is' : 'are'} still out, and at most ${OUTSTANDING_CODE_LIMIT} can be. Void some or let them expire first. Nothing was minted.`,
      );
    const redeemBy = new Date(now.getTime() + CODE_REDEEM_MINUTES * 60000);
    const minted: MintedCode[] = [];
    for (const [index, code] of codes.entries()) {
      const id = randomUUID();
      await tx.accessCode.create({
        data: { id, codeHash: hashes[index], createdAt: now, redeemBy },
      });
      await tx.authEvent.create({ data: { kind: 'code-minted', codeId: id } });
      minted.push(Object.freeze({ id, code, redeemBy }));
    }
    return minted;
  });
}

/** Unused codes and signed-in devices; codes themselves exist only as hashes. */
export async function accessStatus(
  database: PrismaClient,
  now = new Date(),
): Promise<AccessStatus> {
  const unused = await database.accessCode.findMany({
    where: redeemable(now),
    orderBy: { createdAt: 'asc' },
  });
  const sessions = await database.authSession.findMany({
    where: { expiresAt: { gt: now }, code: { revokedAt: null } },
    orderBy: { authenticatedAt: 'asc' },
  });
  return {
    unused: unused.map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      redeemBy: c.redeemBy,
    })),
    devices: sessions.map((s) => ({
      id: s.codeId,
      device: s.device,
      signedInAt: s.authenticatedAt,
      expiresAt: s.expiresAt,
    })),
  };
}

/**
 * Voids one code (an unused one, or the one a device signed in with) or every
 * code, and ends the sessions they opened. A sign-in racing it either commits
 * first and is signed out here, or waits on the code row and sees it revoked.
 */
export async function revokeAccess(
  database: PrismaClient,
  target: { readonly id: string } | 'all',
  now = new Date(),
): Promise<RevokeResult> {
  return database.$transaction(async (tx): Promise<RevokeResult> => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
    const rows =
      target === 'all'
        ? await tx.$queryRaw<{ id: string; unused: boolean }[]>`
          UPDATE access_codes SET revoked_at = ${now} WHERE revoked_at IS NULL
          RETURNING id, redeemed_at IS NULL AND redeem_by > ${now} AS unused`
        : await tx.$queryRaw<{ id: string; unused: boolean }[]>`
          UPDATE access_codes SET revoked_at = ${now} WHERE id = ${target.id} AND revoked_at IS NULL
          RETURNING id, redeemed_at IS NULL AND redeem_by > ${now} AS unused`;
    const ids = rows.map((r) => r.id);
    const sessions = await tx.authSession.count({
      where: { codeId: { in: ids }, expiresAt: { gt: now } },
    });
    await tx.authSession.deleteMany({ where: { codeId: { in: ids } } });
    for (const id of ids)
      await tx.authEvent.create({ data: { kind: 'code-revoked', codeId: id } });
    const voided = rows.filter((r) => r.unused).length;
    if (target !== 'all' && !voided && !sessions) return { kind: 'gone' };
    return { kind: 'revoked', voided, signedOut: sessions };
  });
}

/** One submission of one code's slip; it never enters the order dispatch journal. */
export async function printAccessSlip(
  output: Pick<PrintOutput, 'check' | 'waitUntilIdle' | 'prepare' | 'submit'>,
  code: string,
  redeemBy: Date,
  font: string,
): Promise<string> {
  await output.check();
  await output.waitUntilIdle();
  const { media, heightMm, jobOptions } =
    await output.prepare(accessSlipHeightMm);
  const pdf = await accessCodePdf(code, redeemBy, font, heightMm);
  return output.submit(
    pdf,
    media,
    'access-' + randomBytes(8).toString('hex'),
    jobOptions,
  );
}
