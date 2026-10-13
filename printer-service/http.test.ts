import { afterEach, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtemp, rm, writeFile, realpath, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PrintAttemptResult } from '../src/lib/printing/port';
import type { Request } from './printing';
import { Orders } from './orders';
import {
  MemoryOrderRepository,
  testCaptureFrom,
} from '../tests/helpers/order-repository';
import { MemoryStationRepository } from '../tests/helpers/station';
import { createApp } from './http';
import { newDraft } from '../src/lib/tickets/order';
import { sampleTicket } from '../src/lib/tickets/ticket';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function app(trackingEnabled = true) {
  const directory = await mkdtemp(join(tmpdir(), 'order-pad-http-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<h1>Order Pad</h1>');
  const print = vi.fn<(request: Request) => Promise<PrintAttemptResult>>(
    async () => ({
      status: 'accepted' as const,
      simulated: false,
      message: 'Queue submission.',
    }),
  );
  const check = vi.fn(async () => 'Configured queue');
  const repository = new MemoryOrderRepository();
  const orders = new Orders(
    repository,
    testCaptureFrom,
    () => '2026-10-12T19:00:00.000Z',
  );
  await mkdir(join(directory, 'queue'));
  await writeFile(join(directory, 'queue/index.html'), '<h1>Build queue</h1>');
  const station = new MemoryStationRepository(repository);
  const server = createApp({
    origin: new URL('https://mint.test'),
    port: 4174,
    root: await realpath(directory),
    cups: { check, queue: 'OrderPad' },
    printing: { print },
    orders,
    trackingEnabled,
    station,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const port = (server.address() as { port: number }).port;
  const send = (
    path: string,
    body?: string,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; body: string; cache: string | undefined }>(
      (resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method: body === undefined ? 'GET' : 'POST',
            headers: { Host: 'mint.test', ...headers },
          },
          (res) => {
            let response = '';
            res.on('data', (chunk) => {
              response += chunk.toString();
            });
            res.on('end', () =>
              resolve({
                status: res.statusCode!,
                body: response,
                cache: res.headers['cache-control'],
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(body);
      },
    );
  return { print, check, send, orders, server, port, directory, station };
}
const payload = JSON.stringify({
  attemptId: 'attempt-1',
  reprint: false,
  ticket: sampleTicket('ticket-1', '2026-10-11T20:00:00.000Z'),
});
const headers = {
  Origin: 'https://mint.test',
  'Content-Type': 'application/json',
};

async function capture(
  send: Awaited<ReturnType<typeof app>>['send'],
  ticket = JSON.parse(payload).ticket,
) {
  const state = JSON.parse((await send('/api/station')).body);
  const response = await send(
    '/api/station',
    JSON.stringify({
      revision: state.revision,
      operation: 'startOrder',
      ticket,
      draft: {
        ...newDraft(String(Number(ticket.reference) - 1)),
        name: ticket.customerName ?? '',
        servings: ticket.servings,
        submittedTicketId: ticket.id,
      },
      attempt: {
        id: `intent-${ticket.id}`,
        ticketId: ticket.id,
        mode: 'linux-cups',
        reprint: false,
        startedAt: ticket.createdAt,
      },
    }),
    headers,
  );
  expect(response.status).toBe(200);
}

it('serves the static app and live status without caching API results', async () => {
  const { send, check } = await app();
  expect((await send('/')).body).toContain('Order Pad');
  const status = await send('/api/printer');
  expect(status.cache).toBe('no-store');
  expect(JSON.parse(status.body).ready).toBe(true);
  expect(JSON.parse(status.body).queue).toBe('OrderPad');
  check.mockRejectedValue(new Error('Queue disabled'));
  const unavailable = JSON.parse((await send('/api/printer')).body);
  expect(unavailable.ready).toBe(false);
  expect(unavailable.queue).toBe('OrderPad');
  expect((await send('/api/unknown')).status).toBe(404);
});
it('rejects unrelated hosts, foreign/missing origins, non-JSON and invalid/oversized tickets before printing', async () => {
  const { send, print } = await app();
  expect(
    (await send('/api/print', payload, { ...headers, Host: 'evil.test' }))
      .status,
  ).toBe(403);
  expect(
    (
      await send('/api/print', payload, {
        ...headers,
        Origin: 'https://evil.test',
      })
    ).status,
  ).toBe(403);
  expect((await send('/api/print', payload)).status).toBe(403);
  expect(
    (
      await send('/api/print', payload, {
        ...headers,
        'Content-Type': 'text/plain',
      })
    ).status,
  ).toBe(403);
  expect((await send('/api/print', '{}', headers)).status).toBe(400);
  expect((await send('/api/print', 'x'.repeat(131073), headers)).status).toBe(
    413,
  );
  expect(print).not.toHaveBeenCalled();
});
it('correlates a same-origin submission and prevents file escape', async () => {
  const { send, print } = await app();
  const result = await send('/api/print', payload, headers);
  expect(result.cache).toBe('no-store');
  expect(JSON.parse(result.body).attemptId).toBe('attempt-1');
  expect(print).toHaveBeenCalledTimes(1);
  expect((await send('/%2e%2e%2fpackage.json')).status).not.toBe(200);
});

it('serves the queue route with and without its trailing slash', async () => {
  const { send } = await app();
  expect((await send('/queue')).body).toContain('Build queue');
  expect((await send('/queue/')).body).toContain('Build queue');
  expect((await send('/queue/%2e%2e%2f%2e%2e%2fpackage.json')).status).not.toBe(
    200,
  );
});

it('upserts once, preserves original content and done status, and only explicit undo reopens', async () => {
  const { send, print } = await app();
  const ticket = sampleTicket(
    'ticket/id with spaces',
    '2026-10-11T20:00:00.000Z',
  );
  const create = await send('/api/orders', JSON.stringify(ticket), headers);
  expect(create.status).toBe(201);
  expect(create.cache).toBe('no-store');
  expect(JSON.parse(create.body)).toMatchObject({
    created: true,
    order: { status: 'open', ticket },
  });
  const done = await send(
    `/api/orders/${encodeURIComponent(ticket.id)}/done`,
    '{}',
    headers,
  );
  expect(done.status).toBe(200);
  const completed = JSON.parse(done.body).order;
  const repeated = await send(
    '/api/orders',
    JSON.stringify({
      ...ticket,
      customerName: 'Changed',
      displayName: 'Changed',
    }),
    headers,
  );
  expect(repeated.status).toBe(200);
  expect(JSON.parse(repeated.body)).toEqual({
    created: false,
    order: completed,
  });
  expect(
    JSON.parse((await send('/api/orders?status=open')).body).orders,
  ).toEqual([]);
  expect(
    JSON.parse((await send('/api/orders?status=done')).body).orders,
  ).toEqual([completed]);
  const undo = await send(
    `/api/orders/${encodeURIComponent(ticket.id)}/reopen`,
    '{}',
    headers,
  );
  expect(JSON.parse(undo.body).order).toMatchObject({
    status: 'open',
    submittedAt: completed.submittedAt,
    ticket,
  });
  expect(JSON.parse(undo.body).order.doneAt).toBeUndefined();
  expect(JSON.parse((await send('/api/orders')).body).orders).toHaveLength(1);
  expect(print).not.toHaveBeenCalled();
});

it('first USB submission registers even a failed/unknown result; reprints never add or reopen an order', async () => {
  const { send, print } = await app();
  const ticket = JSON.parse(payload).ticket;
  const reprint = (attemptId: string, override = ticket) =>
    JSON.stringify({ attemptId, reprint: true, ticket: override });
  await send(
    '/api/print',
    reprint('legacy-reprint', { ...ticket, id: 'historical-only' }),
    headers,
  );
  expect(JSON.parse((await send('/api/orders')).body).orders).toEqual([]);
  await capture(send);
  await send('/api/print', payload, headers);
  const initial = JSON.parse((await send('/api/orders')).body).orders;
  expect(initial).toHaveLength(1);
  await send('/api/print', reprint('reprint-open'), headers);
  expect(JSON.parse((await send('/api/orders')).body).orders).toEqual(initial);
  await send('/api/orders/ticket-1/done', '{}', headers);
  const completed = JSON.parse((await send('/api/orders')).body).orders;
  await send('/api/print', reprint('reprint-done'), headers);
  expect(JSON.parse((await send('/api/orders')).body).orders).toEqual(
    completed,
  );
  // Repeated first submission is also an idempotent no-op after completion.
  await send('/api/print', payload, headers);
  expect(JSON.parse((await send('/api/orders')).body).orders).toEqual(
    completed,
  );
  for (const status of ['failed', 'outcome-unknown'] as const) {
    print.mockResolvedValueOnce({
      status,
      simulated: false,
      message: 'Inspect output.',
      code: 'printer-error',
    });
    await capture(send, { ...ticket, id: status });
    const next = await send(
      '/api/print',
      JSON.stringify({
        ...JSON.parse(payload),
        ticket: { ...ticket, id: status },
        attemptId: status,
      }),
      headers,
    );
    expect(JSON.parse(next.body).result.status).toBe(status);
  }
  expect(
    JSON.parse((await send('/api/orders?status=open')).body).orders,
  ).toHaveLength(2);
});

it('protects every order mutation and rejects invalid data, filters, bodies, IDs and missing orders', async () => {
  const { send } = await app();
  for (const path of [
    '/api/orders',
    '/api/orders/ticket-1/done',
    '/api/orders/ticket-1/reopen',
  ]) {
    expect((await send(path, '{}')).status).toBe(403);
    expect(
      (await send(path, '{}', { ...headers, Origin: 'https://evil.test' }))
        .status,
    ).toBe(403);
    expect(
      (await send(path, '{}', { ...headers, 'Content-Type': 'text/plain' }))
        .status,
    ).toBe(403);
    expect((await send(path, '{', headers)).status).toBe(400);
    expect((await send(path, 'x'.repeat(131073), headers)).status).toBe(413);
  }
  expect((await send('/api/orders', '{}', headers)).status).toBe(400);
  expect((await send('/api/orders?status=bad')).status).toBe(400);
  expect((await send('/api/orders?status=done&status=open')).status).toBe(400);
  expect((await send('/api/orders/missing/done', '{}', headers)).status).toBe(
    404,
  );
  expect((await send('/api/orders/%ZZ/done', '{}', headers)).status).toBe(400);
  expect((await send('/api/orders/%00/done', '{}', headers)).status).toBe(400);
  expect((await send('/api/orders')).cache).toBe('no-store');
});

it('blocks all API work when the required database is unavailable', async () => {
  const { send, station, print, check } = await app();
  vi.spyOn(station, 'check').mockRejectedValue(new Error('Database down'));
  for (const path of [
    '/api/database',
    '/api/station',
    '/api/printer',
    '/api/features',
    '/api/orders',
  ])
    expect((await send(path)).status).toBe(503);
  expect((await send('/api/print', payload, headers)).status).toBe(503);
  expect(print).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
});

async function stream(port: number, headers: Record<string, string> = {}) {
  const events: { event: string; data: any }[] = [];
  let wake: (() => void) | undefined;
  const req = request({
    host: '127.0.0.1',
    port,
    path: '/api/orders/events',
    headers: { Host: 'mint.test', ...headers },
  });
  const response = await new Promise<import('node:http').IncomingMessage>(
    (resolve, reject) => {
      req.on('response', resolve);
      req.on('error', reject);
      req.end();
    },
  );
  let buffer = '';
  response.on('data', (chunk) => {
    buffer += chunk.toString();
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (event && data) {
        events.push({ event, data: JSON.parse(data) });
        wake?.();
      }
    }
  });
  response.on('error', () => {});
  const close = () => {
    req.destroy();
    response.destroy();
  };
  closers.push(async () => close());
  return {
    response,
    events,
    close,
    next: async (count: number) => {
      while (events.length < count)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('SSE event timeout')),
            1500,
          );
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      return events[count - 1].data;
    },
  };
}
it('streams initial data and durable changes to multiple clients; no-op and reprint never broadcast', async () => {
  const { port, orders, send } = await app();
  const a = await stream(port);
  const b = await stream(port);
  const initial = await a.next(1);
  await b.next(1);
  expect(a.response.headers['content-type']).toContain('text/event-stream');
  expect(a.response.headers['cache-control']).toContain('no-store');
  expect(a.response.headers['x-accel-buffering']).toBe('no');
  expect(initial).toMatchObject({ revision: 0, orders: [] });
  await capture(send);
  await send('/api/print', payload, headers);
  expect((await a.next(2)).orders).toHaveLength(1);
  await b.next(2);
  const result = await send('/api/orders/ticket-1/done', '{}', headers);
  expect(JSON.parse(result.body)).toMatchObject({
    instanceId: initial.instanceId,
    revision: 2,
  });
  expect((await a.next(3)).orders[0].status).toBe('done');
  await b.next(3);
  await send(
    '/api/print',
    JSON.stringify({
      ...JSON.parse(payload),
      attemptId: 'reprint',
      reprint: true,
    }),
    headers,
  );
  await send(
    '/api/orders',
    JSON.stringify(JSON.parse(payload).ticket),
    headers,
  );
  await send('/api/orders/ticket-1/done', '{}', headers);
  await orders.list();
  expect(a.events).toHaveLength(3);
  expect(b.events).toHaveLength(3);
  a.close();
  await send('/api/orders/ticket-1/reopen', '{}', headers);
  expect((await b.next(4)).orders[0].status).toBe('open');
  const reconnected = await stream(port, { 'Last-Event-ID': 'old' });
  expect(await reconnected.next(1)).toMatchObject({
    revision: 3,
    orders: [{ status: 'open' }],
  });
});
it('rejects foreign SSE origins and reports unavailable storage before streaming headers', async () => {
  const { port, send, orders } = await app();
  expect(
    (
      await send('/api/orders/events', undefined, {
        Origin: 'https://evil.test',
      })
    ).status,
  ).toBe(403);
  expect(
    (await send('/api/orders/events', undefined, { Host: 'evil.test' })).status,
  ).toBe(403);
  expect(
    (
      await send('/api/orders/events', undefined, {
        'Sec-Fetch-Site': 'cross-site',
      })
    ).status,
  ).toBe(403);
  vi.spyOn(orders, 'subscribe').mockRejectedValue(
    new Error('Database unavailable'),
  );
  const failed = await send('/api/orders/events');
  expect(failed.status).toBe(503);
  expect(JSON.parse(failed.body).error).toContain('database');
});
it('closing the HTTP server disconnects SSE clients and releases subscriptions', async () => {
  const { port, server } = await app();
  const client = await stream(port);
  await client.next(1);
  const disconnected = new Promise<void>((resolve) =>
    client.response.once('close', resolve),
  );
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnected;
  // The fixture's normal cleanup calls close again; a closed server is already safe.
  closers.splice(closers.length - 2, 1);
});

it('reports the default enabled flag independently of printer readiness', async () => {
  const { send, check } = await app();
  check.mockRejectedValue(new Error('Printer unavailable'));
  const features = await send('/api/features');
  expect(features.status).toBe(200);
  expect(features.cache).toBe('no-store');
  expect(JSON.parse(features.body)).toEqual({ trackingEnabled: true });
  expect(check).not.toHaveBeenCalled();
});

it('disabled tracking hides reads but captures submissions and transitions without changing prints', async () => {
  const { send, print, orders } = await app(false);
  const ticket = sampleTicket('historical', '2026-10-11T20:00:00.000Z');
  expect(JSON.parse((await send('/api/features')).body)).toEqual({
    trackingEnabled: false,
  });
  for (const path of [
    '/api/orders',
    '/api/orders?status=done',
    '/api/orders/events',
  ]) {
    const response = await send(path);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body).code).toBe('ORDER_TRACKING_DISABLED');
  }
  expect(
    (await send('/api/orders', JSON.stringify(ticket), headers)).status,
  ).toBe(201);
  expect(
    (await send('/api/orders/historical/done', '{}', headers)).status,
  ).toBe(200);
  expect((await orders.list('done'))[0].ticket).toEqual(ticket);
  expect(
    (await send('/api/orders/historical/reopen', '{}', headers)).status,
  ).toBe(200);
  await capture(send);
  for (const status of ['accepted', 'failed', 'outcome-unknown'] as const) {
    for (const reprint of [false, true]) {
      const result: PrintAttemptResult = {
        status,
        simulated: false,
        message: 'Inspect output.',
        code: 'printer-error',
      };
      print.mockResolvedValueOnce(result);
      const response = await send(
        '/api/print',
        JSON.stringify({ ...JSON.parse(payload), reprint }),
        headers,
      );
      expect(JSON.parse(response.body).result).toEqual(result);
    }
  }
  expect(print).toHaveBeenCalledTimes(6);
  expect(await orders.list('open')).toHaveLength(2);
  expect((await send('/api/orders', '{}')).status).toBe(403);
  expect((await send('/api/orders/historical/done', '{}')).status).toBe(403);
});

it('blocks prints during a database outage even when tracking is disabled', async () => {
  const { send, station, print } = await app(false);
  vi.spyOn(station, 'check').mockRejectedValue(
    new Error('Database unavailable'),
  );
  expect(
    (
      await send(
        '/api/orders',
        JSON.stringify(JSON.parse(payload).ticket),
        headers,
      )
    ).status,
  ).toBe(503);
  expect((await send('/api/print', payload, headers)).status).toBe(503);
  expect(print).not.toHaveBeenCalled();
});

it('guards station mutations, validates bodies, and rejects stale revisions without a write', async () => {
  const { send } = await app();
  const state = JSON.parse((await send('/api/station')).body);
  const body = JSON.stringify({
    revision: state.revision,
    operation: 'saveDraft',
    draft: { ...state.draft, name: 'Updated draft' },
  });
  expect((await send('/api/station', body)).status).toBe(403);
  expect(
    (
      await send('/api/station', body, {
        ...headers,
        Origin: 'https://evil.test',
      })
    ).status,
  ).toBe(403);
  expect((await send('/api/station', '{}', headers)).status).toBe(400);
  expect((await send('/api/station', 'x'.repeat(131073), headers)).status).toBe(
    413,
  );
  expect((await send('/api/station', body, headers)).status).toBe(200);
  expect((await send('/api/station', body, headers)).status).toBe(409);
  expect((await send('/api/station')).cache).toBe('no-store');
});
