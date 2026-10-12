import { expect, test, type Page } from '@playwright/test';
import { blankNameLabel, type OrderTicket } from '../src/lib/tickets/ticket';
import type { OrderDraft } from '../src/lib/tickets/order';

type PrintRequest = {
  ticket: OrderTicket;
  attemptId: string;
  reprint: boolean;
};
const printButton = (page: Page) =>
  page.getByRole('button', { name: /^Print order/ });

async function openTools(page: Page) {
  const tools = page.getByRole('button', { name: 'Order tools', exact: true });
  if ((await tools.getAttribute('aria-expanded')) !== 'true')
    await tools.click();
}

async function chooseServing(
  page: Page,
  flavor = 'Vanilla',
  container = 'Cup',
  toppings: string[] = [],
) {
  await page
    .getByRole('button', { name: `Add a ${flavor} scoop`, exact: true })
    .click();
  await page.getByRole('button', { name: container, exact: true }).click();
  for (const topping of toppings)
    await page.getByRole('button', { name: topping, exact: true }).click();
}
async function addServing(
  page: Page,
  flavor = 'Vanilla',
  container = 'Cup',
  toppings: string[] = [],
) {
  await chooseServing(page, flavor, container, toppings);
  await page.getByRole('button', { name: 'Add serving', exact: true }).click();
}
async function readDraft(page: Page): Promise<OrderDraft> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('order-pad-v1');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<OrderDraft>((resolve, reject) => {
        const req = db
          .transaction('settings')
          .objectStore('settings')
          .get('draft');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } finally {
      db.close();
    }
  });
}

async function mockUsb(page: Page) {
  const submitted: PrintRequest[] = [];
  const lockedDrafts: OrderDraft[] = [];
  await page.route('**/api/orders', (route) => {
    const ticket = route.request().postDataJSON() as OrderTicket;
    return route.fulfill({
      json: {
        created: true,
        order: { ticket, status: 'open', submittedAt: ticket.createdAt },
      },
    });
  });
  await page.route('**/api/printer', (route) =>
    route.fulfill({
      json: {
        ready: true,
        queue: 'Star_TSP143',
        message:
          'CUPS queue Star_TSP143 is configured for USB. Physical printer status is unverified.',
      },
    }),
  );
  await page.route('**/api/print', async (route) => {
    const body = route.request().postDataJSON() as PrintRequest;
    submitted.push(body);
    const saved = await page.evaluate(async (attemptId) => {
      const db = await new Promise<IDBDatabase>((resolve) => {
        const req = indexedDB.open('order-pad-v1');
        req.onsuccess = () => resolve(req.result);
      });
      try {
        return await new Promise<{ id: string; result?: unknown }>(
          (resolve) => {
            const req = db
              .transaction('attempts')
              .objectStore('attempts')
              .get(attemptId);
            req.onsuccess = () => resolve(req.result);
          },
        );
      } finally {
        db.close();
      }
    }, body.attemptId);
    expect(saved.id).toBe(body.attemptId);
    expect(saved.result).toBeUndefined();
    if (!body.reprint) {
      const draft = await readDraft(page);
      expect(draft.submittedTicketId).toBe(body.ticket.id);
      expect(draft.editor).toEqual({
        flavors: [],
        container: '',
        toppings: [],
      });
      lockedDrafts.push(draft);
    }
    await route.fulfill({
      json: {
        attemptId: body.attemptId,
        result: {
          status: 'accepted',
          simulated: false,
          message: 'CUPS accepted test job. Queue submission only.',
        },
      },
    });
  });
  return { submitted, lockedDrafts };
}

