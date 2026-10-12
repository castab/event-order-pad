import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import type { Cups } from './cups';
import { parseRequest, type Printing } from './printing';
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
};

export function createApp({
  origin,
  port,
  root,
  cups,
  printing,
}: {
  origin: URL;
  port: number;
  root: string;
  cups: Pick<Cups, 'check' | 'queue'>;
  printing: Pick<Printing, 'print'>;
}) {
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
      const path = new URL(req.url ?? '/', origin).pathname;
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
        if (
          req.headers.origin !== origin.origin ||
          req.headers['content-type']?.split(';')[0] !== 'application/json'
        ) {
          json(403, { error: 'Use the configured same-origin application.' });
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 131072) {
            json(413, { error: 'Request too large.' });
            return;
          }
          chunks.push(chunk);
        }
        let request;
        try {
          request = parseRequest(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          );
        } catch {
          json(400, {
            error: 'Invalid ticket or attempt metadata. No data sent.',
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
      const file = await realpath(
        resolve(
          root,
          `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`,
        ),
      );
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
      if (!res.headersSent)
        json((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500, {
          error:
            'Service request failed. Inspect CUPS before retrying a print.',
        });
      else res.end();
    }
  });
  server.requestTimeout = 65000;
  return server;
}
