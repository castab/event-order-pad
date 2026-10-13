import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createOrderDatabase, PostgresOrderRepository } from './order-database';
import { PostgresStationRepository } from './station-database';
import { Printing } from './printing';
import { Cups } from './cups';
import { newDraft, parseDraft } from '../src/lib/tickets/order';
import { sampleTicket } from '../src/lib/tickets/ticket';
import type { PrintAttempt } from '../src/lib/printing/port';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a separate *_test database.');
const database = createOrderDatabase(url);
const cutoff = '2026-10-11T20:00:00.000Z';
const station = new PostgresStationRepository(database, cutoff, () => cutoff);
beforeEach(async () => {
  await database.$executeRaw`TRUNCATE workspaces, tickets, print_attempts, print_dispatches, station, order_events RESTART IDENTITY CASCADE`;
});
afterAll(() => database.$disconnect());
async function intent(id = 'ticket') {
  let snapshot = await station.load();
  const ticket = {
    ...sampleTicket(id, cutoff),
    reference: '0001',
  };
  const draft = parseDraft({
    ...snapshot.draft,
    name: ticket.customerName ?? '',
    servings: ticket.servings,
  });
  snapshot = await station.mutate({
    revision: snapshot.revision,
    operation: 'saveDraft',
    draft,
  });
  const attempt: PrintAttempt = {
    id: `attempt-${id}`,
    ticketId: id,
    startedAt: cutoff,
    reprint: false,
    mode: 'linux-cups',
  };
  return {
    ticket,
    draft: parseDraft({
      ...draft,
      reference: ticket.reference,
      submittedTicketId: id,
    }),
    attempt,
    revision: snapshot.revision,
  };
}
it('atomically commits draft, immutable ticket, intent and queue event, and reloads through another connection', async () => {
  const command = await intent();
  const saved = await station.mutate({ ...command, operation: 'startOrder' });
  const other = createOrderDatabase(url);
  try {
    expect(await new PostgresStationRepository(other, cutoff).load()).toEqual(
      saved,
    );
    expect(await new PostgresOrderRepository(other).list('open')).toHaveLength(
      1,
    );
    expect(saved.saved?.attempts[0].result).toBeUndefined();
    expect(saved.draft.submittedTicketId).toBe(command.ticket.id);
  } finally {
    await other.$disconnect();
  }
});
it('rejects stale tabs and rolls back every write if the queue event cannot commit', async () => {
  const command = await intent();
  const snapshot = await station.load();
  const [first, second] = await Promise.allSettled([
    station.mutate({
      revision: snapshot.revision,
      operation: 'saveDraft',
      draft: { ...snapshot.draft, name: 'First' },
    }),
    station.mutate({
      revision: snapshot.revision,
      operation: 'saveDraft',
      draft: { ...snapshot.draft, name: 'Second' },
    }),
  ]);
  expect([first, second].filter((r) => r.status === 'fulfilled')).toHaveLength(
    1,
  );
  await expect(
    station.mutate({ ...command, operation: 'startOrder' }),
  ).rejects.toThrow('another tab');
  const next = await intent('rollback');
  await new PostgresOrderRepository(database).upsert(next.ticket);
  const before = await station.load();
  await expect(
    station.mutate({ ...next, operation: 'startOrder' }),
  ).rejects.toThrow();
  expect(await station.load()).toEqual(before);
  expect(await database.ticket.count()).toBe(0);
  expect(await database.attempt.count()).toBe(0);
});
it('durably claims dispatch before lp, reconciles a lost response, advances once, and never replays', async () => {
  const command = await intent();
  let snapshot = await station.mutate({ ...command, operation: 'startOrder' });
  const request = {
    ticket: command.ticket,
    attemptId: command.attempt.id,
    reprint: false,
  };
  const cups = new Cups('OrderPad');
  vi.spyOn(cups, 'waitUntilIdle').mockResolvedValue();
  vi.spyOn(cups, 'prepare').mockResolvedValue({
    media: 'test',
    heightMm: 200,
    jobOptions: [],
  });
  const submit = vi.spyOn(cups, 'submit').mockImplementation(async () => {
    expect(await station.get(request.attemptId)).toEqual({ request });
    expect(await database.orderEvent.count()).toBe(1);
    return 'OrderPad-1';
  });
  const printing = new Printing(cups, station, 'Courier', async () =>
    Buffer.from('%PDF-test'),
  );
  const result = await printing.print(request);
  expect(result.status).toBe('accepted');
  expect(await new Printing(cups, station, 'Courier').print(request)).toEqual(
    result,
  );
  expect(submit).toHaveBeenCalledTimes(1);
  expect((await station.load()).saved?.attempts[0].result).toEqual(result);
  // A browser which lost the reply reports unknown; the durable service result wins.
  snapshot = await station.mutate({
    revision: snapshot.revision,
    operation: 'finishAttempt',
    attempt: {
      ...command.attempt,
      completedAt: cutoff,
      result: {
        status: 'outcome-unknown',
        simulated: false,
        code: 'transport',
        message: 'Lost reply',
      },
    },
  });
  expect(snapshot.saved?.attempts[0].result).toEqual(result);
  expect(snapshot.draft.reference).toBeUndefined();
  await expect(
    station.mutate({
      revision: snapshot.revision,
      operation: 'finishAttempt',
      attempt: snapshot.saved!.attempts[0],
    }),
  ).rejects.toThrow();
  const reprint = { ...command.attempt, id: 'reprint', reprint: true };
  await station.mutate({
    revision: snapshot.revision,
    operation: 'startAttempt',
    attempt: reprint,
  });
  expect(await database.orderEvent.count()).toBe(1);
  await station.begin({ ...request, attemptId: 'reprint', reprint: true });
  expect(
    (await printing.print({ ...request, attemptId: 'reprint', reprint: true }))
      .status,
  ).toBe('outcome-unknown');
  expect(submit).toHaveBeenCalledTimes(1);
});
it('never sends when the database fails before dispatch and blocks after an unsaved outcome', async () => {
  const command = await intent();
  await station.mutate({ ...command, operation: 'startOrder' });
  const request = {
    ticket: command.ticket,
    attemptId: command.attempt.id,
    reprint: false,
  };
  const cups = new Cups('OrderPad');
  vi.spyOn(cups, 'waitUntilIdle').mockResolvedValue();
  vi.spyOn(cups, 'prepare').mockResolvedValue({
    media: 'test',
    heightMm: 200,
    jobOptions: [],
  });
  const submit = vi.spyOn(cups, 'submit').mockResolvedValue('OrderPad-2');
  const begin = vi
    .spyOn(station, 'begin')
    .mockRejectedValueOnce(new Error('Connection lost'));
  const printing = new Printing(cups, station, 'Courier', async () =>
    Buffer.from('%PDF-test'),
  );
  expect((await printing.print(request)).status).toBe('failed');
  expect(submit).not.toHaveBeenCalled();
  begin.mockRestore();
  const finish = vi
    .spyOn(station, 'finish')
    .mockRejectedValueOnce(new Error('Lost commit'));
  expect((await printing.print(request)).status).toBe('outcome-unknown');
  expect((await printing.print(request)).status).toBe('outcome-unknown');
  expect(submit).toHaveBeenCalledTimes(1);
  finish.mockRestore();
});
it('starts above existing centralized order numbers without importing browser history', async () => {
  await new PostgresOrderRepository(database).upsert(
    sampleTicket('old', cutoff),
  );
  expect((await station.load()).draft.reference).toBeUndefined();
  const cmd = await intent('new');
  const saved = await station.mutate({ ...cmd, operation: 'startOrder' });
  expect(saved.saved?.ticket.reference).toBe('0044');
  await station.check();
});

