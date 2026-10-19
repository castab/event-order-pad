import { testAuth } from '../tests/helpers/auth';
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
import { adminAccessPath, adminRequestsPath } from './admin-http';
import { AuthError, authPosts, type Authentication } from './auth';
import { newDraft } from '../src/lib/tickets/order';
import { sampleTicket } from '../src/lib/tickets/ticket';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function app(
  trackingEnabled = true,
  authentication: Authentication = testAuth(),
  proxy: 'direct' | 'cloudflare' = 'direct',
  pdfMode = false,
) {
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
  const receipt = vi.fn(async () => ({
    request: JSON.parse(payload) as Request,
  }));
  const pdfRead = vi.fn(async () => Buffer.from('%PDF-test'));
  const pdfCheck = vi.fn(async () => {});
  const server = createApp({
    auth: authentication,
    proxy,
    origin: new URL('https://mint.test'),
    port: 4174,
    root: await realpath(directory),
    cups: { check, queue: 'OrderPad' },
    printing: { print, receipt },
    pdfOutput: pdfMode
      ? {
          check: pdfCheck,
          read: pdfRead,
        }
      : undefined,
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
  let cookie = '';
  const send = (
    path: string,
    body?: string,
    headers: Record<string, string> = {},
    method = body === undefined ? 'GET' : 'POST',
  ) =>
    new Promise<{
      status: number;
      body: string;
      cache: string | undefined;
      headers: import('node:http').IncomingHttpHeaders;
      contentType: string | undefined;
      disposition: string | undefined;
    }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            Host: 'mint.test',
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (res) => {
          if (res.headers['set-cookie'])
            cookie = res.headers['set-cookie'][0].split(';')[0];
          let response = '';
          res.on('data', (chunk) => {
            response += chunk.toString();
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode!,
              body: response,
              cache: res.headers['cache-control'],
              headers: res.headers,
              contentType: res.headers['content-type'],
              disposition: res.headers['content-disposition'],
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  return {
    print,
    check,
    send,
    orders,
    server,
    port,
    directory,
    station,
    receipt,
    pdfRead,
    pdfCheck,
  };
}
const payload = JSON.stringify({
  attemptId: 'attempt-1',
  reprint: false,
  ticket: {
    ...sampleTicket('ticket-1', '2026-10-11T20:00:00.000Z'),
    reference: '0001',
  },
});
const headers = {
  Origin: 'https://mint.test',
  'Content-Type': 'application/json',
};

async function capture(
  send: Awaited<ReturnType<typeof app>>['send'],
  ticket = JSON.parse(payload).ticket,
) {
  let state = JSON.parse((await send('/api/station')).body);
  if (state.draft.submittedTicketId) {
    const attempt = state.saved.attempts.at(-1);
    if (!attempt.result) {
      state = JSON.parse(
        (
          await send(
            '/api/station',
            JSON.stringify({
              revision: state.revision,
              operation: 'finishAttempt',
              attempt: {
                ...attempt,
                completedAt: ticket.createdAt,
                result: {
                  status: 'failed',
                  simulated: false,
                  code: 'transport',
                  message: 'Test only. No job submitted.',
                },
              },
            }),
            headers,
          )
        ).body,
      );
    }
    state = JSON.parse(
      (
        await send(
          '/api/station',
          JSON.stringify({
            revision: state.revision,
            operation: 'saveDraft',
            draft: newDraft(),
          }),
          headers,
        )
      ).body,
    );
  }
  state = JSON.parse(
    (
      await send(
        '/api/station',
        JSON.stringify({
          revision: state.revision,
          operation: 'saveDraft',
          draft: {
            ...newDraft(),
            name: ticket.customerName ?? '',
            servings: ticket.servings,
          },
        }),
        headers,
      )
    ).body,
  );
  const response = await send(
    '/api/station',
    JSON.stringify({
      revision: state.revision,
      operation: 'startOrder',
      attempt: {
        id: ticket.id === 'ticket-1' ? 'attempt-1' : ticket.id,
        ticketId: ticket.id,
        mode: 'linux-cups',
        reprint: false,
        startedAt: ticket.createdAt,
      },
    }),
    headers,
  );
  expect(response.status).toBe(200);
  return JSON.parse(response.body).saved.ticket;
}

async function registerReprint(
  send: Awaited<ReturnType<typeof app>>['send'],
  id: string,
) {
  const state = JSON.parse((await send('/api/station')).body);
  await send(
    '/api/station',
    JSON.stringify({
      revision: state.revision,
      operation: 'startAttempt',
      attempt: {
        id,
        ticketId: state.saved.ticket.id,
        mode: 'linux-cups',
        reprint: true,
        startedAt: state.saved.ticket.createdAt,
      },
    }),
    headers,
  );
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
  await send('/api/station');
  expect((await send('/api/print', '{}', headers)).status).toBe(400);
  expect((await send('/api/print', 'x'.repeat(131073), headers)).status).toBe(
    413,
  );
  expect(print).not.toHaveBeenCalled();
});
it('correlates a same-origin submission and prevents file escape', async () => {
  const { send, print } = await app();
  await capture(send);
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
  await registerReprint(send, 'reprint-open');
  await send('/api/print', reprint('reprint-open'), headers);
  expect(JSON.parse((await send('/api/orders')).body).orders).toEqual(initial);
  await send('/api/orders/ticket-1/done', '{}', headers);
  const completed = JSON.parse((await send('/api/orders')).body).orders;
  await registerReprint(send, 'reprint-done');
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
    const assigned = await capture(send, { ...ticket, id: status });
    const next = await send(
      '/api/print',
      JSON.stringify({
        ...JSON.parse(payload),
        ticket: assigned,
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
  await registerReprint(send, 'reprint');
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

it('issues a private workspace cookie and rejects missing-cookie writes without mutations', async () => {
  const { send, station, print } = await app();
  const result = await send(
    '/api/station',
    JSON.stringify({
      operation: 'saveDraft',
      revision: 0,
      draft: { ...newDraft(), name: 'No workspace' },
    }),
    headers,
  );
  expect(result.status).toBe(409);
  expect((await station.load()).draft.name).toBe('');
  expect((await send('/api/print', payload, headers)).status).toBe(409);
  expect(print).not.toHaveBeenCalled();
  const first = await send('/api/station');
  expect(first.status).toBe(200);
  const changed = await send(
    '/api/station',
    JSON.stringify({
      operation: 'saveDraft',
      revision: JSON.parse(first.body).revision,
      draft: { ...newDraft(), name: 'My workspace' },
    }),
    headers,
  );
  expect(changed.status).toBe(200);
  expect(JSON.parse((await send('/api/station')).body).draft.name).toBe(
    'My workspace',
  );
  const foreign = await send('/api/print', payload, {
    ...headers,
    Cookie: '__Host-order-pad-browser=' + 'f'.repeat(64),
  });
  expect(foreign.status).toBe(409);
  expect(print).not.toHaveBeenCalled();
});

it('requires authentication for every operational route and protected page, including HEAD', async () => {
  const auth = testAuth({ session: async () => undefined });
  const { send, print, station, check } = await app(true, auth);
  const load = vi.spyOn(station, 'load');
  for (const path of ['/', '/queue/', '/enroll/', '/recover/']) {
    const reply = await send(path);
    expect(reply.status).toBe(303);
    expect(reply.headers.location).toBe('/login/');
    expect(reply.cache).toBe('no-store');
    expect((await send(path, undefined, {}, 'HEAD')).status).toBe(303);
  }
  for (const path of [
    '/api/station',
    '/api/database',
    '/api/printer',
    '/api/features',
    '/api/orders',
    '/api/orders/events',
  ]) {
    const reply = await send(path);
    expect(reply.status).toBe(401);
    expect(JSON.parse(reply.body).code).toBe('authentication-required');
  }
  for (const path of [
    '/api/print',
    '/api/station',
    '/api/orders',
    '/api/orders/id/done',
    '/api/orders/id/reopen',
  ])
    expect((await send(path, '{}', headers)).status).toBe(401);
  expect(load).not.toHaveBeenCalled();
  expect(print).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
});
it('reports a missing static file without suggesting a printer failure', async () => {
  const { send } = await app();
  const reply = await send('/missing-page/');
  expect(reply.status).toBe(404);
  expect(JSON.parse(reply.body)).toEqual({ error: 'Not found.' });
});
it('guards every authentication POST and provides no HTTP access-code administration', async () => {
  const handle = vi.fn(testAuth().handle);
  const { send } = await app(true, testAuth({ handle }));
  for (const path of authPosts) {
    expect((await send(path, '{}')).status).toBe(403);
    expect(
      (await send(path, '{}', { ...headers, Origin: 'https://foreign.test' }))
        .status,
    ).toBe(403);
  }
  expect(handle).not.toHaveBeenCalled();
  expect([...authPosts]).toEqual([
    '/api/auth/login',
    '/api/auth/cancel',
    '/api/auth/logout',
  ]);
  for (const path of [
    '/api/auth/bootstrap',
    '/api/auth/mint',
    '/api/auth/enroll',
    '/api/auth/recover',
    '/api/auth/password',
    '/api/auth/logout-all',
    '/api/auth/passkey/login/options',
  ])
    expect((await send(path, '{}', headers)).status).toBe(404);
  expect((await send('/api/auth/passkeys')).status).toBe(404);
  // Access administration exists only on the separate tailnet socket listener.
  const tailnet = {
    'Tailscale-App-Capabilities': JSON.stringify({
      'fionasicecream.com/cap/order-pad-admin': [{}],
    }),
  };
  for (const body of [undefined, '{"command":"mint","confirm":true}'])
    expect(
      (await send(adminAccessPath, body, { ...headers, ...tailnet })).status,
    ).toBe(404);
  expect(
    (
      await send(adminRequestsPath, '{"decision":"approve","id":"x"}', {
        ...headers,
        ...tailnet,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await send(adminAccessPath, undefined, {
        ...tailnet,
        Host: 'station.example.ts.net:8443',
      })
    ).status,
  ).toBe(403);
});
it('lets a waiting device check and cancel its sign-in request without a session', async () => {
  const handle = vi.fn(async () => ({
    body: { status: 'none' },
    clearSession: true,
  }));
  const { send, station } = await app(
    true,
    testAuth({ session: async () => undefined, handle }),
  );
  const load = vi.spyOn(station, 'load');
  const token = 'b'.repeat(64);
  const status = await send('/api/auth/request', undefined, {
    Cookie: '__Host-order-pad-session=' + token,
    'User-Agent': 'Mozilla/5.0 (iPhone) Safari/604.1',
  });
  expect(status.status).toBe(200);
  expect(handle).toHaveBeenLastCalledWith(
    '/api/auth/request',
    'GET',
    undefined,
    expect.objectContaining({
      token,
      identity: undefined,
      userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1',
    }),
  );
  expect((await send('/api/auth/cancel', '{}')).status).toBe(403);
  const cancelled = await send('/api/auth/cancel', '{}', headers);
  expect(cancelled.status).toBe(200);
  expect(
    cancelled.headers['set-cookie']!.some((c) =>
      c.startsWith('__Host-order-pad-session=; Max-Age=0'),
    ),
  ).toBe(true);
  // A pending request opens nothing else.
  expect((await send('/api/auth/session')).status).toBe(401);
  expect((await send('/api/station')).status).toBe(401);
  expect(load).not.toHaveBeenCalled();
});
it('sets secure authentication cookies and returns rate-limit Retry-After headers', async () => {
  const auth = testAuth({
    handle: async () => ({
      body: { ok: true },
      token: 'a'.repeat(64),
    }),
  });
  const { send } = await app(true, auth);
  const reply = await send('/api/auth/login', '{}', headers);
  const cookies = reply.headers['set-cookie']!;
  expect(
    cookies.some(
      (c) =>
        c.startsWith('__Host-order-pad-session=') &&
        c.includes('Max-Age=28800'),
    ),
  ).toBe(true);
  for (const cookie of cookies)
    expect(cookie).toMatch(/Path=\/; Secure; HttpOnly; SameSite=Strict/);
  auth.ratePage = async () => {
    throw new AuthError(429, 'Too many attempts.', 60);
  };
  const limited = await send('/login/');
  expect(limited.status).toBe(429);
  expect(limited.headers['retry-after']).toBe('60');
});
it('fails closed when authentication persistence fails and rejects a forged tunnel hop', async () => {
  const auth = testAuth({
    session: async () => {
      throw new Error('database down');
    },
  });
  const { send, print } = await app(true, auth);
  expect((await send('/')).status).toBe(503);
  expect((await send('/api/print', '{}', headers)).status).toBe(503);
  expect(print).not.toHaveBeenCalled();
  const cloud = await app(true, testAuth(), 'cloudflare');
  expect((await cloud.send('/login/')).status).toBe(403);
  expect(
    (
      await cloud.send('/api/auth/login', '{}', {
        ...headers,
        'X-Forwarded-For': '192.0.2.1',
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await cloud.send('/api/auth/login', '{}', {
        ...headers,
        'CF-Connecting-IP': '192.0.2.1',
      })
    ).status,
  ).toBe(200);
});
it('does not permit encoded path separators to bypass the protected-page gate', async () => {
  const { send } = await app(
    true,
    testAuth({ session: async () => undefined }),
  );
  for (const path of ['/_app/%2f..%2findex.html', '/login/%2f..%2findex.html'])
    expect((await send(path)).status).toBe(400);
});

it('authorizes inline hydration scripts with per-response CSP nonces and never caches HTML', async () => {
  const { send, directory } = await app();
  await writeFile(
    join(directory, 'index.html'),
    '<script>window.test=true</script><script src="/_app/test.js"></script>',
  );
  const first = await send('/');
  const second = await send('/');
  const nonce = /<script nonce="([^"]+)"/.exec(first.body)![1];
  expect(first.headers['content-security-policy']).toContain(
    "'nonce-" + nonce + "'",
  );
  expect(first.headers['content-security-policy']).not.toContain(
    "script-src 'unsafe-inline'",
  );
  expect(second.body).not.toContain(nonce);
  expect(first.cache).toBe('no-store');
});
it('revokes an open SSE subscription before sending the next order snapshot', async () => {
  const identity = (await testAuth().session())!;
  let valid = true;
  const { port, orders } = await app(
    true,
    testAuth({ session: async () => (valid ? identity : undefined) }),
  );
  const client = await stream(port);
  await client.next(1);
  const closed = new Promise<void>((resolve) =>
    client.response.once('close', resolve),
  );
  valid = false;
  await orders.upsert(
    sampleTicket('after-revocation', '2026-10-12T19:00:00.000Z'),
  );
  await closed;
  expect(client.events).toHaveLength(1);
});

it('serves saved PDFs only to the owning workspace, without rendering or printing', async () => {
  const { send, receipt, pdfRead, print, check } = await app(
    true,
    testAuth(),
    'direct',
    true,
  );
  expect((await send('/api/receipts/attempt-1.pdf')).status).toBe(404);
  const captured = await capture(send);
  receipt.mockResolvedValue({
    request: { ticket: captured, attemptId: 'attempt-1', reprint: false },
  });
  const response = await send('/api/receipts/attempt-1.pdf');
  expect(response.status).toBe(200);
  expect(response.body).toBe('%PDF-test');
  expect(response.cache).toBe('no-store');
  expect(response.contentType).toBe('application/pdf');
  expect(response.disposition).toBe('inline; filename="attempt-1.pdf"');
  expect((await send('/api/printer')).body).toContain('"mode":"pdf"');
  expect(
    (
      await send('/api/receipts/attempt-1.pdf', undefined, {
        Cookie: '__Host-order-pad-browser=' + 'f'.repeat(64),
      })
    ).status,
  ).toBe(404);
  expect(pdfRead).toHaveBeenCalledTimes(1);
  expect(print).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
});

it('does not regenerate missing PDFs, gates viewing on database health, and disables viewing in CUPS mode', async () => {
  const { send, receipt, pdfRead, station } = await app(
    true,
    testAuth(),
    'direct',
    true,
  );
  const captured = await capture(send);
  receipt.mockResolvedValue({
    request: { ticket: captured, attemptId: 'attempt-1', reprint: false },
  });
  pdfRead.mockRejectedValueOnce(
    Object.assign(new Error('Missing'), { code: 'ENOENT' }),
  );
  expect((await send('/api/receipts/attempt-1.pdf')).status).toBe(404);
  vi.spyOn(station, 'check').mockRejectedValue(new Error('Database down'));
  expect((await send('/api/receipts/attempt-1.pdf')).status).toBe(503);
  expect(pdfRead).toHaveBeenCalledTimes(1);
  const cups = await app();
  expect((await cups.send('/api/receipts/attempt-1.pdf')).status).toBe(404);
  expect(cups.pdfRead).not.toHaveBeenCalled();
});

it('requires authentication before looking up or reading a saved receipt PDF', async () => {
  const auth = testAuth({ session: async () => undefined });
  const { send, receipt, pdfRead } = await app(true, auth, 'direct', true);
  const reply = await send('/api/receipts/attempt-1.pdf');
  expect(reply.status).toBe(401);
  expect(JSON.parse(reply.body).code).toBe('authentication-required');
  expect(receipt).not.toHaveBeenCalled();
  expect(pdfRead).not.toHaveBeenCalled();
});
