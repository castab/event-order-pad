import type { PrismaClient } from '../generated/prisma/client';

/**
 * Changes whenever staff edit, sign in, submit, print or finish an order. Timestamps are not
 * comparable here: attempt times come from browsers and drafts have none. The release being
 * installed runs this before its migrations, so it may read only what older releases created.
 */
export async function activity(database: PrismaClient): Promise<string> {
  const [row] = await database.$queryRaw<
    { activity: string }[]
  >`SELECT concat_ws(' ',
    (SELECT coalesce(sum(revision), 0) FROM workspaces),
    (SELECT coalesce(max(event_id), 0) FROM order_events),
    (SELECT count(*) FROM print_attempts),
    (SELECT count(*) FROM print_attempts WHERE content->'result' IS NULL),
    (SELECT count(*) FROM print_dispatches),
    (SELECT count(*) FROM print_dispatches WHERE result IS NULL),
    (SELECT coalesce(max(id), 0) FROM auth_events)) AS activity`;
  return row.activity;
}

/** Finished migrations; an empty database has none. */
export async function appliedMigrations(
  database: PrismaClient,
): Promise<string[]> {
  const [table] = await database.$queryRaw<{ exists: boolean }[]>`SELECT
    to_regclass('_prisma_migrations') IS NOT NULL AS exists`;
  if (!table.exists) return [];
  const rows = await database.$queryRaw<{ migration_name: string }[]>`SELECT
    migration_name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  return rows.map((row) => row.migration_name);
}
