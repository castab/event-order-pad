import { testAuth } from '../tests/helpers/auth';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { resetMenu } from '../tests/helpers/menu-postgres';
import { createOrderDatabase, PostgresOrderRepository } from './order-database';
import { Orders, OrderNotFound } from './orders';
import { PostgresMenu } from './menu-database';
import { PostgresStationRepository } from './station-database';
import { createApp } from './http';
import { sampleTicket } from '../src/lib/tickets/ticket';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';

const url = process.env.TEST_DATABASE_URL!;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw new Error('Use a separate *_test database.');
const database = createOrderDatabase(url);
const repository = new PostgresOrderRepository(database);
const cutoff = '2026-10-11T20:00:00.000Z';
const ticket = sampleTicket('ticket-43', cutoff);

beforeAll(async () => {
  const [version] = await database.$queryRaw<
    { version: string }[]
  >`SELECT current_setting('server_version_num') AS version`;
  expect(Number(version.version)).toBeGreaterThanOrEqual(180000);
  expect(Number(version.version)).toBeLessThan(190000);
});
beforeEach(async () => {
  await database.$executeRaw`TRUNCATE workspaces, tickets, print_attempts, print_dispatches, station, order_events RESTART IDENTITY CASCADE`;
  await resetMenu(database);
});
afterAll(async () => {
  await database.$disconnect();
});

it('applies constraints and validates every database read', async () => {
  await expect(
    database.orderEvent.create({
      data: {
        orderId: ticket.id,
        occurredAt: new Date(cutoff),
        eventType: 'wrong',
        orderJsonb: {},
      },
    }),
  ).rejects.toThrow();
  await repository.upsert(ticket);
  await expect(
    database.orderEvent.create({
      data: {
        orderId: ticket.id,
        occurredAt: new Date(cutoff),
        eventType: 'submitted',
        orderJsonb: JSON.parse(JSON.stringify(ticket)),
      },
    }),
  ).rejects.toThrow();
  await database.orderEvent.updateMany({
    data: { orderJsonb: { id: ticket.id, schema: 1 } },
  });
  await expect(repository.list()).rejects.toThrow();
});

it('uses database locks to create once across separate clients and never replace or reopen a ticket', async () => {
  const other = createOrderDatabase(url);
  try {
    const second = new PostgresOrderRepository(other);
    const saved = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        (n % 2 ? second : repository).upsert(ticket),
      ),
    );
    expect(saved.filter((s) => s.created)).toHaveLength(1);
    expect(await database.orderEvent.count()).toBe(1);
    const completions = await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        (n % 2 ? second : repository).changeStatus(
          ticket.id,
          'done',
          '2026-10-11T20:05:00.000Z',
        ),
      ),
    );
    expect(completions.filter((change) => change.changed)).toHaveLength(1);
    const duplicate = await second.upsert({
      ...ticket,
      displayName: 'Changed',
      customerName: 'Changed',
    });
    expect(duplicate).toMatchObject({
      created: false,
      order: { status: 'done', ticket },
    });
    expect(await database.orderEvent.count()).toBe(2);
  } finally {
    await other.$disconnect();
  }
});

it('appends immutable complete events for actual transitions and derives state across restarts', async () => {
  await repository.upsert(ticket);
  const at = '2026-10-11T20:05:00.000Z';
  await repository.changeStatus(ticket.id, 'done', at);
  expect(
    (
      await repository.changeStatus(
        ticket.id,
        'done',
        '2026-10-11T20:06:00.000Z',
      )
    ).changed,
  ).toBe(false);
  const restarted = createOrderDatabase(url);
  try {
    const reloaded = new PostgresOrderRepository(restarted);
    expect(await reloaded.list('done')).toMatchObject([
      { status: 'done', doneAt: at, submittedAt: cutoff, ticket },
    ]);
    expect(
      (
        await reloaded.changeStatus(
          ticket.id,
          'open',
          '2026-10-11T20:07:00.000Z',
        )
      ).changed,
    ).toBe(true);
    expect(
      (
        await reloaded.changeStatus(
          ticket.id,
          'open',
          '2026-10-11T20:08:00.000Z',
        )
      ).changed,
    ).toBe(false);
    expect(await reloaded.list('done')).toEqual([]);
    expect(await reloaded.list('open')).toMatchObject([
      { status: 'open', submittedAt: cutoff, ticket },
    ]);
    const events = await database.orderEvent.findMany({
      orderBy: { eventId: 'asc' },
    });
    expect(events.map((e) => e.eventType)).toEqual([
      'submitted',
      'completed',
      'reopened',
    ]);
    expect(events.map((e) => e.orderJsonb)).toEqual([ticket, ticket, ticket]);
    await expect(
      reloaded.changeStatus('missing', 'done', at),
    ).rejects.toBeInstanceOf(OrderNotFound);
  } finally {
    await restarted.$disconnect();
  }
});

