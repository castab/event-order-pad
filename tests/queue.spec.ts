import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { mockStationApi } from './helpers/station-api';
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
  await context.route('**/api/features', (route) =>
    route.fulfill({ json: { trackingEnabled: true } }),
  );
  const records = new Map(initial.map((order) => [order.ticket.id, order]));
  const publications: OrderTicket[] = [];
  const prints: { ticket: OrderTicket; reprint: boolean; attemptId: string }[] =
    [];
  const mutations: string[] = [];
  let listFails = false;
  const instanceId = '00000000-0000-4000-8000-000000000001';
  let revision = 0;
  const snapshot = () => ({
    instanceId,
    revision,
    orders: [
      ...sortOrders([...records.values()], 'open'),
      ...sortOrders([...records.values()], 'done').slice(0, 8),
    ],
  });
  const broadcast = async (error = false, data: unknown = snapshot()) => {
    await Promise.all(
      context.pages().map((page) =>
        page
          .evaluate(
            ({ error, data }) => {
              const w = window as unknown as {
                __queueEmit?: (error: boolean, data: unknown) => void;
              };
              w.__queueEmit?.(error, data);
            },
            { error, data },
          )
          .catch(() => {}),
      ),
    );
  };
  await context.exposeBinding('__queueConnect', () => ({
    error: listFails,
    data: snapshot(),
  }));
  await context.addInitScript(() => {
    const w = window as unknown as {
      __queueConnect: () => Promise<{ error: boolean; data: unknown }>;
      __queueEmit: (error: boolean, data: unknown) => void;
      __queueSources: FakeSource[];
      EventSource: typeof EventSource;
    };
    const sources: FakeSource[] = [];
    class FakeSource extends EventTarget {
      closed = false;
      private heartbeat?: ReturnType<typeof setInterval>;
      private retry?: ReturnType<typeof setTimeout>;
      constructor(readonly url: string) {
        super();
        sources.push(this);
        void this.connect();
      }
      private async connect() {
        const response = await w.__queueConnect();
        if (this.closed) return;
        if (response.error) {
          this.disconnect();
          return;
        }
        this.dispatchEvent(new Event('open'));
        this.deliver(response.data);
        this.heartbeat = setInterval(
          () => this.dispatchEvent(new MessageEvent('ping', { data: '{}' })),
          15000,
        );
      }
      deliver(data: unknown) {
        if (!this.closed)
          this.dispatchEvent(
            new MessageEvent('orders', { data: JSON.stringify(data) }),
          );
      }
      disconnect() {
        clearInterval(this.heartbeat);
        clearTimeout(this.retry);
        this.dispatchEvent(new Event('error'));
        this.retry = setTimeout(() => void this.connect(), 3000);
      }
      close() {
        this.closed = true;
        clearInterval(this.heartbeat);
        clearTimeout(this.retry);
      }
    }
    w.__queueSources = sources;
    w.__queueEmit = (error, data) =>
      sources
        .filter((s) => !s.closed)
        .forEach((s) => (error ? s.disconnect() : s.deliver(data)));
    w.EventSource = FakeSource as unknown as typeof EventSource;
  });
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
    revision++;
    if (!listFails) void broadcast();
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
    if (order.status !== updated.status) {
      records.set(id, updated);
      revision++;
      if (!listFails) void broadcast();
    }
    return route.fulfill({ json: { order: updated, instanceId, revision } });
  });
  await mockStationApi(
    context,
    (ticket) => {
      publications.push(ticket);
      upsert(ticket);
    },
    () => {
      if (publishFails) throw new Error('Database down');
    },
  );
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
    broadcast,
    snapshot,
    failList: (value: boolean) => {
      listFails = value;
      if (value) void broadcast(true);
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
  const card = (reference: string) =>
    page.getByRole('article', { name: new RegExp(`^Order #${reference} `) });
  await expect(page.getByRole('article')).toHaveCount(4);
  await expect(card('0040')).toHaveAttribute(
    'aria-label',
    'Order #0040 · Happy Sprinkle',
  );
  await expect(card('0041')).toHaveAttribute(
    'aria-label',
    'Order #0041 · Dana',
  );
  await expect(card('0042')).toHaveAttribute(
    'aria-label',
    'Order #0042 · Lucky Waffle',
  );
  await expect(card('0043')).toHaveAttribute(
    'aria-label',
    'Order #0043 · Maria',
  );
  const totals = page.getByLabel('Queue totals');
  await expect(totals).toContainText('4');
  await expect(totals).toContainText('10');
  await expect(totals).toContainText('12m');
  await expect(card('0040').getByLabel('Wait 12 min')).toHaveClass(/rust/);
  await expect(card('0041').getByLabel('Wait 7 min')).toHaveClass(/olive/);
  await expect(card('0042').getByLabel('Wait 4 min')).toHaveClass(/moss/);
  await expect(card('0040').locator('time')).toHaveText('11:48 AM');
  await expect(card('0043')).toContainText('3 scoops · Sugar Cone');
  await expect(
    page.getByRole('button', { name: 'Undo done for #0039' }),
  ).toBeVisible();
  expectPacked(await placed(page), 3);
  await page.screenshot({ path: testInfo.outputPath('build-queue.png') });
});

