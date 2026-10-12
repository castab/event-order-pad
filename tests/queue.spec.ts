import { test, expect, type BrowserContext } from '@playwright/test';
import {
  parseTicket,
  sampleTicket,
  type OrderTicket,
  type Serving,
} from '../src/lib/tickets/ticket';
import {
  parseOrder,
  sortOrders,
  type QueueOrder,
} from '../src/lib/orders/order';

test.use({
  viewport: { width: 1180, height: 820 },
  timezoneId: 'America/Los_Angeles',
});
const now = '2026-10-12T19:00:00.000Z';
const before = (minutes: number) =>
  new Date(Date.parse(now) - minutes * 60000).toISOString();
const serving = (
  flavor: Serving['flavors'][number]['flavor'],
  count = 1,
  container: Serving['container'] = 'Cup',
  toppings: Serving['toppings'] = [],
): Serving => ({ flavors: [{ flavor, count }], container, toppings });
function fixtures(): QueueOrder[] {
  const values = [
    {
      reference: '0040',
      customerName: 'Happy Sprinkle',
      servings: [
        serving('Chocolate', 2, 'Cup', [
          'Chocolate Sauce',
          'Maraschino Cherries',
        ]),
        {
          ...serving('Vanilla', 1, 'Cake Cone'),
          flavors: [
            { flavor: 'Vanilla', count: 1 },
            { flavor: 'Strawberry', count: 1 },
          ],
        },
      ],
    },
    {
      reference: '0041',
      customerName: 'Dana',
      servings: [
        serving('Chocolate Chip', 1, 'Sugar Cone', ['Sliced Almonds']),
      ],
    },
    {
      reference: '0042',
      customerName: 'Lucky Waffle',
      servings: [
        serving('Vanilla', 3, 'Cup', [
          'Whipped cream',
          'Caramel Sauce',
          'Maraschino Cherries',
        ]),
        serving('Strawberry'),
        {
          ...serving('Chocolate', 1, 'Sugar Cone', ['Gummy Bears']),
          flavors: [
            { flavor: 'Chocolate', count: 1 },
            { flavor: 'Chocolate Chip', count: 1 },
          ],
        },
        serving('Vanilla', 1, 'Cake Cone'),
      ],
    },
    sampleTicket('t43', before(1)),
  ];
  const open = values.map((value, index) =>
    parseOrder({
      ticket: parseTicket({
        schema: 2,
        id: `t${40 + index}`,
        createdAt: before([12, 7, 4, 1][index]),
        ...value,
      }),
      submittedAt: before([12, 7, 4, 1][index]),
      status: 'open',
    }),
  );
  const done = parseOrder({
    ticket: parseTicket({
      schema: 2,
      id: 't39',
      createdAt: before(18),
      reference: '0039',
      customerName: 'Jolly Cone',
      servings: [serving('Vanilla')],
    }),
    submittedAt: before(18),
    status: 'done',
    doneAt: before(2),
  });
  return [...open.reverse(), done];
}
async function backend(
  context: BrowserContext,
  initial: readonly QueueOrder[] = [],
) {
  const records = new Map(initial.map((order) => [order.ticket.id, order]));
  const publications: OrderTicket[] = [];
  const prints: { ticket: OrderTicket; reprint: boolean; attemptId: string }[] =
    [];
  const mutations: string[] = [];
  let listFails = false;
  let mutationFails = false;
  let publishFails = false;
  const upsert = (ticket: OrderTicket) => {
    const existing = records.get(ticket.id);
    if (existing) return { order: existing, created: false };
    const order = parseOrder({
      ticket,
      submittedAt: ticket.createdAt,
      status: 'open',
    });
    records.set(ticket.id, order);
    return { order, created: true };
  };
  await context.route('**/api/orders**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (listFails)
        return route.fulfill({
          status: 503,
          json: { error: 'Service unavailable' },
        });
      return route.fulfill({
        json: {
          orders: [
            ...sortOrders([...records.values()], 'open'),
            ...sortOrders([...records.values()], 'done').slice(0, 8),
          ],
        },
      });
    }
    if (path === '/api/orders') {
      const ticket = parseTicket(request.postDataJSON());
      publications.push(ticket);
      if (publishFails)
        return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      const result = upsert(ticket);
      return route.fulfill({
        status: result.created ? 201 : 200,
        json: result,
      });
    }
    mutations.push(path);
    if (mutationFails)
      return route.fulfill({
        status: 503,
        json: { error: 'Storage unavailable' },
      });
    const match = /^\/api\/orders\/([^/]+)\/(done|reopen)$/.exec(path)!;
    const id = decodeURIComponent(match[1]);
    const order = records.get(id);
    if (!order)
      return route.fulfill({ status: 404, json: { error: 'Missing order' } });
    const updated = parseOrder({
      ticket: order.ticket,
      submittedAt: order.submittedAt,
      status: match[2] === 'done' ? 'done' : 'open',
      ...(match[2] === 'done' ? { doneAt: now } : {}),
    });
    records.set(id, updated);
    return route.fulfill({ json: { order: updated } });
  });
  await context.route('**/api/printer', (route) =>
    route.fulfill({
      json: {
        ready: true,
        queue: 'Star_TSP143',
        message: 'Configured USB queue.',
      },
    }),
  );
  await context.route('**/api/print', (route) => {
    const request = route.request().postDataJSON();
    prints.push(request);
    if (!request.reprint && !publishFails) upsert(parseTicket(request.ticket));
    return route.fulfill({
      json: {
        attemptId: request.attemptId,
        result: {
          status: 'accepted',
          simulated: false,
          message: 'Queue submission.',
        },
      },
    });
  });
  return {
    records,
    publications,
    prints,
    mutations,
    upsert,
    failList: (value: boolean) => {
      listFails = value;
    },
    failMutations: (value: boolean) => {
      mutationFails = value;
    },
    failPublish: (value: boolean) => {
      publishFails = value;
    },
  };
}

