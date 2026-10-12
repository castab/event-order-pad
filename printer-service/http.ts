import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Cups } from './cups';
import { parseRequest, type Printing } from './printing';
import { parseTicket } from '../src/lib/tickets/ticket';
import { OrderNotFound, type Orders } from './orders';
import { OrderStream } from './order-stream';

class BadRequest extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 131072) throw new BadRequest(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BadRequest(400, 'Invalid JSON request.');
  }
}

const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

export function createApp({
  origin,
  port,
  root,
  cups,
  printing,
  orders,
}: {
  origin: URL;
  port: number;
  root: string;
  cups: Pick<Cups, 'check' | 'queue'>;
  printing: Pick<Printing, 'print'>;
  orders: Pick<Orders, 'upsert' | 'list' | 'changeStatus' | 'subscribe'>;
}) {
  const streams = new Set<OrderStream>();
  const server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(body));
    };
    if (
      req.headers.host !== origin.host &&
      req.headers.host !== `127.0.0.1:${port}` &&
      req.headers.host !== `localhost:${port}`
    ) {
      json(403, { error: 'Unrecognized host.' });
      return;
    }
    try {
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname;
      if (
        req.method === 'POST' &&
        (path === '/api/print' ||
          path === '/api/orders' ||
          path.startsWith('/api/orders/'))
      ) {
        if (
          req.headers.origin !== origin.origin ||
          req.headers['content-type']?.split(';')[0] !== 'application/json'
        ) {
          json(403, { error: 'Use the configured same-origin application.' });
          return;
        }
      }
      if (req.method === 'GET' && path === '/api/orders/events') {
        if (
          (req.headers.origin && req.headers.origin !== origin.origin) ||
          req.headers['sec-fetch-site'] === 'cross-site'
        ) {
          json(403, { error: 'Use the configured same-origin application.' });
          return;
        }
        const stream = new OrderStream(res, () => streams.delete(stream));
        streams.add(stream);
        try {
          stream.start(await orders.subscribe(stream.snapshot));
        } catch {
          // No streaming headers have been sent if journal loading failed.
          if (!res.destroyed)
            json(503, {
              error:
                'Order journal unavailable. Preserve the journal and restore service storage.',
            });
          if (res.destroyed) stream.dispose();
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/orders') {
        const status = url.searchParams.get('status');
        if (
          (status !== null && status !== 'open' && status !== 'done') ||
          url.searchParams.getAll('status').length > 1
        )
          throw new BadRequest(400, 'Status must be open or done.');
        try {
          json(200, { orders: await orders.list(status ?? undefined) });
        } catch {
          json(503, {
            error:
              'Order journal unavailable. Preserve the journal and restore service storage.',
          });
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/orders') {
        let ticket;
        const body = await readJson(req);
        try {
          ticket = parseTicket(body);
        } catch {
          throw new BadRequest(400, 'Invalid order ticket.');
        }
        try {
          const saved = await orders.upsert(ticket);
          json(saved.created ? 201 : 200, saved);
        } catch {
          json(503, {
            error:
              'Could not save the order. Retry the order update; do not resend a print.',
          });
        }
        return;
      }
      const transition = /^\/api\/orders\/([^/]+)\/(done|reopen)$/.exec(path);
      if (req.method === 'POST' && transition) {
        await readJson(req);
        let id: string;
        try {
          id = decodeURIComponent(transition[1]);
        } catch {
          throw new BadRequest(400, 'Invalid order ID.');
        }
        if (
          !id ||
          Array.from(id).length > 100 ||
          /[\p{Cc}\u2028\u2029]/u.test(id)
        )
          throw new BadRequest(400, 'Invalid order ID.');
        try {
          json(
            200,
            await orders.changeStatus(
              id,
              transition[2] === 'done' ? 'done' : 'open',
            ),
          );
        } catch (error) {
          json(error instanceof OrderNotFound ? 404 : 503, {
            error:
              error instanceof OrderNotFound
                ? 'Order not found.'
                : 'Could not save order status. Refresh the queue before trying again.',
          });
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/printer') {
        try {
          await cups.check();
          json(200, {
            ready: true,
            queue: cups.queue,
            message: `CUPS queue ${cups.queue} is configured for USB. Physical printer status is unverified.`,
          });
        } catch (error) {
          json(200, {
            ready: false,
            queue: cups.queue,
            message: `${(error as Error).message} Check CUPS on Mint.`,
          });
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/print') {
        let request;
        try {
          request = parseRequest(await readJson(req));
        } catch (error) {
          if (error instanceof BadRequest) throw error;
          json(400, {
            error: 'Invalid ticket or attempt metadata. No data sent.',
          });
          return;
        }
        if (!request.reprint) {
          try {
            await orders.upsert(request.ticket);
          } catch {
            console.warn(
              'Order journal update failed; the browser outbox will retry without resending the print.',
            );
          }
        }
        json(200, {
          attemptId: request.attemptId,
          result: await printing.print(request),
        });
        return;
      }
      if (
        !['GET', 'HEAD'].includes(req.method ?? '') ||
        path.startsWith('/api/')
      ) {
        json(404, { error: 'Not found.' });
        return;
      }
      let file = await realpath(
        resolve(
          root,
          `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`,
        ),
      );
      if (!file.startsWith(`${root}${sep}`)) {
        json(404, { error: 'Not found.' });
        return;
      }
      if ((await stat(file)).isDirectory())
        file = await realpath(resolve(file, 'index.html'));
      if (!file.startsWith(`${root}${sep}`) || !(await stat(file)).isFile()) {
        json(404, { error: 'Not found.' });
        return;
      }
      const bytes = await readFile(file);
      res.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': path.startsWith('/_app/immutable/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error instanceof BadRequest) {
        json(error.status, { error: error.message });
        return;
      }
      if (!res.headersSent)
        json((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, {
          error:
            'Service request failed. Inspect CUPS before retrying a print.',
        });
      else res.end();
    }
  });
  const close = server.close;
  server.close = function (...args: Parameters<typeof close>) {
    for (const stream of streams) stream.dispose();
    return close.apply(this, args);
  };
  server.requestTimeout = 65000;
  return server;
}