test('flavors and toppings are separate chips, and servings without toppings say so', async ({
  page,
  context,
}) => {
  await backend(context, fixtures());
  await page.goto('/queue/');
  const maria = page.getByRole('article', { name: /^Order #0043 / });
  const servings = maria.getByRole('listitem').filter({
    has: page.getByRole('list', { name: 'Flavors' }),
  });
  await expect(servings).toHaveCount(3);
  const first = servings.nth(0);
  await expect(first).toContainText('3 scoops · Sugar Cone');
  const flavors = first.getByRole('list', { name: 'Flavors' });
  await expect(flavors.getByRole('listitem')).toHaveText([
    '1 Strawberry',
    '2 Chocolate Chip',
  ]);
  const toppings = first.getByRole('list', { name: 'Toppings' });
  await expect(toppings.getByRole('listitem')).toHaveText([
    'Whipped cream',
    'Chocolate Sauce',
  ]);
  // Never joined into one comma-separated line.
  await expect(first).not.toContainText('Whipped cream, Chocolate Sauce');
  await expect(first).not.toContainText('Strawberry, ');
  // The two chip families use different shapes and never wrap inside a chip.
  const shape = async (chip: Locator) =>
    chip.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        radius: style.borderTopLeftRadius,
        border: style.borderTopWidth,
        borderStyle: style.borderTopStyle,
        nowrap: [element, ...element.querySelectorAll('*')].every(
          (node) => getComputedStyle(node).whiteSpace === 'nowrap',
        ),
        hasIcon: !!element.querySelector('svg[aria-hidden="true"]'),
      };
    });
  const flavorChip = await shape(flavors.getByRole('listitem').first());
  const toppingChip = await shape(toppings.getByRole('listitem').first());
  expect(flavorChip.radius).not.toBe(toppingChip.radius);
  expect(toppingChip.radius).toBe('6px');
  expect(toppingChip.borderStyle).toBe('solid');
  expect(toppingChip.border).not.toBe('0px');
  expect(toppingChip.hasIcon).toBe(true);
  expect(flavorChip.hasIcon).toBe(false);
  expect(flavorChip.nowrap && toppingChip.nowrap).toBe(true);

  // Serving 2 has no toppings: one dashed, muted chip and no Toppings list.
  const plain = servings.nth(1);
  await expect(plain.getByRole('list', { name: 'Toppings' })).toHaveCount(0);
  const none = plain.getByText('No toppings', { exact: true });
  await expect(none).toHaveCount(1);
  expect(await shape(none)).toMatchObject({ borderStyle: 'dashed' });
  await expect(maria.getByText('No toppings', { exact: true })).toHaveCount(1);
});

type Placed = {
  position: number;
  x: number;
  y: number;
  bottom: number;
  width: number;
};

/** Open cards with their on-screen boxes, in age order (aria-posinset). */
async function placed(page: Page): Promise<Placed[]> {
  const cards = await page.getByRole('article').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        position: Number(element.getAttribute('aria-posinset')),
        x: box.x,
        y: box.y,
        bottom: box.bottom,
        width: box.width,
      };
    }),
  );
  return cards.sort((a, b) => a.position - b.position);
}

const columnsUsed = async (page: Page) =>
  new Set((await placed(page)).map((card) => Math.round(card.x))).size;

/**
 * Cards in age order must each sit directly under the previous card of their
 * column, in the column that was shortest when they were placed (leftmost on ties).
 */