it('runs the complete API client/session flow against Postgres and recovers through a new client', async () => {
  const { createApp } = await import('./http');
  const { Orders } = await import('./orders');
  const { DatabaseTicketStore } =
    await import('../src/lib/storage/ticket-store');
  const { PrintSession } = await import('../src/lib/printing/session');
  const { LinuxCupsPrinter } =
    await import('../src/lib/printing/adapters/linux-cups');
  const cups = new Cups('OrderPad');
  vi.spyOn(cups, 'waitUntilIdle').mockResolvedValue();
  vi.spyOn(cups, 'prepare').mockResolvedValue({
    media: 'test',
    heightMm: 200,
    jobOptions: [],
  });
  vi.spyOn(cups, 'check').mockResolvedValue('Ready');
  const submit = vi.spyOn(cups, 'submit').mockResolvedValue('OrderPad-3');
  const origin = new URL('http://127.0.0.1:0');
  const server = createApp({
    origin,
    port: 4174,
    root: '/tmp',
    cups,
    printing: new Printing(cups, station, 'Courier', async () =>
      Buffer.from('%PDF-test'),
    ),
    station,
    orders: new Orders(new PostgresOrderRepository(database), cutoff),
    trackingEnabled: false,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin.port = String((server.address() as { port: number }).port);
  let cookie = '';
  const send: typeof fetch = async (input, init) => {
    const response = await fetch(`${origin.origin}${input}`, {
      ...init,
      headers: {
        ...init?.headers,
        Origin: origin.origin,
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
    return response;
  };
  try {
    const store = new DatabaseTicketStore(send);
    let id = 0;
    const session = new PrintSession(
      store,
      () => {},
      () => `api-${++id}`,
      () => cutoff,
    );
    await session.initialize();
    expect(session.state.phase).toBe('ready');
    session.updateDraft({
      ...session.state.draft!,
      name: 'Shared',
      editor: {
        flavors: [{ flavor: 'Vanilla', count: 1 }],
        container: 'Cup',
        toppings: [],
      },
    });
    await session.submit(new LinuxCupsPrinter(send));
    expect(session.state.phase).toBe('ready');
    expect(session.state.attempts[0].result?.status).toBe('accepted');
    expect(session.state.draft?.reference).toBeUndefined();
    const reload = new PrintSession(new DatabaseTicketStore(send), () => {});
    await reload.initialize();
    expect(reload.state.ticket).toEqual(session.state.ticket);
    expect(reload.state.draft).toEqual(session.state.draft);
    expect(reload.state.attempts).toEqual(session.state.attempts);
    await reload.print(new LinuxCupsPrinter(send), true);
    expect(reload.state.phase).toBe('ready');
    expect(reload.state.attempts).toHaveLength(2);
    expect(reload.state.draft?.reference).toBeUndefined();
    expect(await database.orderEvent.count()).toBe(1);
    expect(submit).toHaveBeenCalledTimes(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('isolates browser revisions and allocates unique numbers atomically across concurrent workspaces', async () => {
  const a = await station.load('browser-a');
  const b = await station.load('browser-b');
  const servings = sampleTicket('sample', cutoff).servings;
  const [readyA, readyB] = await Promise.all([
    station.mutate(
      {
        operation: 'saveDraft',
        revision: a.revision,
        draft: { ...a.draft, name: 'Alice', servings },
      },
      'browser-a',
    ),
    station.mutate(
      {
        operation: 'saveDraft',
        revision: b.revision,
        draft: { ...b.draft, name: 'Bob', servings },
      },
      'browser-b',
    ),
  ]);
  const attempt = (id: string): PrintAttempt => ({
    id: 'attempt-' + id,
    ticketId: id,
    mode: 'linux-cups',
    reprint: false,
    startedAt: cutoff,
  });
  const [printedA, printedB] = await Promise.all([
    station.mutate(
      {
        operation: 'startOrder',
        revision: readyA.revision,
        attempt: attempt('alice'),
      },
      'browser-a',
    ),
    station.mutate(
      {
        operation: 'startOrder',
        revision: readyB.revision,
        attempt: attempt('bob'),
      },
      'browser-b',
    ),
  ]);
  expect(
    [printedA.saved!.ticket.reference, printedB.saved!.ticket.reference].sort(),
  ).toEqual(['0001', '0002']);
  expect(printedA.saved!.ticket.displayName).toBe('Alice');
  expect(printedB.saved!.ticket.displayName).toBe('Bob');
  expect(await station.load('browser-a')).toEqual(printedA);
  expect(await station.load('browser-b')).toEqual(printedB);
  const request = {
    ticket: printedA.saved!.ticket,
    attemptId: 'attempt-alice',
    reprint: false,
  };
  await expect(station.authorizePrint(request, 'browser-b')).rejects.toThrow(
    'another workspace',
  );
  await expect(
    station.mutate(
      {
        operation: 'finishAttempt',
        revision: printedB.revision,
        attempt: {
          ...attempt('alice'),
          completedAt: cutoff,
          result: {
            status: 'failed',
            simulated: false,
            code: 'transport',
            message: 'No job submitted.',
          },
        },
      },
      'browser-b',
    ),
  ).rejects.toThrow('workspace');
  await expect(
    station.mutate(
      {
        operation: 'startAttempt',
        revision: printedB.revision,
        attempt: { ...attempt('alice'), id: 'foreign-reprint', reprint: true },
      },
      'browser-b',
    ),
  ).rejects.toThrow('latest ticket');
  await expect(
    station.mutate(
      {
        operation: 'saveTicket',
        revision: printedB.revision,
        ticket: printedA.saved!.ticket,
      },
      'browser-b',
    ),
  ).rejects.toThrow();
  expect(await database.orderEvent.count()).toBe(2);
});

it('a rolled-back intent consumes no reference and a recovered pending attempt cannot dispatch', async () => {
  const command = await intent('rollback-number');
  await new PostgresOrderRepository(database).upsert(command.ticket);
  await expect(
    station.mutate({
      operation: 'startOrder',
      revision: command.revision,
      attempt: command.attempt,
    }),
  ).rejects.toThrow('already exists');
  expect(await database.station.count()).toBe(0);
  await database.orderEvent.deleteMany();
  const committed = await station.mutate({
    operation: 'startOrder',
    revision: command.revision,
    attempt: command.attempt,
  });
  expect(committed.saved!.ticket.reference).toBe('0001');
  await station.mutate({
    operation: 'finishAttempt',
    revision: committed.revision,
    attempt: {
      ...command.attempt,
      completedAt: cutoff,
      result: {
        status: 'outcome-unknown',
        simulated: false,
        code: 'transport',
        message: 'Lost reply.',
      },
    },
  });
  await expect(
    station.begin({
      ticket: committed.saved!.ticket,
      attemptId: command.attempt.id,
      reprint: false,
    }),
  ).rejects.toThrow('pending');
  expect(await database.printDispatch.count()).toBe(0);
});

it('atomically attaches legacy recovery state to only the first initializing browser', async () => {
  const ticket = sampleTicket('legacy-owner', cutoff);
  await database.workspace.create({
    data: {
      id: 'legacy',
      revision: 4,
      draft: JSON.parse(
        JSON.stringify({ ...newDraft(), name: 'Recovered draft' }),
      ),
    },
  });
  await database.ticket.create({
    data: {
      id: ticket.id,
      content: JSON.parse(JSON.stringify(ticket)),
      workspaceId: 'legacy',
    },
  });
  await database.workspace.update({
    where: { id: 'legacy' },
    data: { latestTicketId: ticket.id },
  });
  const [a, b] = await Promise.all([
    station.load('new-browser-a'),
    station.load('new-browser-b'),
  ]);
  expect([a, b].filter((s) => s.draft.name === 'Recovered draft')).toHaveLength(
    1,
  );
  const adopted = a.draft.name ? 'new-browser-a' : 'new-browser-b';
  expect((await station.load(adopted)).saved?.ticket).toEqual(ticket);
  expect(await database.workspace.count()).toBe(2);
  expect(await database.ticket.count()).toBe(1);
});
