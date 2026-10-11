import { afterEach, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './http';
import { sampleTicket } from '../src/lib/tickets/ticket';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});
async function app() {
  const directory = await mkdtemp(join(tmpdir(), 'order-pad-http-'));
  closers.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), '<h1>Order Pad</h1>');
  const print = vi.fn(async () => ({
    status: 'accepted' as const,
    simulated: false,
    message: 'Queue submission.',
  }));
  const check = vi.fn(async () => 'Configured queue');
  const server = createApp({
    origin: new URL('https://mint.test'),
    port: 4174,
    root: await realpath(directory),
    cups: { check, queue: 'OrderPad' },
    printing: { print },
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
  return { print, check, send };
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

it('serves the static app and live status without caching API results', async () => {
  const { send, check } = await app();
  expect((await send('/')).body).toContain('Order Pad');
  const status = await send('/api/printer');
  expect(status.cache).toBe('no-store');
  expect(JSON.parse(status.body).ready).toBe(true);
  check.mockRejectedValue(new Error('Queue disabled'));
  expect(JSON.parse((await send('/api/printer')).body).ready).toBe(false);
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