function expectPacked(cards: Placed[], columns: number) {
  const left = Math.min(...cards.map((card) => card.x));
  const step = cards[0].width + 20;
  const top = Math.min(...cards.map((card) => card.y));
  const ends = Array.from({ length: columns }, () => top);
  cards.forEach((card, index) => {
    const column = Math.round((card.x - left) / step);
    const shortest = Math.min(...ends);
    const expected = ends.findIndex((end) => end <= shortest + 1);
    expect(column, `card ${index + 1} column`).toBe(expected);
    expect(card.y, `card ${index + 1} top`).toBeCloseTo(ends[column], 0);
    ends[column] = card.bottom + 20;
  });
}

const draw = (
  reference: number,
  minutesAgo: number,
  servingCount: number,
): QueueOrder => {
  const submitted = before(minutesAgo);
  return parseOrder({
    ticket: parseTicket({
      schema: 2,
      id: `p${reference}`,
      createdAt: submitted,
      reference: String(reference).padStart(4, '0'),
      customerName: `Guest ${reference}`,
      servings: Array.from({ length: servingCount }, (_, index) =>
        serving(
          index % 2 ? 'Vanilla' : 'Chocolate',
          1 + (index % 3),
          'Cup',
          index % 2 ? ['Gummy Bears', 'Caramel Sauce'] : [],
        ),
      ),
    }),
    submittedAt: submitted,
    status: 'open',
  });
};

test('cards pack into the shortest column in age order at 3, 2, 1 and 4 columns', async ({
  page,
  context,
}) => {
  // Oldest first; deliberately uneven heights so round-robin would leave gaps.
  await backend(context, [
    draw(1, 30, 4),
    draw(2, 25, 1),
    draw(3, 20, 1),
    draw(4, 15, 1),
    draw(5, 10, 3),
    draw(6, 5, 1),
    draw(7, 2, 2),
  ]);
  await page.goto('/queue/');
  await expect(page.getByRole('article')).toHaveCount(7);
  let cards = await placed(page);
  expectPacked(cards, 3);
  // The fourth card goes under a short card, not under the 4-serving one.
  expect(cards[3].x).not.toBe(cards[0].x);
  expect(await columnsUsed(page)).toBe(3);

  await page.setViewportSize({ width: 768, height: 1024 });
  await expect.poll(() => columnsUsed(page)).toBe(2);
  expectPacked(await placed(page), 2);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => columnsUsed(page)).toBe(1);
  cards = await placed(page);
  expectPacked(cards, 1);
  cards.slice(1).forEach((card, index) => {
    expect(card.y).toBeGreaterThan(cards[index].y);
  });

  await page.setViewportSize({ width: 1600, height: 900 });
  await expect.poll(() => columnsUsed(page)).toBe(4);
  expectPacked(await placed(page), 4);
});

