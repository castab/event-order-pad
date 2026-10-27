import { readFileSync } from 'node:fs';
import type { PrismaClient } from '../../printer-service/generated/prisma/client';

/** Restores the menu with the migration's own seed statement, so tests also check the seed. */
export async function resetMenu(client: PrismaClient) {
  const sql = readFileSync(
    'prisma/migrations/20261026000000_fionas_choices/migration.sql',
    'utf8',
  );
  const seed = sql.slice(sql.indexOf('INSERT INTO fionas_choices'));
  await client.$executeRaw`TRUNCATE fionas_choices`;
  await client.$executeRawUnsafe(seed);
}
