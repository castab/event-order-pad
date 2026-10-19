import { randomBytes } from 'node:crypto';
import {
  AuthError,
  authPosts,
  publicAuthPosts,
  sessionCookie,
  browserCookie,
  sessionSeconds,
  opaque,
  secret,
  clientIp,
  type Authentication,
} from './auth';
import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { PdfOutput, PrintOutput } from './output';
import { parseRequest, type Printing } from './printing';
import { parseTicket } from '../src/lib/tickets/ticket';
import { OrderNotFound, type Orders } from './orders';
import { OrderStream } from './order-stream';
import { StationConflict, type StationRepository } from './station-database';
import { parseStationCommand } from '../src/lib/storage/ticket-store';
import { trackingDisabledCode } from '../src/lib/orders/features';

export class BadRequest extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function readJson(
  req: IncomingMessage,
  limit = 131072,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new BadRequest(413, 'Request too large.');
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
  trackingEnabled = true,
  station,
  auth,
  proxy = 'direct',

  pdfOutput,
}: {
  origin: URL;
  port: number;
  root: string;
  cups: Pick<PrintOutput, 'check' | 'queue'>;
  printing: Pick<Printing, 'print'> & Partial<Pick<Printing, 'receipt'>>;
  orders: Pick<
    Orders,
    | 'upsert'
    | 'list'
    | 'changeStatus'
    | 'subscribe'
    | 'stationChanged'
    | 'stationUncertain'
  >;
  station: StationRepository;
  auth: Authentication;
  proxy?: 'direct' | 'cloudflare';
  trackingEnabled?: boolean;
  pdfOutput?: Pick<PdfOutput, 'check' | 'read'>;
}) {
  const streams = new Set<OrderStream>();
  const server = createServer(async (req, res) => {
    const nonce = randomBytes(18).toString('base64');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self' 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
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
        !path.startsWith('/api/') &&
        (/%2f|%5c/i.test(path) || path.includes('\\'))
      )
        throw new BadRequest(400, 'Invalid path.');
      const cookie = (name: string) =>
        req.headers.cookie
          ?.split(';')
          .map((v) => v.trim())
          .find((v) => v.startsWith(name + '='))
          ?.slice(name.length + 1);
      const cookies: string[] = [];
      const setCookie = (name: string, value: string, age: number) => {
        cookies.push(
          `${name}=${value}; Max-Age=${age}; Path=/; Secure; HttpOnly; SameSite=Strict`,
        );
        res.setHeader('Set-Cookie', cookies);
      };
      const token = cookie(sessionCookie);
      let browser = cookie(browserCookie);
      const existingBrowser = opaque(browser);
      if (!existingBrowser) browser = secret();
      let workspaceId: string | undefined;
      if (
        req.method === 'POST' &&
        (authPosts.has(path) ||
          path === '/api/station' ||
          path === '/api/print' ||
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
      const authPage = ['/login/'].includes(
        path.endsWith('/') ? path : path + '/',
      );
      const publicAsset =
        !path.startsWith('/api/') &&
        (path.startsWith('/_app/') ||
          path === '/service-worker.js' ||
          path === '/manifest.webmanifest' ||
          /\.(?:svg|png|ico|woff2|ttf)$/.test(path));
      const publicAuth =
        (req.method === 'GET' &&
          ['/api/auth/config', '/api/auth/request'].includes(path)) ||
        (req.method === 'POST' && publicAuthPosts.has(path));
      const ip =
        authPage || path.startsWith('/api/auth/')
          ? clientIp(
              req.socket.remoteAddress,
              req.headers['cf-connecting-ip'],
              proxy,
            )
          : '';
      if (authPage) await auth.ratePage(ip);
      // DB failures grant neither protected files nor API access.
      const identity = await auth.session(token);
      if (!identity && !authPage && !publicAsset && !publicAuth) {
        if (path.startsWith('/api/'))
          json(401, {
            error: 'Sign in to continue. No new job was submitted.',
            code: 'authentication-required',
          });
        else {
          res.writeHead(303, {
            Location: '/login/',
            'Cache-Control': 'no-store',
          });
          res.end();
        }
        return;
      }
      if (path.startsWith('/api/auth/')) {
        if (
          !(req.method === 'POST' && authPosts.has(path)) &&
          !(
            req.method === 'GET' &&
            [
              '/api/auth/config',
              '/api/auth/session',
              '/api/auth/request',
            ].includes(path)
          )
        ) {
          json(404, { error: 'Not found.' });
          return;
        }
        const reply = await auth.handle(
          path,
          req.method ?? 'GET',
          req.method === 'POST' ? await readJson(req) : undefined,
          {
            ip,
            browser: browser!,
            token,
            identity,
            userAgent: req.headers['user-agent'],
          },
        );
        if (!existingBrowser) setCookie(browserCookie, browser!, 31536000);
        if (reply.token) setCookie(sessionCookie, reply.token, sessionSeconds);
        if (reply.clearSession) setCookie(sessionCookie, '', 0);
        json(200, reply.body);
        return;
      }
      if (path.startsWith('/api/')) {
        try {
          await station.check();
        } catch {
          orders.stationUncertain();
          json(503, {
            error:
              'Database unavailable. Restore Postgres on this machine and reload. No new job was submitted.',
            code: 'database-unavailable',
          });
          return;
        }
      }
      const receipt = path.match(
        /^\/api\/receipts\/([A-Za-z0-9_-]{1,100})\.pdf$/,
      );
      if (
        path === '/api/station' ||
        path === '/api/print' ||
        (req.method === 'GET' && receipt && pdfOutput)
      ) {
        if (receipt && !existingBrowser) {
          json(404, { error: 'Receipt not found.' });
          return;
        }
        if (req.method === 'POST' && !existingBrowser) {
          json(409, {
            error:
              'Workspace not initialized. No job was submitted. Reload before continuing.',
          });
          return;
        }
        workspaceId = await auth.workspace(identity!, browser!);
        if (!existingBrowser) setCookie(browserCookie, browser!, 31536000);
      }
      if (req.method === 'GET' && path === '/api/database') {
        json(200, { ready: true });
        return;
      }
      if (req.method === 'GET' && path === '/api/station') {
        try {
          const snapshot = await station.load(workspaceId!);
          json(200, snapshot);
        } catch {
          json(503, {
            error: 'Database unavailable. Restore Postgres and reload.',
          });
        }
        return;
      }
      if (req.method === 'POST' && path === '/api/station') {
        if (!workspaceId) {
          json(409, {
            error: 'Workspace not initialized. Reload before continuing.',
          });
          return;
        }
        let command;
        const body = await readJson(req);
        try {
          command = parseStationCommand(body);
        } catch {
          throw new BadRequest(400, 'Invalid station operation.');
        }
        try {
          const snapshot = await station.mutate(command, workspaceId);
          if (command.operation === 'startOrder') {
            try {
              await orders.stationChanged();
            } catch {
              orders.stationUncertain();
            }
          }
          json(200, snapshot);
        } catch (error) {
          if (!(error instanceof StationConflict)) orders.stationUncertain();
          json(error instanceof StationConflict ? 409 : 503, {
            error:
              error instanceof StationConflict
                ? error.message
                : 'Database write unavailable. Reload to recover committed state; no print will be resent.',
          });
        }
        return;
      }
      if (req.method === 'GET' && path === '/api/features') {
        json(200, { trackingEnabled });
        return;
      }
      if (
        req.method === 'GET' &&
        !trackingEnabled &&
        (path === '/api/orders' || path.startsWith('/api/orders/'))
      ) {
        json(404, {
          error: 'Order tracking is disabled.',
          code: trackingDisabledCode,
        });
        return;
      }
      if (req.method === 'GET' && path === '/api/orders/events') {
        if (
          (req.headers.origin && req.headers.origin !== origin.origin) ||
          req.headers['sec-fetch-site'] === 'cross-site'
        ) {
          json(403, { error: 'Use the configured same-origin application.' });
          return;
        }
        const stream = new OrderStream(
          res,
          () => streams.delete(stream),
          async () => !!(await auth.session(token)),
          Math.max(0, Date.parse(identity!.expiresAt) - Date.now()),
        );
        streams.add(stream);
        try {
          stream.start(await orders.subscribe(stream.snapshot, stream.dispose));
        } catch {
          // No streaming headers have been sent if journal loading failed.
          if (!res.destroyed)
            json(503, {
              error:
                'Order database unavailable. Check Postgres and the service connection.',
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
              'Order database unavailable. Check Postgres and the service connection.',
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
          json('excluded' in saved || !saved.created ? 200 : 201, saved);
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
          if (pdfOutput) await pdfOutput.check();
          else await cups.check();
          json(200, {
            ready: true,
            mode: pdfOutput ? 'pdf' : 'cups',
            queue: pdfOutput ? 'PDF files' : cups.queue,
            message: pdfOutput
              ? 'PDF development mode — no physical printing. Receipt PDFs are saved on this server.'
              : `CUPS queue ${cups.queue} is configured for USB. Physical printer status is unverified.`,
          });
        } catch (error) {
          json(200, {
            ready: false,
            mode: pdfOutput ? 'pdf' : 'cups',
            queue: pdfOutput ? 'PDF files' : cups.queue,
            message: `${(error as Error).message} ${pdfOutput ? 'Check the PDF directory and font.' : 'Check CUPS on Mint.'}`,
          });
        }
        return;
      }
      if (req.method === 'GET' && receipt && pdfOutput) {
        if (!workspaceId) {
          json(404, { error: 'Receipt not found.' });
          return;
        }
        const record = await printing.receipt?.(receipt[1]);
        if (!record) {
          json(404, { error: 'Receipt not found.' });
          return;
        }
        try {
          await station.authorizePrint(record.request, workspaceId);
        } catch (error) {
          if (!(error instanceof StationConflict)) throw error;
          json(404, { error: 'Receipt not found.' });
          return;
        }
        let pdf: Buffer;
        try {
          pdf = await pdfOutput.read(receipt[1]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          json(404, { error: 'Receipt not found.' });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${receipt[1]}.pdf"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': pdf.length,
        });
        res.end(pdf);
        return;
      }
      if (req.method === 'POST' && path === '/api/print') {
        if (!workspaceId) {
          json(409, {
            error:
              'Workspace not initialized. No job was submitted. Reload before continuing.',
          });
          return;
        }
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
        try {
          await station.authorizePrint(request, workspaceId);
        } catch (error) {
          json(error instanceof StationConflict ? 409 : 503, {
            error:
              error instanceof StationConflict
                ? error.message
                : 'Database unavailable.',
            code:
              error instanceof StationConflict
                ? 'workspace-conflict'
                : 'database-unavailable',
          });
          return;
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
      const original = await readFile(file);
      // Static SvelteKit pages contain an inline hydration script. Authorize only
      // this response's script tags, without allowing arbitrary inline scripts.
      const bytes =
        extname(file) === '.html'
          ? Buffer.from(
              original
                .toString('utf8')
                .replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`),
            )
          : original;
      res.writeHead(200, {
        'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Content-Length': bytes.length,
        'Cache-Control': path.startsWith('/_app/immutable/')
          ? 'public, max-age=31536000, immutable'
          : 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error instanceof AuthError) {
        if (error.retryAfter)
          res.setHeader('Retry-After', String(error.retryAfter));
        json(error.status, {
          error: error.message,
          ...(error.status === 401 && error.message === 'Sign in to continue.'
            ? { code: 'authentication-required' }
            : {}),
        });
        return;
      }
      if (error instanceof BadRequest) {
        json(error.status, { error: error.message });
        return;
      }
      if (!res.headersSent) {
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        json(missing ? 404 : 503, {
          error: missing
            ? 'Not found.'
            : 'Service request failed. Check the service on this machine before continuing.',
        });
      } else res.end();
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