test('arrivals and completions re-pack, but the age refresh never moves cards', async ({
  page,
  context,
}) => {
  const api = await backend(context, [
    draw(1, 12, 3),
    draw(2, 9, 1),
    draw(3, 6, 2),
  ]);
  await page.clock.install({ time: new Date(now) });
  await page.goto('/queue/');
  await expect(page.getByRole('article')).toHaveCount(3);
  const initial = await placed(page);
  expectPacked(initial, 3);

  // Ages cross a wait threshold; nothing may move.
  await page.clock.fastForward(5 * 60000);
  await expect(
    page
      .getByRole('article', { name: /^Order #0002 / })
      .getByLabel('Wait 14 min'),
  ).toHaveClass(/rust/);
  expect(await placed(page)).toEqual(initial);

  // A new order lands in the shortest column.
  api.upsert(draw(4, 0, 1).ticket);
  await expect(page.getByRole('article')).toHaveCount(4);
  expectPacked(await placed(page), 3);

  // Completing the oldest order re-packs the rest, still oldest first.
  await page
    .getByRole('button', { name: 'Mark #0001 done', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(3);
  const after = await placed(page);
  expect(after.map((card) => card.position)).toEqual([1, 2, 3]);
  expectPacked(after, 3);
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

test('pushed snapshots find new orders, ages cross thresholds and empty state keeps recently done Undo', async ({
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

test('stale stream snapshots cannot restore an order after marking it done', async ({
  page,
  context,
}) => {
  const api = await backend(context, fixtures());
  await page.goto('/queue/');
  await expect(page.getByRole('article')).toHaveCount(4);
  const stale = api.snapshot();
  await page
    .getByRole('button', { name: 'Mark #0040 done', exact: true })
    .click();
  await expect(page.getByRole('article')).toHaveCount(3);
  await api.broadcast(false, stale);
  await expect(
    page.getByRole('button', { name: 'Undo done for #0040', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(3);
});

test('disconnected queue blocks actions and reconnects to catch up without polling', async ({
  page,
  context,
}) => {
  const api = await backend(context, fixtures());
  const reads: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === '/api/orders'
    )
      reads.push(request.url());
  });
  await page.clock.install({ time: new Date(now) });
  await page.goto('/queue/');
  await expect(page.getByRole('article')).toHaveCount(4);
  api.failList(true);
  await expect(page.getByRole('alert')).toContainText('disconnected');
  await expect(page.getByRole('alert')).toContainText('Reconnecting…');
  await expect(page.getByRole('article')).toHaveCount(4);
  await expect(
    page.getByRole('button', { name: 'Mark #0040 done', exact: true }),
  ).toBeDisabled();
  api.failList(false);
  await page.clock.fastForward(3001);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Mark #0040 done', exact: true }),
  ).toBeEnabled();
  expect(reads).toEqual([]);
  await page.getByRole('link', { name: 'Order builder', exact: true }).click();
  await expect(page.getByLabel('Customer name (optional)')).toBeVisible();
  expect(
    await page.evaluate(() =>
      (
        window as unknown as { __queueSources: { closed: boolean }[] }
      ).__queueSources.every((s) => s.closed),
    ),
  ).toBe(true);
});

test('malformed live data preserves cards and manual refresh gets a valid snapshot', async ({
  page,
  context,
}) => {
  const api = await backend(context, fixtures());
  await page.goto('/queue/');
  await expect(page.getByRole('article')).toHaveCount(4);
  await api.broadcast(false, {
    ...api.snapshot(),
    orders: [fixtures()[0], fixtures()[0]],
  });
  await expect(page.getByRole('alert')).toContainText(
    'Invalid live queue data',
  );
  await expect(page.getByRole('article')).toHaveCount(4);
  await page
    .getByRole('button', { name: 'Refresh queue', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(4);
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

test('failed central order commits block printing and restore the saved draft on reload', async ({
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
  await expect(page.getByLabel('Print recovery')).toContainText(
    'Could not save print intent. No job was sent by this browser.',
  );
  expect(api.records.size).toBe(0);
  expect(api.prints).toHaveLength(0);
  api.failPublish(false);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Print order', exact: true }),
  ).toBeEnabled();
  expect(api.prints).toHaveLength(0);
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
    expect(
      await page.evaluate(() => {
        scrollTo(0, 500);
        return {
          overflow: document.documentElement.scrollHeight - innerHeight,
          scrollY,
        };
      }),
    ).toEqual({ overflow: 0, scrollY: 0 });
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

test('unavailable tracking settings show an error without opening a stream; refresh reads the disabled flag', async ({
  page,
  context,
}) => {
  await backend(context);
  let unavailable = true;
  await context.route('**/api/features', (route) =>
    route.fulfill(
      unavailable
        ? { status: 503, json: {} }
        : { json: { trackingEnabled: false } },
    ),
  );
  await page.goto('/queue/');
  await expect(page.getByRole('alert')).toContainText(
    'Order tracking settings unavailable',
  );
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __queueSources: unknown[] }).__queueSources
          .length,
    ),
  ).toBe(0);
  unavailable = false;
  await page
    .getByRole('button', { name: 'Refresh queue', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Order tracking is turned off' }),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __queueSources: unknown[] }).__queueSources
          .length,
    ),
  ).toBe(0);
});
for (const width of [320, 360, 390])
  test(`the username menu never covers the title on a ${width} px phone`, async ({
    page,
    context,
  }) => {
    await backend(context);
    await page.route('**/api/auth/session', (route) =>
      route.fulfill({
        json: {
          user: { id: 'long', username: 'bcastaneda' },
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          authenticatedAt: new Date().toISOString(),
        },
      }),
    );
    await page.setViewportSize({ width, height: 760 });
    await page.goto('/queue/');
    const menu = page.getByRole('button', { name: 'bcastaneda', exact: true });
    await expect(menu).toBeVisible();
    const title = (await page
      .getByRole('heading', { name: 'Now Scooping', level: 1 })
      .boundingBox())!;
    const button = (await menu.boundingBox())!;
    expect(title.x + title.width).toBeLessThanOrEqual(button.x);
    expect(button.x + button.width).toBeLessThanOrEqual(width);
    expect(button.width).toBeGreaterThanOrEqual(44);
  });