test('USB is automatic, Print includes the current serving, and the next order is immediately ready', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await expect(printButton(page)).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByText('Server setup', { exact: true })).toBeHidden();
  await expect(printButton(page)).toBeDisabled();
  await expect(
    page.getByLabel('Vanilla scoop count', { exact: true }),
  ).toHaveText('0');
  await expect(
    page.getByRole('button', { name: 'Cup', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await page
    .getByLabel('Customer name (optional)')
    .pressSequentially('  María & Pat  ');
  await chooseServing(page, 'Chocolate Chip', 'Sugar Cone', [
    'Gummy Bears',
    'Caramel Sauce',
  ]);
  await expect(page.getByLabel('Order servings')).toHaveCount(0);
  await expect(page.getByLabel('Preparation ticket preview')).toBeHidden();
  await openTools(page);
  await page.getByText('Ticket preview', { exact: true }).click();
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    'MARÍA & PAT',
  );
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    'SUGAR CONE',
  );
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Order #0001 sent to the printer',
  );
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue('');
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Cup', exact: true }),
  ).toHaveAttribute('aria-pressed', 'false');
  await expect(
    page.getByLabel('Chocolate Chip scoop count', { exact: true }),
  ).toHaveText('0');
  await expect(printButton(page)).toBeDisabled();
  expect(submitted).toHaveLength(1);
  expect(submitted[0].ticket.reference).toBe('0001');
  expect(submitted[0].ticket.displayName).toBe('María & Pat');
  expect(submitted[0].ticket.servings).toEqual([
    {
      container: 'Sugar Cone',
      flavors: [{ flavor: 'Chocolate Chip', count: 1 }],
      toppings: ['Gummy Bears', 'Caramel Sauce'],
    },
  ]);

  await openTools(page);
  await page.getByText('View last receipt', { exact: true }).click();
  await expect(page.getByLabel('Last submitted ticket preview')).toContainText(
    'MARÍA & PAT',
  );
  await expect(
    page.getByText('Print attempts (1)', { exact: true }),
  ).toBeVisible();
});

test('prints 3 mixed scoops as one serving and reprints the exact original distribution', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Add a Chocolate Chip scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Chocolate Chip scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Strawberry scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cup', exact: true }).click();
  await page.getByRole('button', { name: 'Gummy Bears', exact: true }).click();
  await expect(
    page.getByLabel('Chocolate Chip scoop count', { exact: true }),
  ).toHaveText('2');
  await expect(
    page.getByLabel('Strawberry scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(page.getByText('3 / 5 scoops', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Order servings')).toHaveCount(0);
  await openTools(page);
  await page.getByText('Ticket preview', { exact: true }).click();
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    '3 SCOOPS - CUP',
  );
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  expect(submitted[0].ticket.servings).toEqual([
    {
      container: 'Cup',
      flavors: [
        { flavor: 'Strawberry', count: 1 },
        { flavor: 'Chocolate Chip', count: 2 },
      ],
      toppings: ['Gummy Bears'],
    },
  ]);
  await expect(
    page.getByLabel('Chocolate Chip scoop count', { exact: true }),
  ).toHaveText('0');
  await chooseServing(page, 'Vanilla', 'Sugar Cone');
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  expect(submitted[1].ticket).toEqual(submitted[0].ticket);
  await expect(
    page.getByLabel('Vanilla scoop count', { exact: true }),
  ).toHaveText('2');
  await openTools(page);
  await page.getByText('View last receipt', { exact: true }).click();
  await expect(page.getByLabel('Last submitted ticket preview')).toContainText(
    '2 x Chocolate Chip',
  );
  await expect(page.getByLabel('Last submitted ticket preview')).toContainText(
    'REPRINT',
  );
});

