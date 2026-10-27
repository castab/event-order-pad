import { readdir } from 'node:fs/promises';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { createOrderDatabase } from '../order-database';
import { PostgresStationRepository } from '../station-database';
import { parseDraft } from '../../src/lib/tickets/order';
import { sampleTicket } from '../../src/lib/tickets/ticket';
import { activity, appliedMigrations } from './activity';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a separate *_test database.');
const database = createOrderDatabase(url);
const cutoff = '2026-10-11T20:00:00.000Z';
const station = new PostgresStationRepository(database, cutoff, () => cutoff);
beforeEach(async () => {
  await database.$executeRaw`TRUNCATE workspaces, tickets, print_attempts, print_dispatches, station, order_events, auth_events RESTART IDENTITY CASCADE`;
});
afterAll(() => database.$disconnect());

it('changes with every draft edit, order, print outcome and sign-in, and only then', async () => {
  let snapshot = await station.load();
  const seen = new Set([await activity(database)]);
  const changed = async () => {
    const next = await activity(database);
    expect(seen.has(next)).toBe(false);
    seen.add(next);
    expect(await activity(database)).toBe(next);
  };
  const ticket = sampleTicket('ticket', cutoff);
  snapshot = await station.mutate({
    revision: snapshot.revision,
    operation: 'saveDraft',
    draft: parseDraft({ ...snapshot.draft, servings: ticket.servings }),
  });
  await changed();
  const attempt = {
    id: 'attempt',
    ticketId: ticket.id,
    startedAt: cutoff,
    reprint: false,
    mode: 'linux-cups' as const,
  };
  snapshot = await station.mutate({
    revision: snapshot.revision,
    operation: 'startOrder',
    attempt,
  });
  await changed();
  const saved = snapshot.saved!.ticket;
  const request = { attemptId: attempt.id, reprint: false, ticket: saved };
  await station.begin(request);
  await changed();
  await station.finish(request, {
    status: 'accepted',
    simulated: false,
    message: 'CUPS accepted job 1.',
  });
  await changed();
  await database.$executeRaw`INSERT INTO auth_events (kind) VALUES ('signed-in')`;
  await changed();
});

it('lists every shipped migration once deployed', async () => {
  const shipped = (await readdir('prisma/migrations', { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  expect((await appliedMigrations(database)).sort()).toEqual(shipped.sort());
});
