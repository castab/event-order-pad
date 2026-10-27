import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from './generated/prisma/client';
import {
  applyMenuChange,
  MenuConflict,
  parseMenu,
  type Menu,
  type MenuChange,
} from '../src/lib/tickets/menu';

/** What builders read: the current menu and a cheap revision to notice changes. */
export interface MenuSource {
  load(): Promise<Menu>;
  revision(): Promise<number>;
}
/** What the tailnet admin also gets: one revision-checked change at a time. */
export interface MenuStore extends MenuSource {
  change(change: MenuChange, revision: number): Promise<Menu>;
}

const allChoices = (menu: Menu) => [
  ...menu.flavor,
  ...menu.container,
  ...menu.topping,
];

async function revisionIn(tx: Prisma.TransactionClient): Promise<number> {
  const row = await tx.station.findUnique({
    where: { id: 1 },
    select: { menuRevision: true },
  });
  return Number(row?.menuRevision ?? 0n);
}

/** Reads and validates the whole menu inside a caller's transaction. */
export async function readMenu(tx: Prisma.TransactionClient): Promise<Menu> {
  const choices = await tx.choice.findMany({
    orderBy: [{ category: 'asc' }, { position: 'asc' }],
  });
  return parseMenu({ revision: await revisionIn(tx), choices });
}

/** The `fionas_choices` table; changes serialize on one lock and bump the revision. */
export class PostgresMenu implements MenuStore {
  constructor(
    private database: PrismaClient,
    private id = randomUUID,
  ) {}
  load() {
    // One snapshot, so the revision always matches the choices returned.
    return this.database.$transaction((tx) => readMenu(tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
  async revision() {
    const rows = await this.database.$queryRaw<
      { revision: bigint | null }[]
    >`SELECT (SELECT menu_revision FROM station WHERE id = 1) AS revision`;
    return Number(rows[0]?.revision ?? 0n);
  }
  change(change: MenuChange, revision: number) {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(721405)::text`;
      const before = await readMenu(tx);
      if (before.revision !== revision) throw new MenuConflict();
      const after = applyMenuChange(before, change, this.id);
      const kept = new Set(after.map((c) => c.id));
      const removed = allChoices(before).filter((c) => !kept.has(c.id));
      if (removed.length)
        await tx.choice.deleteMany({
          where: { id: { in: removed.map((c) => c.id) } },
        });
      const existing = new Map(allChoices(before).map((c) => [c.id, c]));
      for (const choice of after) {
        const data = choice.data as unknown as Prisma.InputJsonValue;
        const old = existing.get(choice.id);
        if (
          old &&
          old.position === choice.position &&
          JSON.stringify(old.data) === JSON.stringify(choice.data)
        )
          continue;
        if (old)
          await tx.choice.update({
            where: { id: choice.id },
            data: { position: choice.position, data },
          });
        else
          await tx.choice.create({
            data: {
              id: choice.id,
              category: choice.category,
              position: choice.position,
              data,
            },
          });
      }
      const next = BigInt(revision + 1);
      await tx.station.upsert({
        where: { id: 1 },
        create: { id: 1, menuRevision: next },
        update: { menuRevision: next },
      });
      return readMenu(tx);
    });
  }
}