test('queue matches the reference: oldest-first cards, totals, menu details, local times and wait badges', async ({
  page,
  context,
}, testInfo) => {
  await backend(context, fixtures());
  await page.clock.install({ time: new Date(now) });
  await page.goto('/queue/');
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(0)).toHaveAttribute(
    'aria-label',
    'Order #0040 · Happy Sprinkle',
  );
  await expect(cards.nth(1)).toHaveAttribute(
    'aria-label',
    'Order #0041 · Dana',
  );
  await expect(cards.nth(2)).toHaveAttribute(
    'aria-label',
    'Order #0042 · Lucky Waffle',
  );
  await expect(cards.nth(3)).toHaveAttribute(
    'aria-label',
    'Order #0043 · Maria',
  );
  const totals = page.getByLabel('Queue totals');
  await expect(totals).toContainText('4');
  await expect(totals).toContainText('10');
  await expect(totals).toContainText('12m');
  await expect(cards.nth(0).getByLabel('Wait 12 min')).toHaveClass(/rust/);
  await expect(cards.nth(1).getByLabel('Wait 7 min')).toHaveClass(/olive/);
  await expect(cards.nth(2).getByLabel('Wait 4 min')).toHaveClass(/moss/);
  await expect(cards.nth(0).locator('time')).toHaveText('11:48 AM');
  await expect(cards.nth(3)).toContainText('3 scoops · Sugar Cone');
  await expect(cards.nth(3)).toContainText('1× Strawberry, 2× Chocolate Chip');
  await expect(cards.nth(3)).toContainText('Whipped cream, Chocolate Sauce');
  await expect(cards.nth(3)).toContainText('No toppings');
  await expect(
    page.getByRole('button', { name: 'Undo done for #0039' }),
  ).toBeVisible();
  const bounds = await cards.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().x),
  );
  expect(bounds[0]).toBeLessThan(bounds[1]);
  expect(bounds[1]).toBeLessThan(bounds[2]);
  expect(bounds[3]).toBe(bounds[0]);
  await page.screenshot({ path: testInfo.outputPath('build-queue.png') });
});

