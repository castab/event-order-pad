import { randomUUID } from 'node:crypto';
import type { PrismaClient } from './generated/prisma/client';
import { parsePassword, parseUsername } from '../src/lib/auth/model';
import { digest, passwordHash, secret } from './auth';

export const adminCommands = [
  'bootstrap',
  'invite',
  'recover',
  'disable',
  'enable',
  'list',
  'revoke',
] as const;
/** Terminal-only enrollment and recovery; never exposed through HTTP. */
export async function manageAccount(
  database: PrismaClient,
  command: string,
  name?: string,
  password?: string,
  now = new Date(),
) {
  if (!adminCommands.includes(command as (typeof adminCommands)[number]))
    throw new Error(
      'Use bootstrap, invite, recover, disable, enable, list or revoke.',
    );
  if (command === 'list')
    return database.authUser.findMany({
      select: { username: true, enabled: true, createdAt: true },
      orderBy: { username: 'asc' },
    });
  const username = parseUsername(name);
  const encoded =
    command === 'bootstrap'
      ? await passwordHash(parsePassword(password))
      : undefined;
  return database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
    const user = await tx.authUser.findUnique({ where: { username } });
    const audit = (kind: string, userId?: string) =>
      tx.authEvent.create({ data: { kind, userId } });
    if (command === 'bootstrap') {
      if (await tx.authUser.count())
        throw new Error('Accounts already exist. Use invite or recover.');
      const created = await tx.authUser.create({
        data: { id: randomUUID(), username, passwordHash: encoded },
      });
      await tx.authToken.deleteMany({ where: { username } });
      await audit('local-bootstrap', created.id);
      return { username };
    }
    if (command === 'invite' || command === 'recover') {
      if (command === 'invite' && user)
        throw new Error('That username already exists.');
      if (command === 'recover' && !user) throw new Error('User not found.');
      if (user) {
        await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${user.id} FOR UPDATE`;
        await tx.authUser.update({
          where: { id: user.id },
          data: {
            enabled: false,
            passwordHash: null,
            version: { increment: 1 },
          },
        });
        await tx.authSession.deleteMany({ where: { userId: user.id } });
        await tx.authPasskey.deleteMany({ where: { userId: user.id } });
      }
      const token = secret();
      const kind = command === 'invite' ? 'invite' : 'recover';
      const expiresAt = new Date(
        now.getTime() + (kind === 'invite' ? 86400000 : 1800000),
      );
      await tx.authToken.deleteMany({ where: { username } });
      await tx.authToken.create({
        data: {
          tokenHash: digest(token),
          kind,
          username,
          userId: user?.id,
          expiresAt,
        },
      });
      await audit('local-' + command, user?.id);
      return { username, token, expiresAt };
    }
    if (command === 'revoke') {
      await tx.authToken.deleteMany({ where: { username } });
      await audit('local-token-revoked', user?.id);
      return { username };
    }
    if (!user) throw new Error('User not found.');
    await tx.$queryRaw`SELECT id FROM auth_users WHERE id = ${user.id} FOR UPDATE`;
    if (command === 'enable' && !user.passwordHash)
      throw new Error('Recovery is required before enabling this account.');
    await tx.authUser.update({
      where: { id: user.id },
      data: { enabled: command === 'enable', version: { increment: 1 } },
    });
    await tx.authSession.deleteMany({ where: { userId: user.id } });
    await tx.authToken.deleteMany({ where: { username } });
    await audit('local-' + command, user.id);
    return { username };
  });
}
