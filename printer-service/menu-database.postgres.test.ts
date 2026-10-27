import { afterAll, beforeEach, expect, it } from 'vitest';
import { createOrderDatabase } from './order-database';
import { PostgresMenu } from './menu-database';
import { PostgresStationRepository } from './station-database';
import {
  CHOICE_CATEGORIES,
  menuNames,
  MenuConflict,
  MenuRefused,
} from '../src/lib/tickets/menu';
import { defaultChoices } from '../tests/helpers/menu';
import { resetMenu } from '../tests/helpers/menu-postgres';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a separate *_test database.');
const database = createOrderDatabase(url);
const menu = new PostgresMenu(database);

beforeEach(async () => {
  await database.$executeRaw`TRUNCATE workspaces, tickets, print_attempts, print_dispatches, station, order_events RESTART IDENTITY CASCADE`;
  await resetMenu(database);
});
afterAll(async () => {
  await resetMenu(database);
  await database.$disconnect();
});
const id = async (name: string) => {
  const current = await menu.load();
  return CHOICE_CATEGORIES.flatMap((c) => current[c]).find(
    (c) => c.data.displayName === name,
  )!.id;
};

it('seeds the menu that used to be hard-coded, in order, at revision 0', async () => {
  const current = await menu.load();
  expect(current.revision).toBe(0);
  expect(await menu.revision()).toBe(0);
  for (const category of CHOICE_CATEGORIES)
    expect(menuNames(current, category)).toEqual(defaultChoices[category]);
});

it('adds, edits, moves and removes durably, renumbering and bumping the revision', async () => {
  await menu.change(
    {
      command: 'add',
      category: 'flavor',
      displayName: 'Mint Chip',
      description: 'Cool.',
    },
    0,
  );
  await menu.change(
    { command: 'edit', id: await id('Vanilla'), displayName: 'French Vanilla' },
    1,
  );
  await menu.change(
    { command: 'move', id: await id('Mint Chip'), direction: 'up' },
    2,
  );
  const after = await menu.change(
    { command: 'remove', id: await id('Chocolate') },
    3,
  );
  expect(after.revision).toBe(4);
  expect(menuNames(after, 'flavor')).toEqual([
    'French Vanilla',
    'Strawberry',
    'Mint Chip',
    'Chocolate Chip',
  ]);
  expect(after.flavor.map((c) => c.position)).toEqual([0, 1, 2, 3]);
  const other = createOrderDatabase(url);
  try {
    const reloaded = await new PostgresMenu(other).load();
    expect(reloaded).toEqual(after);
    expect(reloaded.flavor[2].data).toEqual({
      category: 'flavor',
      displayName: 'Mint Chip',
      description: 'Cool.',
    });
    expect(await new PostgresMenu(other).revision()).toBe(4);
  } finally {
    await other.$disconnect();
  }
});

it('refuses stale revisions and refused changes without writing anything', async () => {
  await expect(
    menu.change({ command: 'remove', id: await id('Cup') }, 7),
  ).rejects.toBeInstanceOf(MenuConflict);
  await expect(
    menu.change(
      { command: 'add', category: 'topping', displayName: 'gummy bears' },
      0,
    ),
  ).rejects.toBeInstanceOf(MenuRefused);
  const current = await menu.load();
  expect(current.revision).toBe(0);
  expect(menuNames(current, 'container')).toEqual(defaultChoices.container);
});

it('serializes concurrent changes from the same revision', async () => {
  const results = await Promise.allSettled([
    menu.change(
      { command: 'add', category: 'flavor', displayName: 'Pistachio' },
      0,
    ),
    menu.change(
      { command: 'add', category: 'flavor', displayName: 'Coffee' },
      0,
    ),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([
    'fulfilled',
    'rejected',
  ]);
  const rejected = results.find((r) => r.status === 'rejected');
  expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(
    MenuConflict,
  );
  const current = await menu.load();
  expect(current.revision).toBe(1);
  expect(current.flavor).toHaveLength(5);
});

it('enforces category, matching data and unique names in the table itself', async () => {
  const insert = (category: string, data: unknown) =>
    database.$executeRaw`INSERT INTO fionas_choices (category, position, data) VALUES (${category}, 9, ${JSON.stringify(data)}::jsonb)`;
  await expect(
    insert('cone', { category: 'cone', displayName: 'Waffle' }),
  ).rejects.toThrow();
  await expect(
    insert('flavor', { category: 'topping', displayName: 'Waffle' }),
  ).rejects.toThrow();
  await expect(insert('flavor', { category: 'flavor' })).rejects.toThrow();
  await expect(
    insert('flavor', { category: 'flavor', displayName: 'VANILLA' }),
  ).rejects.toThrow();
  await expect(
    insert('topping', { category: 'topping', displayName: 'Vanilla' }),
  ).resolves.toBe(1);
});

it('shares the station row with the order counter without disturbing numbering', async () => {
  await menu.change(
    { command: 'add', category: 'topping', displayName: 'Hot Fudge' },
    0,
  );
  const cutoff = '2026-10-11T20:00:00.000Z';
  const station = new PostgresStationRepository(database, cutoff, () => cutoff);
  let snapshot = await station.load();
  snapshot = await station.mutate({
    revision: snapshot.revision,
    operation: 'saveDraft',
    draft: {
      ...snapshot.draft,
      editor: {
        flavors: [{ flavor: 'Vanilla', count: 1 }],
        container: 'Cup',
        toppings: ['Hot Fudge'],
      },
    },
  });
  const saved = await station.mutate({
    revision: snapshot.revision,
    operation: 'startOrder',
    attempt: {
      id: 'attempt-1',
      ticketId: 'ticket-1',
      startedAt: cutoff,
      reprint: false,
      mode: 'linux-cups',
    },
  });
  expect(saved.saved?.ticket.reference).toBe('0001');
  expect(saved.saved?.ticket.servings[0].toppings).toEqual(['Hot Fudge']);
  expect(await menu.revision()).toBe(1);
});