test('done is a single action, Undo restores original ordering and survives a reload', async ({
  page,
  context,
}) => {
  const api = await backend(context, fixtures());
  await page.goto('/queue/');
  await page
    .getByRole('button', { name: 'Mark #0040 done', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: 'Undo done for #0040', exact: true }),
  ).toBeVisible();
  expect(api.mutations).toEqual(['/api/orders/t40/done']);
  await page.reload();
  await expect(page.getByRole('article')).toHaveCount(3);
  await page
    .getByRole('button', { name: 'Undo done for #0040', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(4);
  await expect(page.getByRole('article').first()).toContainText('#0040');
  expect(api.records.get('t40')?.submittedAt).toBe(before(12));
  expect(api.records.get('t40')?.doneAt).toBeUndefined();
  expect(api.mutations).toEqual([
    '/api/orders/t40/done',
    '/api/orders/t40/reopen',
  ]);
});

test('polling finds new orders, ages cross thresholds and empty state keeps recently done Undo', async ({
  page,
  context,
}) => {
  const api = await backend(context);
  await page.clock.install({ time: new Date(now) });
  await page.goto('/queue/');
  await expect(
    page.getByRole('heading', { name: 'All caught up', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Undo done/ })).toHaveCount(0);
  const ticket = sampleTicket('new-order', now);
  api.upsert(ticket);
  await page.clock.fastForward(3001);
  const card = page.getByRole('article');
  await expect(card).toHaveCount(1);
  await expect(card.getByLabel('Wait Just now')).toHaveClass(/moss/);
  await page.clock.fastForward(5 * 60000);
  await expect(card.getByLabel('Wait 5 min')).toHaveClass(/olive/);
  await page.clock.fastForward(5 * 60000);
  await expect(card.getByLabel('Wait 10 min')).toHaveClass(/rust/);
  await page
    .getByRole('button', { name: 'Mark #0043 done', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'All caught up', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Undo done for #0043', exact: true }),
  ).toBeVisible();
});

test('failed reads retain last-known orders and failed mutations remain visible without automatic retries', async ({
  page,
  context,
}) => {
  const api = await backend(context, fixtures());
  await page.clock.install({ time: new Date(now) });
  await page.goto('/queue/');
  await expect(page.getByRole('article')).toHaveCount(4);
  api.failMutations(true);
  await page
    .getByRole('button', { name: 'Mark #0040 done', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Could not update the order',
  );
  await expect(page.getByRole('article')).toHaveCount(4);
  await page.clock.fastForward(6000);
  await expect(page.getByRole('alert')).toBeVisible();
  expect(api.mutations).toHaveLength(1);
  api.failMutations(false);
  await page
    .getByRole('button', { name: 'Mark #0040 done', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(3);
  api.failList(true);
  await page.clock.fastForward(3001);
  await expect(page.getByRole('alert')).toContainText(
    'Showing the last available orders',
  );
  await expect(page.getByRole('article')).toHaveCount(3);
  api.failList(false);
  await page
    .getByRole('button', { name: 'Refresh queue', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('an unavailable initial queue does not claim all caught up', async ({
  page,
  context,
}) => {
  const api = await backend(context);
  api.failList(true);
  await page.goto('/queue/');
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'All caught up', exact: true }),
  ).toHaveCount(0);
  api.failList(false);
  await page
    .getByRole('button', { name: 'Refresh queue', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'All caught up', exact: true }),
  ).toBeVisible();
});

test('stale polling response cannot restore an order after marking it done', async ({
  page,
  context,
}) => {
  await backend(context, fixtures());
  await page.clock.install({ time: new Date(now) });
  await page.goto('/queue/');
  await expect(page.getByRole('article')).toHaveCount(4);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached!: () => void;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reached();
    await held;
    await route.fulfill({ json: { orders: fixtures() } });
  });
  await page.clock.fastForward(3001);
  await entered;
  await page
    .getByRole('button', { name: 'Mark #0040 done', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(3);
  release();
  await expect(
    page.getByRole('button', { name: 'Undo done for #0040', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(3);
});

test('builder and queue share orders: every reprint leaves one card and never reopens a done order', async ({
  page,
  context,
}) => {
  const api = await backend(context);
  await page.goto('/');
  await page.getByLabel('Customer name (optional)').fill('Maria');
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cup', exact: true }).click();
  await page.getByRole('button', { name: 'Print order', exact: true }).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Order #0001 sent',
  );
  const queue = await context.newPage();
  await queue.goto('/queue/');
  await queue.clock.install();
  await expect(queue.getByRole('article')).toHaveCount(1);
  await expect.poll(() => api.publications.length).toBe(1);
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  await queue.clock.fastForward(3001);
  await expect(queue.getByRole('article')).toHaveCount(1);
  await queue
    .getByRole('button', { name: 'Mark #0001 done', exact: true })
    .click();
  await expect(queue.getByRole('article')).toHaveCount(0);
  const completed = api.records.get(api.prints[0].ticket.id);
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  await queue.clock.fastForward(3001);
  await expect(queue.getByRole('article')).toHaveCount(0);
  await expect(
    queue.getByRole('button', { name: 'Undo done for #0001', exact: true }),
  ).toBeVisible();
  expect(api.records.size).toBe(1);
  expect(api.records.get(api.prints[0].ticket.id)).toEqual(completed);
  expect(api.prints.map((p) => p.reprint)).toEqual([false, true, true]);
  expect(api.prints[1].ticket).toEqual(api.prints[0].ticket);
  expect(api.prints[2].ticket).toEqual(api.prints[0].ticket);
  expect(api.publications).toHaveLength(1);
});

test('pending publications survive reload and retry without reprinting', async ({
  page,
  context,
}) => {
  const api = await backend(context);
  api.failPublish(true);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cup', exact: true }).click();
  await page.getByRole('button', { name: 'Print order', exact: true }).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  await page.getByRole('button', { name: 'Order tools', exact: true }).click();
  await expect(page.getByLabel('Queue synchronization')).toContainText(
    'no print will be resent',
  );
  expect(api.records.size).toBe(0);
  expect(api.prints).toHaveLength(1);
  api.failPublish(false);
  await page.reload();
  await expect.poll(() => api.records.size).toBe(1);
  expect(api.prints).toHaveLength(1);
  expect(api.records.get(api.prints[0].ticket.id)?.submittedAt).toBe(
    api.prints[0].ticket.createdAt,
  );
  expect(
    api.publications.every((ticket) => ticket.id === api.prints[0].ticket.id),
  ).toBe(true);
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('order-pad-v1');
      request.onsuccess = () => resolve(request.result);
    });
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      const request = db
        .transaction('settings')
        .objectStore('settings')
        .getAllKeys();
      request.onsuccess = () => resolve(request.result);
    });
    db.close();
    if (keys.some((key) => String(key).startsWith('queueOrder:')))
      throw new Error('Outbox not acknowledged');
  });
});

for (const viewport of [
  { width: 1180, height: 820 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`queue adapts to ${viewport.width}x${viewport.height} with usable actions`, async ({
    page,
    context,
  }, testInfo) => {
    await backend(context, fixtures());
    await page.setViewportSize(viewport);
    await page.clock.install({ time: new Date(now) });
    await page.goto('/queue/');
    await expect(page.getByRole('article')).toHaveCount(4);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bounds = await page
      .getByRole('button', { name: 'Mark #0040 done', exact: true })
      .boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    const undo = await page
      .getByRole('button', { name: 'Undo done for #0039', exact: true })
      .boundingBox();
    expect(undo!.height).toBeGreaterThanOrEqual(44);
    expect(undo!.y + undo!.height).toBeLessThanOrEqual(viewport.height);
    await page.screenshot({
      path: testInfo.outputPath('queue-responsive.png'),
    });
  });
}
