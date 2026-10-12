import { test as base, expect } from '@playwright/test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Orders } from '../printer-service/orders';
import { createApp } from '../printer-service/http';
import type { Request as PrintRequest } from '../printer-service/printing';
import { sampleTicket } from '../src/lib/tickets/ticket';

type Service = {
  url: string;
  orders: Orders;
  prints: PrintRequest[];
  activeStreams: () => number;
  restart: () => Promise<void>;
};
const test = base.extend<{ service: Service }>({
  service: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'order-pad-sse-browser-'));
    const origin = new URL('http://127.0.0.1:0');
    const root = await realpath('build');
    const prints: PrintRequest[] = [];
    let active = 0;
    let orders = new Orders(directory);
    const makeServer = () => {
      const server = createApp({
        origin,
        port: Number(origin.port),
        root,
        cups: { queue: 'TestQueue', check: async () => 'Ready' },
        orders,
        printing: {
          print: async (request) => {
            prints.push(request);
            return {
              status: 'accepted',
              simulated: false,
              message: 'Test queue submission.',
            };
          },
        },
      });
      server.on('request', (request, response) => {
        if (request.url === '/api/orders/events') {
          active++;
          response.once('close', () => active--);
        }
      });
      return server;
    };
    let server = makeServer();
    const listen = () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(origin.port), '127.0.0.1', () => {
          origin.port = String((server.address() as { port: number }).port);
          resolve();
        });
      });
    const close = () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await listen();
    const service: Service = {
      url: origin.origin,
      orders,
      prints,
      activeStreams: () => active,
      restart: async () => {
        await close();
        orders = new Orders(directory);
        service.orders = orders;
        server = makeServer();
        await listen();
      },
    };
    try {
      await use(service);
    } finally {
      await close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

test('native SSE pushes printed orders to two queues; reprints never duplicate or reopen and navigation closes streams', async ({
  page,
  context,
  service,
}) => {
  const queue = await context.newPage();
  const second = await context.newPage();
  const reads: string[] = [];
  context.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === '/api/orders'
    )
      reads.push(request.url());
  });
  await page.goto(service.url);
  await queue.goto(`${service.url}/queue/`);
  await second.goto(`${service.url}/queue/`);
  await expect(
    queue.getByRole('heading', { name: 'All caught up', exact: true }),
  ).toBeVisible();
  await expect(
    second.getByRole('heading', { name: 'All caught up', exact: true }),
  ).toBeVisible();
  await expect.poll(service.activeStreams).toBe(2);
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cup', exact: true }).click();
  await page.getByRole('button', { name: 'Print order', exact: true }).click();
  await expect(queue.getByRole('article')).toHaveCount(1);
  await expect(second.getByRole('article')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  await expect(queue.getByRole('article')).toHaveCount(1);
  await queue
    .getByRole('button', { name: 'Mark #0001 done', exact: true })
    .click();
  await expect(second.getByRole('article')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  expect(service.prints).toHaveLength(3);
  expect(service.prints[1].reprint).toBe(true);
  expect(service.prints[2].reprint).toBe(true);
  expect(await service.orders.list('open')).toEqual([]);
  await expect(queue.getByRole('article')).toHaveCount(0);
  await second
    .getByRole('button', { name: 'Undo done for #0001', exact: true })
    .click();
  await expect(queue.getByRole('article')).toHaveCount(1);
  expect(reads).toEqual([]);
  await queue.getByRole('link', { name: 'Order builder', exact: true }).click();
  await expect(queue.getByLabel('Customer name (optional)')).toBeVisible();
  await expect.poll(service.activeStreams).toBe(1);
  await second.close();
  await expect.poll(service.activeStreams).toBe(0);
});

test('native EventSource reconnects after a service restart and receives the complete durable queue', async ({
  page,
  service,
}) => {
  await service.orders.upsert(
    sampleTicket('original', new Date().toISOString()),
  );
  await page.goto(`${service.url}/queue/`);
  await expect(page.getByRole('article')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Mark #0043 done', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await service.restart();
  await service.orders.upsert({
    ...sampleTicket('after-restart', new Date().toISOString()),
    reference: '0044',
  });
  await expect(page.getByRole('article')).toHaveCount(1, { timeout: 10000 });
  await expect(page.getByRole('article')).toContainText('#0044');
  await expect(
    page.getByRole('button', { name: 'Undo done for #0043', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect.poll(service.activeStreams).toBe(1);
  await service.orders.upsert(
    sampleTicket('original', new Date().toISOString()),
  );
  expect(await service.orders.list('open')).toHaveLength(1);
});
