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
  | { readonly kind: 'minted'; readonly code: string; readonly expiresAt: Date }
  | { readonly kind: 'revoked'; readonly revoked: boolean }
  | {
      readonly kind: 'status';
      readonly expiresAt?: Date;
      readonly sessions: number;
    };
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
    return {
      kind: 'status',
      expiresAt: active?.expiresAt,
      sessions: active?._count.sessions ?? 0,
    };
  }
  const code = command === 'mint' ? newAccessCode() : undefined;
  const encoded = code ? await codeHash(code) : undefined;
  return database.$transaction(async (tx): Promise<AccessResult> => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
    const previous = await tx.$queryRaw<{ id: string }[]>`
      UPDATE access_codes SET revoked_at = ${now} WHERE revoked_at IS NULL RETURNING id`;
    for (const { id } of previous) {
      await tx.authSession.deleteMany({ where: { codeId: id } });
      await tx.authEvent.create({ data: { kind: 'code-revoked', codeId: id } });
    }
    if (!code) return { kind: 'revoked', revoked: previous.length > 0 };
    const expiresAt = new Date(now.getTime() + ACCESS_CODE_HOURS * 3600000);
    const id = randomUUID();
    await tx.accessCode.create({
      data: { id, codeHash: encoded!, createdAt: now, expiresAt },
    });
    await tx.authEvent.create({ data: { kind: 'code-minted', codeId: id } });
    return { kind: 'minted', code, expiresAt };
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