test('five-scoop total applies across flavors, removing scoops frees capacity, and mixed edits survive reload', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await chooseServing(page, 'Chocolate Chip', 'Cake Cone');
  await page
    .getByRole('button', { name: 'Add a Chocolate Chip scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Strawberry scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Strawberry scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await expect(
    page.getByText(
      '5 scoops is the most per serving. Remove one to change the mix.',
      { exact: true },
    ),
  ).toContainText('Remove one to change the mix');
  for (const flavor of ['Chocolate', 'Vanilla', 'Strawberry', 'Chocolate Chip'])
    await expect(
      page.getByRole('button', { name: `Add a ${flavor} scoop`, exact: true }),
    ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Remove a Vanilla scoop', exact: true })
    .click();
  await expect(
    page.getByLabel('Vanilla scoop count', { exact: true }),
  ).toHaveText('0');
  await expect(
    page.getByRole('button', { name: 'Remove a Vanilla scoop', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Add a Chocolate scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add serving', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit serving 1', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove a Strawberry scoop', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await readDraft(page)).editor.flavors.find(
          (f) => f.flavor === 'Strawberry',
        )?.count,
    )
    .toBe(1);
  await page.reload();
  await expect(
    page.getByLabel('Chocolate Chip scoop count', { exact: true }),
  ).toHaveText('2');
  await expect(
    page.getByLabel('Strawberry scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(
    page.getByLabel('Chocolate scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(page.getByText('4 / 5 scoops', { exact: true })).toBeVisible();
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  expect(submitted[0].ticket.servings).toEqual([
    {
      container: 'Cake Cone',
      flavors: [
        { flavor: 'Chocolate', count: 1 },
        { flavor: 'Strawberry', count: 1 },
        { flavor: 'Chocolate Chip', count: 2 },
      ],
      toppings: [],
    },
  ]);
});

test('removing the last scoop blocks printing without dropping the selected container', async ({
  page,
}) => {
  await mockUsb(page);
  await page.goto('/');
  await chooseServing(page);
  await page
    .getByRole('button', { name: 'Remove a Vanilla scoop', exact: true })
    .click();
  await expect(printButton(page)).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Cup', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('0 / 5 scoops', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Add a Strawberry scoop', exact: true })
    .click();
  await expect(printButton(page)).toBeEnabled();
});

test('v1 browser tickets, attempts and drafts reset once before a new structured order', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.addInitScript(async () => {
    if (sessionStorage.getItem('seeded-v1')) return;
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('order-pad-v1', 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('tickets', { keyPath: 'id' });
        req.result.createObjectStore('attempts', { keyPath: 'id' });
        req.result.createObjectStore('settings');
        const tx = req.transaction!;
        tx.objectStore('tickets').put({ id: 'old-ticket', items: [] });
        tx.objectStore('attempts').put({
          id: 'old-attempt',
          ticketId: 'old-ticket',
        });
        tx.objectStore('settings').put('old-ticket', 'latest');
        tx.objectStore('settings').put(
          { name: 'Legacy draft', reference: 'Sundae Sprinkle' },
          'draft',
        );
      };
      req.onsuccess = () => {
        req.result.close();
        sessionStorage.setItem('seeded-v1', 'yes');
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
  await page.goto('/');
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeDisabled();
  expect((await readDraft(page)).reference).toBe('0001');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  expect(submitted[0].ticket.schema).toBe(2);
  expect(submitted[0].ticket.reference).toBe('0001');
  await page.reload();
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  expect((await readDraft(page)).reference).toBe('0002');
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeEnabled();
});

test('tools preserve the draft, show the queue and support keyboard disclosure', async ({
  page,
}) => {
  let checks = 0;
  await mockUsb(page);
  await page.route('**/api/printer', (route) => {
    checks++;
    return route.fulfill({
      json: {
        ready: true,
        queue: 'Star_TSP143',
        message: 'Configured USB queue.',
      },
    });
  });
  await page.goto('/');
  await chooseServing(page, 'Strawberry', 'Cake Cone', ['Whipped cream']);
  await page.getByLabel('Customer name (optional)').fill('Alex');
  const tools = page.getByRole('button', { name: 'Order tools', exact: true });
  await tools.focus();
  await page.keyboard.press('Enter');
  await expect(tools).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Star_TSP143', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check printer', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Check printer', exact: true })
    .click();
  await expect.poll(() => checks).toBe(3);
  await tools.focus();
  await page.keyboard.press('Space');
  await expect(tools).toBeFocused();
  await expect(tools).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue('Alex');
  await expect(
    page.getByRole('button', { name: 'Cake Cone', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Whipped cream', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(printButton(page)).toBeEnabled();
});

test('multi-serving edits replace rather than duplicate, and incomplete servings block printing until canceled', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await addServing(page, 'Vanilla', 'Cup');
  await addServing(page, 'Strawberry', 'Cake Cone');
  await page
    .getByRole('button', { name: 'Add a Chocolate scoop', exact: true })
    .click();
  await expect(printButton(page)).toBeDisabled();
  await expect(printButton(page)).toHaveText('Print order');
  await expect(page.getByRole('status')).toContainText(
    'To finish this serving: choose a container.',
  );
  await page
    .getByRole('button', { name: 'Cancel serving', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Edit serving 2', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove a Strawberry scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Chocolate Chip scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Gummy Bears', exact: true }).click();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(2);
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  expect(submitted[0].ticket.servings).toEqual([
    {
      container: 'Cup',
      flavors: [{ flavor: 'Vanilla', count: 1 }],
      toppings: [],
    },
    {
      container: 'Cake Cone',
      flavors: [{ flavor: 'Chocolate Chip', count: 1 }],
      toppings: ['Gummy Bears'],
    },
  ]);
});

test('explicit Add, Save and Remove remain available and New order clears an active draft', async ({
  page,
}) => {
  await mockUsb(page);
  await page.goto('/');
  await addServing(page);
  await addServing(page, 'Strawberry', 'Cake Cone');
  await page
    .getByRole('button', { name: 'Edit serving 1', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove a Vanilla scoop', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Chocolate scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save serving', exact: true }).click();
  await page
    .getByRole('button', { name: 'Remove serving 2', exact: true })
    .click();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(1);
  await expect(page.getByLabel('Order servings')).toContainText('Chocolate');
  await openTools(page);
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(0);
  await expect(
    page.getByLabel('Chocolate scoop count', { exact: true }),
  ).toHaveText('0');
});

test('reprints preserve original identity while a different incomplete draft is in progress', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await page.getByLabel('Customer name (optional)').fill('First customer');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  await page.getByLabel('Customer name (optional)').fill('Next customer');
  await page
    .getByRole('button', { name: 'Add a Strawberry scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Gummy Bears', exact: true }).click();
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  expect(submitted).toHaveLength(2);
  expect(submitted[1].ticket).toEqual(submitted[0].ticket);
  expect(submitted[1].attemptId).not.toBe(submitted[0].attemptId);
  expect(submitted[1].reprint).toBe(true);
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'Next customer',
  );
  await expect(
    page.getByLabel('Strawberry scoop count', { exact: true }),
  ).toHaveText('1');
  await openTools(page);
  await page.getByText('View last receipt', { exact: true }).click();
  await expect(page.getByLabel('Last submitted ticket preview')).toContainText(
    'REPRINT',
  );
  await expect(page.getByLabel('Last submitted ticket preview')).toContainText(
    'FIRST CUSTOMER',
  );
  await page.reload();
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'Next customer',
  );
  await expect(
    page.getByRole('button', { name: 'Gummy Bears', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeEnabled();
});

test('incomplete drafts reload, and blank-name fallback stays stable through submit and reprint', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await page.getByLabel('Customer name (optional)').fill('   ');
  await page
    .getByRole('button', { name: 'Add a Strawberry scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Gummy Bears', exact: true }).click();
  await expect
    .poll(async () => (await readDraft(page)).editor.toppings.join(','))
    .toBe('Gummy Bears');
  const reference = (await readDraft(page)).reference;
  await openTools(page);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Order tools', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByLabel('Strawberry scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(printButton(page)).toBeDisabled();
  await page.getByRole('button', { name: 'Cup', exact: true }).click();
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    `Order #${reference} sent to the printer`,
  );
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  expect(submitted[0].ticket.reference).toBe(reference);
  expect(submitted[1].ticket.reference).toBe(reference);
});

test('unavailable USB service blocks printing and manual check restores readiness without setup confirmation', async ({
  page,
}) => {
  await mockUsb(page);
  let ready = false;
  await page.route('**/api/printer', (route) =>
    route.fulfill({
      json: {
        ready,
        queue: 'Star_TSP143',
        message: ready ? 'Configured.' : 'Service unavailable.',
      },
    }),
  );
  await page.goto('/');
  await chooseServing(page);
  await expect(printButton(page)).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('Service unavailable');
  ready = true;
  await page
    .getByRole('alert')
    .getByRole('button', { name: 'Check printer', exact: true })
    .click();
  await expect(printButton(page)).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
});

test('failed submissions retain their receipt until a deliberate successful reprint', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  let failed = true;
  await page.route('**/api/print', async (route) => {
    if (!failed) return route.fallback();
    const body = route.request().postDataJSON() as PrintRequest;
    await route.fulfill({
      json: {
        attemptId: body.attemptId,
        result: {
          status: 'failed',
          simulated: false,
          code: 'printer-busy',
          message: 'A CUPS job is pending. No job was submitted.',
        },
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Customer name (optional)').fill('Keep this order');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByLabel('Print recovery')).toContainText(
    'Order submission failed',
  );
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'Keep this order',
  );
  await expect(page.getByLabel('Customer name (optional)')).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Submitted order', exact: true }),
  ).toBeVisible();
  failed = false;
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Reprint of #0001 sent',
  );
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue('');
  expect(submitted[0].reprint).toBe(true);
  expect(submitted[0].ticket.displayName).toBe('Keep this order');
});

test('lost responses never retry, remain unknown on reload and require acknowledgment', async ({
  page,
}) => {
  await mockUsb(page);
  let sends = 0;
  await page.route('**/api/print', (route) => {
    sends++;
    return route.abort();
  });
  await page.goto('/');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByLabel('Print recovery')).toContainText(
    'Outcome unknown',
  );
  await expect(
    page.getByRole('button', { name: 'New order', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByLabel('Print recovery')).toContainText(
    'Outcome unknown',
  );
  expect(sends).toBe(1);
  await page
    .getByLabel('I checked the output and am ready to continue.')
    .check();
  await openTools(page);
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  await chooseServing(page, 'Chocolate', 'Cup');
  await expect(printButton(page)).toBeEnabled();
  // The acknowledgment also survives tools disclosure in this session.
  await openTools(page);
  await page.getByRole('button', { name: 'Order tools', exact: true }).click();
  await expect(printButton(page)).toBeEnabled();
});

test('pending requests block repeated taps and tools disclosure preserve the running submission', async ({
  page,
}) => {
  await mockUsb(page);
  let sends = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/print', async (route) => {
    sends++;
    await held;
    const body = route.request().postDataJSON();
    await route.fulfill({
      json: {
        attemptId: body.attemptId,
        result: { status: 'accepted', simulated: false, message: 'Accepted.' },
      },
    });
  });
  await page.goto('/');
  await chooseServing(page);
  await printButton(page).click();
  await expect(
    page.getByRole('button', { name: 'Submitting…', exact: true }),
  ).toBeDisabled();
  await openTools(page);
  await expect(
    page.getByRole('button', { name: 'Check printer', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Order tools', exact: true }).click();
  release();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  expect(sends).toBe(1);
});

test('reload during a request recovers an unknown locked order without another send', async ({
  page,
}) => {
  await mockUsb(page);
  let sends = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/print', async (route) => {
    sends++;
    await held;
    await route.abort();
  });
  await page.goto('/');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText('Submitting');
  await expect.poll(() => sends).toBe(1);
  await page.reload();
  release();
  await expect(page.getByLabel('Print recovery')).toContainText(
    'Outcome unknown',
  );
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeDisabled();
  expect(sends).toBe(1);
});

test('older accepted locked drafts advance on reload without resubmission', async ({
  page,
}) => {
  const { submitted, lockedDrafts } = await mockUsb(page);
  await page.goto('/');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  await page.evaluate(async (draft) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('order-pad-v1');
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise<void>((resolve) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put(draft, 'draft');
      tx.oncomplete = () => resolve();
    });
    db.close();
  }, lockedDrafts[0]);
  await page.reload();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(0);
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  await expect(page.getByLabel('Print notification')).toHaveCount(0);
  await openTools(page);
  await expect(
    page.getByText('Order submitted — Bouncy Sundae', { exact: true }),
  ).toBeVisible();
  expect(submitted).toHaveLength(1);
});

test('overlength orders block printing with a clear message and recover after removing servings', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  const current = await readDraft(page);
  await page.evaluate(async (draft) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('order-pad-v1');
      request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(
          {
            ...draft,
            servings: Array(30).fill({
              flavors: [
                'Chocolate',
                'Vanilla',
                'Strawberry',
                'Chocolate Chip',
              ].map((flavor) => ({ flavor, count: 1 })),
              container: 'Cup',
              toppings: [
                'Whipped cream',
                'Gummy Bears',
                'Caramel Sauce',
                'Chocolate Sauce',
                'Sliced Almonds',
                'Maraschino Cherries',
              ],
            }),
          },
          'draft',
        );
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, current);
  await page.reload();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(30);
  await expect(printButton(page)).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('length limit');
  expect(submitted).toHaveLength(0);
  for (let n = 30; n > 20; n--)
    await page
      .getByRole('button', { name: `Remove serving ${n}`, exact: true })
      .click();
  await expect(printButton(page)).toBeEnabled();
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'sent to the printer',
  );
  expect(submitted).toHaveLength(1);
  expect(submitted[0].ticket.servings).toHaveLength(20);
});

test('cached app reopens offline with recovered draft but cannot print without its host', async ({
  page,
  context,
}) => {
  await mockUsb(page);
  await page.goto('/');
  await chooseServing(page, 'Chocolate', 'Cup');
  await expect
    .poll(async () => (await readDraft(page)).editor.flavors[0]?.flavor)
    .toBe('Chocolate');
  await openTools(page);
  await page.getByText('Connection and local storage', { exact: true }).click();
  await expect(page.getByText(/App assets cached/)).toBeVisible();
  await page.unroute('**/api/printer');
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByLabel('Chocolate scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(page.getByRole('alert')).toContainText(
    'printing service unavailable',
  );
  await expect(printButton(page)).toBeDisabled();
});

test('unsupported IndexedDB blocks sends with an actionable notice', async ({
  page,
}) => {
  await mockUsb(page);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get: () => {
        throw new Error('unsupported');
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(
    'IndexedDB is unavailable',
  );
  await expect(printButton(page)).toBeDisabled();
});

for (const viewport of [
  { width: 360, height: 780 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`responsive order and settings layout ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await mockUsb(page);
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByLabel('Customer name (optional)').fill('Alex');
    await chooseServing(page, 'Chocolate Chip', 'Sugar Cone', ['Gummy Bears']);
    await page
      .getByRole('button', { name: 'Add a Chocolate Chip scoop', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Add a Strawberry scoop', exact: true })
      .click();
    await expect(printButton(page)).toBeEnabled();
    const bounds = await printButton(page).boundingBox();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const targets = await page
      .locator(
        '.builder-header button, .serving-card button, .builder-actions button',
      )
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const bounds = button.getBoundingClientRect();
          return {
            label: button.getAttribute('aria-label') || button.textContent,
            width: bounds.width,
            height: bounds.height,
          };
        }),
      );
    for (const target of targets) {
      expect(target.width, `${target.label} width`).toBeGreaterThanOrEqual(44);
      expect(target.height, `${target.label} height`).toBeGreaterThanOrEqual(
        44,
      );
    }
    await page.evaluate(() => document.fonts.ready);
    expect(
      await page.evaluate(() => document.fonts.check('16px Poppins')),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('order-screen.png'),
      fullPage: true,
    });
    await openTools(page);
    await page.getByText('Ticket preview', { exact: true }).click();
    await expect(page.getByLabel('Preparation ticket preview')).toContainText(
      'ALEX',
    );
    await openTools(page);
    await expect(
      page.getByRole('button', { name: 'Check printer', exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('printer-settings.png'),
      fullPage: true,
    });
  });
}

test('saved rows protect a started new serving, switch edits, cancel changes and track removals', async ({
  page,
}) => {
  await mockUsb(page);
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Saved servings', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Serving 1', exact: true }),
  ).toBeVisible();
  await addServing(page);
  await addServing(page, 'Chocolate', 'Cake Cone');
  await page.getByRole('button', { name: 'Gummy Bears', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit serving 1', exact: true })
    .click();
  expect((await readDraft(page)).editingIndex).toBeUndefined();
  await expect(
    page.getByRole('button', { name: 'Gummy Bears', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('button', { name: 'Cancel serving', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Edit serving 1', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save serving', exact: true }),
  ).toBeDisabled();
  await expect(printButton(page)).toHaveText('Print order · 2 servings');
  await expect(printButton(page)).toBeEnabled();
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save serving', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Edit serving 1', exact: true })
    .click();
  await expect(
    page.getByLabel('Vanilla scoop count', { exact: true }),
  ).toHaveText('2');
  await page
    .getByRole('button', { name: 'Edit serving 2', exact: true })
    .click();
  await expect(
    page.getByLabel('Chocolate scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(
    page.getByRole('button', { name: 'Save serving', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Edit serving 2', exact: true }),
  ).toContainText('Editing now');
  await page
    .getByRole('button', { name: 'Add a Chocolate scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cancel edit', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit serving 2', exact: true }),
  ).toContainText('1 scoop · Cake Cone');
  await page
    .getByRole('button', { name: 'Edit serving 2', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove serving 1', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Edit serving 1', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    page.getByRole('heading', { name: 'Serving 1', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove serving 1', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Saved servings', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Cancel serving', exact: true }),
  ).toBeDisabled();
});

test('30 simple servings print, additions stop at the cap and editing remains available', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  for (let n = 0; n < 30; n++) await addServing(page);
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(30);
  await expect(page.getByText('30 of 30', { exact: true })).toBeVisible();
  await expect(printButton(page)).toHaveText('Print order · 30 servings');
  await expect(printButton(page)).toBeEnabled();
  await chooseServing(page, 'Chocolate');
  await expect(
    page.getByRole('button', { name: 'Add serving', exact: true }),
  ).toBeDisabled();
  await expect(printButton(page)).toBeDisabled();
  await page
    .getByRole('button', { name: 'Cancel serving', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Edit serving 30', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Save serving', exact: true }),
  ).toBeEnabled();
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    '30 servings · 31 scoops',
  );
  expect(submitted[0].ticket.servings).toHaveLength(30);
  expect(submitted[0].ticket.servings[29].flavors[0].count).toBe(2);
});

test('success toasts use ticket totals, dismiss and expire, and reprint resets the timer', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await page.clock.install();
  await page.getByLabel('Customer name (optional)').fill('Maria');
  await addServing(page, 'Chocolate');
  await chooseServing(page, 'Vanilla');
  await printButton(page).click();
  const toast = page.getByLabel('Print notification');
  await expect(toast).toContainText('Order #0001 sent to the printer');
  await expect(toast).toContainText('Maria · 2 servings · 2 scoops');
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue('');
  await expect(page.getByText('Order #0002', { exact: true })).toBeVisible();
  await page.clock.fastForward(5000);
  await toast.getByRole('button', { name: 'Reprint', exact: true }).click();
  await expect(toast).toContainText('Reprint of #0001 sent');
  await expect(toast).toContainText('Marked REPRINT on the ticket');
  await expect(
    toast.getByRole('button', { name: 'Reprint', exact: true }),
  ).toHaveCount(0);
  expect(submitted[1].ticket).toEqual(submitted[0].ticket);
  expect(submitted[1].reprint).toBe(true);
  await page.clock.fastForward(1001);
  await expect(toast).toBeVisible();
  await page.clock.fastForward(5000);
  await expect(toast).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(toast).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  await expect(toast).toHaveCount(0);
});

test('failed and unknown error toasts persist and focus recovery without hiding it on dismissal', async ({
  page,
}) => {
  await mockUsb(page);
  let sends = 0;
  await page.route('**/api/print', (route) => {
    sends++;
    const body = route.request().postDataJSON();
    return route.fulfill({
      json: {
        attemptId: body.attemptId,
        result: {
          status: sends === 1 ? 'failed' : 'outcome-unknown',
          code: 'printer-error',
          simulated: false,
          message: 'Inspect paper and physical output.',
        },
      },
    });
  });
  await page.goto('/');
  await page.clock.install();
  await chooseServing(page);
  await printButton(page).click();
  const toast = page.getByLabel('Print notification');
  await expect(toast).toHaveAttribute('role', 'alert');
  await expect(toast).toContainText('Order submission failed');
  await page.clock.fastForward(10000);
  await expect(toast).toBeVisible();
  await toast
    .getByRole('button', { name: 'Review print', exact: true })
    .click();
  await expect(page.getByLabel('Print recovery')).toBeFocused();
  await toast.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByLabel('Print recovery')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Submitted order', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(toast).toContainText('Outcome unknown');
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'New order', exact: true }),
  ).toBeDisabled();
  await page.clock.fastForward(10000);
  await expect(toast).toBeVisible();
  await toast.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('Print recovery')).toContainText(
    'Outcome unknown',
  );
  expect(sends).toBe(2);
});

test('live blank-name hint, printable name limit and button toggle semantics', async ({
  page,
}) => {
  await mockUsb(page);
  await page.goto('/');
  const name = page.getByLabel('Customer name (optional)');
  await expect(name).toHaveAttribute('placeholder', blankNameLabel(1));
  await expect(
    page.getByText(`Left blank, the ticket says “${blankNameLabel(1)}”`, {
      exact: true,
    }),
  ).toBeVisible();
  await name.fill('A'.repeat(81));
  await expect(name).toHaveValue('A'.repeat(80));
  await name.pressSequentially('B');
  await expect(name).toHaveValue('A'.repeat(80));
  await expect
    .poll(async () => (await readDraft(page)).name)
    .toBe('A'.repeat(80));
  await name.fill('');
  await chooseServing(page);
  await printButton(page).click();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(name).toHaveAttribute('placeholder', blankNameLabel(2));
  for (const container of ['Cup', 'Cake Cone', 'Sugar Cone']) {
    await page.getByRole('button', { name: container, exact: true }).click();
    for (const other of ['Cup', 'Cake Cone', 'Sugar Cone'])
      await expect(
        page.getByRole('button', { name: other, exact: true }),
      ).toHaveAttribute('aria-pressed', String(other === container));
  }
  const topping = page.getByRole('button', {
    name: 'Gummy Bears',
    exact: true,
  });
  await topping.click();
  await expect(topping).toHaveAttribute('aria-pressed', 'true');
  await topping.click();
  await expect(topping).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByLabel('Total scoops')).toHaveAttribute(
    'aria-live',
    'polite',
  );
});

test('failed intent-save transaction shows recovery and never sends or resets the order', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await page.getByLabel('Customer name (optional)').fill('Preserve this draft');
  await chooseServing(page);
  await expect
    .poll(async () => (await readDraft(page)).editor.container)
    .toBe('Cup');
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (storeNames, mode, options) {
      if (
        mode === 'readwrite' &&
        Array.isArray(storeNames) &&
        storeNames.includes('attempts')
      )
        throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return transaction.call(this, storeNames, mode, options);
    };
  });
  await printButton(page).click();
  await expect(page.getByLabel('Print notification')).toContainText(
    'Printing needs attention',
  );
  await expect(page.getByLabel('Print recovery')).toContainText(
    'Could not save print intent. No data was sent.',
  );
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'Preserve this draft',
  );
  await expect(printButton(page)).toBeDisabled();
  expect(submitted).toHaveLength(0);
  await page.getByRole('button', { name: 'Review print', exact: true }).click();
  await expect(page.getByLabel('Print recovery')).toBeFocused();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.getByLabel('Print recovery')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'Preserve this draft',
  );
  await expect(printButton(page)).toBeEnabled();
  expect(submitted).toHaveLength(0);
});