it('projects latest state before filtering and limits only current completions to eight', async () => {
  for (let n = 0; n < 10; n++) {
    const value = {
      ...ticket,
      id: `order-${n}`,
      createdAt: `2026-10-11T20:${String(n).padStart(2, '0')}:00.000Z`,
    };
    await repository.upsert(value);
    await repository.changeStatus(
      value.id,
      'done',
      `2026-10-11T21:${String(n).padStart(2, '0')}:00.000Z`,
    );
  }
  expect((await repository.list('done')).map((o) => o.ticket.id)).toEqual([
    'order-9',
    'order-8',
    'order-7',
    'order-6',
    'order-5',
    'order-4',
    'order-3',
    'order-2',
  ]);
  expect(await repository.list('open')).toEqual([]);
  await repository.changeStatus('order-0', 'open', '2026-10-11T22:00:00.000Z');
  await repository.changeStatus('order-9', 'open', '2026-10-11T22:01:00.000Z');
  expect((await repository.list('open')).map((o) => o.ticket.id)).toEqual([
    'order-0',
    'order-9',
  ]);
  expect((await repository.list('done')).map((o) => o.ticket.id)).toEqual([
    'order-8',
    'order-7',
    'order-6',
    'order-5',
    'order-4',
    'order-3',
    'order-2',
    'order-1',
  ]);
  expect(await database.orderEvent.count()).toBe(22);
});

it('orders events by identity even with equal or backwards timestamps', async () => {
  await repository.upsert(ticket);
  await repository.changeStatus(ticket.id, 'done', cutoff);
  await repository.changeStatus(ticket.id, 'open', '2026-10-11T19:00:00.000Z');
  expect(await repository.list('done')).toEqual([]);
  expect(await repository.list('open')).toHaveLength(1);
});

it('captures with tracking off, excludes pre-cutoff tickets, and blocks prints during outages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'order-pad-postgres-http-'));
  const unavailable = createOrderDatabase(
    'postgresql://none:none@127.0.0.1:1/none',
  );
  const prints: string[] = [];
  async function serve(orders: Orders, stationDatabase = database) {
    const server = createApp({
      auth: testAuth(),
      origin: new URL('https://mint.test'),
      port: 4174,
      root: directory,
      trackingEnabled: false,
      station: new PostgresStationRepository(stationDatabase, cutoff),
      menu: new PostgresMenu(stationDatabase),
      cups: { queue: 'Test', check: async () => 'Ready' },
      orders,
      printing: {
        print: async (value) => {
          prints.push(value.ticket.id);
          return {
            status: 'accepted',
            simulated: false,
            message: 'Test submission.',
          };
        },
      },
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    let cookie = '';
    const send = (path: string, body?: unknown) =>
      new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = request(
          {
            hostname: '127.0.0.1',
            port,
            path,
            method: body ? 'POST' : 'GET',
            headers: {
              Host: 'mint.test',
              ...(cookie ? { Cookie: cookie } : {}),
              Origin: 'https://mint.test',
              'Content-Type': 'application/json',
            },
          },
          (res) => {
            cookie = res.headers['set-cookie']?.[0].split(';')[0] ?? cookie;
            let text = '';
            res.on('data', (chunk) => {
              text += chunk;
            });
            res.on('end', () =>
              resolve({ status: res.statusCode!, body: JSON.parse(text) }),
            );
          },
        );
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    return {
      send,
      close: () =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
  const live = await serve(new Orders(repository, cutoff, () => cutoff));
  try {
    const old = {
      ...ticket,
      id: 'older',
      createdAt: '2026-10-11T19:59:59.999Z',
    };
    expect(await live.send('/api/orders', old)).toEqual({
      status: 200,
      body: { excluded: true, ticketId: old.id },
    });
    let state = (await live.send('/api/station')).body;
    state = (
      await live.send('/api/station', {
        operation: 'saveDraft',
        revision: state.revision,
        draft: {
          ...state.draft,
          name: ticket.customerName,
          servings: ticket.servings,
        },
      })
    ).body;
    const firstAttempt = {
      id: 'first',
      ticketId: ticket.id,
      mode: 'linux-cups',
      reprint: false,
      startedAt: cutoff,
    };
    state = (
      await live.send('/api/station', {
        operation: 'startOrder',
        revision: state.revision,
        attempt: firstAttempt,
      })
    ).body;
    const committedTicket = state.saved.ticket;
    expect(
      (
        await live.send('/api/print', {
          attemptId: 'first',
          reprint: false,
          ticket: committedTicket,
        })
      ).body.result.status,
    ).toBe('accepted');
    expect((await live.send(`/api/orders/${ticket.id}/done`, {})).status).toBe(
      200,
    );
    expect((await live.send('/api/orders')).status).toBe(404);
    expect(
      (await live.send(`/api/orders/${ticket.id}/reopen`, {})).status,
    ).toBe(200);
    state = (
      await live.send('/api/station', {
        operation: 'startAttempt',
        revision: state.revision,
        attempt: { ...firstAttempt, id: 'second', reprint: true },
      })
    ).body;
    expect(
      (
        await live.send('/api/print', {
          attemptId: 'second',
          reprint: true,
          ticket: committedTicket,
        })
      ).body.result.status,
    ).toBe('accepted');
    expect(await database.orderEvent.count()).toBe(3);
    expect(
      await database.orderEvent.count({ where: { orderId: old.id } }),
    ).toBe(0);
  } finally {
    await live.close();
  }
  const offline = await serve(
    new Orders(new PostgresOrderRepository(unavailable), cutoff),
    unavailable,
  );
  try {
    expect((await offline.send('/api/orders', ticket)).status).toBe(503);
    expect(
      (await offline.send(`/api/orders/${ticket.id}/done`, {})).status,
    ).toBe(503);
    expect(
      (
        await offline.send('/api/print', {
          attemptId: 'offline',
          reprint: false,
          ticket,
        })
      ).status,
    ).toBe(503);
    expect(prints).toEqual([ticket.id, ticket.id]);
  } finally {
    await offline.close();
    await unavailable.$disconnect();
    await rm(directory, { recursive: true, force: true });
  }
});
