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

async function chooseServing(
  page: Page,
  flavor = 'Vanilla',
  container = 'Cup',
  toppings: string[] = [],
) {
  await page
    .getByRole('button', { name: `Add scoop of ${flavor}`, exact: true })
    .click();
  await page.getByRole('radio', { name: container, exact: true }).check();
  for (const topping of toppings)
    await page.getByRole('checkbox', { name: topping, exact: true }).check();
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
  await expect(
    page.getByText('USB printing ready', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByText('Server setup', { exact: true })).toBeHidden();
  await expect(printButton(page)).toBeDisabled();
  await expect(
    page.getByLabel('Vanilla scoop count', { exact: true }),
  ).toHaveText('0');
  await expect(
    page.getByRole('radio', { name: 'Cup', exact: true }),
  ).not.toBeChecked();
  await page.getByLabel('Name (optional)').pressSequentially('  María & Pat  ');
  await chooseServing(page, 'Chocolate Chip', 'Sugar Cone', [
    'Gummy Bears',
    'Caramel Sauce',
  ]);
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(1);
  await expect(
    page.getByText('Included when printing', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Preparation ticket preview')).toBeHidden();
  await page.getByText('Ticket preview', { exact: true }).click();
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    'MARÍA & PAT',
  );
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    'SUGAR CONE',
  );
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText(
    'Order submitted — María & Pat',
  );
  await expect(page.getByLabel('Name (optional)')).toHaveValue('');
  await expect(page.getByLabel('Name (optional)')).toBeEnabled();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(0);
  await expect(
    page.getByRole('radio', { name: 'Cup', exact: true }),
  ).not.toBeChecked();
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
    .getByRole('button', { name: 'Add scoop of Chocolate Chip', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add scoop of Chocolate Chip', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add scoop of Strawberry', exact: true })
    .click();
  await page.getByRole('radio', { name: 'Cup', exact: true }).check();
  await page
    .getByRole('checkbox', { name: 'Gummy Bears', exact: true })
    .check();
  await expect(
    page.getByLabel('Chocolate Chip scoop count', { exact: true }),
  ).toHaveText('2');
  await expect(
    page.getByLabel('Strawberry scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(page.getByText('3 of 5 scoops', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(1);
  await expect(page.getByLabel('Order servings')).toContainText(
    '2 scoops Chocolate Chip',
  );
  await expect(page.getByLabel('Order servings')).toContainText(
    '1 scoop Strawberry',
  );
  await page.getByText('Ticket preview', { exact: true }).click();
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    '3 SCOOPS - CUP',
  );
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText('Order submitted');
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
    .getByRole('button', { name: 'Add scoop of Vanilla', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Reprint submitted');
  expect(submitted[1].ticket).toEqual(submitted[0].ticket);
  await expect(
    page.getByLabel('Vanilla scoop count', { exact: true }),
  ).toHaveText('2');
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
    .getByRole('button', { name: 'Add scoop of Chocolate Chip', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add scoop of Strawberry', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add scoop of Strawberry', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add scoop of Vanilla', exact: true })
    .click();
  await expect(page.getByText(/5 of 5 scoops/)).toContainText(
    'Remove a scoop to change flavors',
  );
  for (const flavor of ['Chocolate', 'Vanilla', 'Strawberry', 'Chocolate Chip'])
    await expect(
      page.getByRole('button', { name: `Add scoop of ${flavor}`, exact: true }),
    ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Remove scoop of Vanilla', exact: true })
    .click();
  await expect(
    page.getByLabel('Vanilla scoop count', { exact: true }),
  ).toHaveText('0');
  await expect(
    page.getByRole('button', { name: 'Remove scoop of Vanilla', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Add scoop of Chocolate', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add serving', exact: true }).click();
  await page
    .getByRole('button', { name: 'Edit serving 1', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove scoop of Strawberry', exact: true })
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
  await expect(page.getByText('4 of 5 scoops', { exact: true })).toBeVisible();
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText('Order submitted');
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
    .getByRole('button', { name: 'Remove scoop of Vanilla', exact: true })
    .click();
  await expect(printButton(page)).toBeDisabled();
  await expect(
    page.getByRole('radio', { name: 'Cup', exact: true }),
  ).toBeChecked();
  await expect(page.getByText('0 of 5 scoops', { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: 'Add scoop of Strawberry', exact: true })
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
  await expect(page.getByLabel('Name (optional)')).toBeEnabled();
  await expect(page.getByLabel('Name (optional)')).toHaveValue('');
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeDisabled();
  expect((await readDraft(page)).reference).toBe('0001');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText('Order submitted');
  expect(submitted[0].ticket.schema).toBe(2);
  expect(submitted[0].ticket.reference).toBe('0001');
  await page.reload();
  await expect(page.getByLabel('Name (optional)')).toBeEnabled();
  expect((await readDraft(page)).reference).toBe('0002');
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeEnabled();
});

test('settings preserve the draft, display the server queue, and support keyboard tab navigation', async ({
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
  await page.getByLabel('Name (optional)').fill('Alex');
  await page
    .getByRole('tab', { name: 'Printer settings', exact: true })
    .click();
  await expect(
    page.getByRole('tabpanel', { name: 'Printer settings' }),
  ).toBeVisible();
  await expect(page.getByText('Star_TSP143', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Check printer', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Check printer', exact: true })
    .click();
  await expect.poll(() => checks).toBe(3);
  await page
    .getByRole('tab', { name: 'Printer settings', exact: true })
    .focus();
  await page.keyboard.press('ArrowLeft');
  await expect(
    page.getByRole('tab', { name: 'Order', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole('tab', { name: 'Order', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Name (optional)')).toHaveValue('Alex');
  await expect(
    page.getByRole('radio', { name: 'Cake Cone', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Whipped cream', exact: true }),
  ).toBeChecked();
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
    .getByRole('button', { name: 'Add scoop of Chocolate', exact: true })
    .click();
  await expect(printButton(page)).toBeDisabled();
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
    .getByRole('button', { name: 'Remove scoop of Strawberry', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add scoop of Chocolate Chip', exact: true })
    .click();
  await page
    .getByRole('checkbox', { name: 'Gummy Bears', exact: true })
    .check();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(2);
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText('Order submitted');
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
    .getByRole('button', { name: 'Remove scoop of Vanilla', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Add scoop of Chocolate', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save serving', exact: true }).click();
  await page
    .getByRole('button', { name: 'Remove serving 2', exact: true })
    .click();
  await expect(page.getByLabel('Order servings').locator('li')).toHaveCount(1);
  await expect(page.getByLabel('Order servings')).toContainText('Chocolate');
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
  await page.getByLabel('Name (optional)').fill('First customer');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText('Order submitted');
  await page.getByLabel('Name (optional)').fill('Next customer');
  await page
    .getByRole('button', { name: 'Add scoop of Strawberry', exact: true })
    .click();
  await page
    .getByRole('checkbox', { name: 'Gummy Bears', exact: true })
    .check();
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Reprint submitted — First customer',
  );
  expect(submitted).toHaveLength(2);
  expect(submitted[1].ticket).toEqual(submitted[0].ticket);
  expect(submitted[1].attemptId).not.toBe(submitted[0].attemptId);
  expect(submitted[1].reprint).toBe(true);
  await expect(page.getByLabel('Name (optional)')).toHaveValue('Next customer');
  await expect(
    page.getByLabel('Strawberry scoop count', { exact: true }),
  ).toHaveText('1');
  await page.getByText('View last receipt', { exact: true }).click();
  await expect(page.getByLabel('Last submitted ticket preview')).toContainText(
    'REPRINT',
  );
  await expect(page.getByLabel('Last submitted ticket preview')).toContainText(
    'FIRST CUSTOMER',
  );
  await page.reload();
  await expect(page.getByLabel('Name (optional)')).toHaveValue('Next customer');
  await expect(
    page.getByRole('checkbox', { name: 'Gummy Bears', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeEnabled();
});

test('incomplete drafts reload, and blank-name fallback stays stable through submit and reprint', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await page.getByLabel('Name (optional)').fill('   ');
  await page
    .getByRole('button', { name: 'Add scoop of Strawberry', exact: true })
    .click();
  await page
    .getByRole('checkbox', { name: 'Gummy Bears', exact: true })
    .check();
  await expect
    .poll(async () => (await readDraft(page)).editor.toppings.join(','))
    .toBe('Gummy Bears');
  const reference = (await readDraft(page)).reference;
  await page
    .getByRole('tab', { name: 'Printer settings', exact: true })
    .click();
  await page.reload();
  await expect(
    page.getByRole('tab', { name: 'Order', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByLabel('Strawberry scoop count', { exact: true }),
  ).toHaveText('1');
  await expect(printButton(page)).toBeDisabled();
  await page.getByRole('radio', { name: 'Cup', exact: true }).check();
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText(
    `Order submitted — ${blankNameLabel(Number(reference))}`,
  );
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Reprint submitted');
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
    .getByRole('button', { name: 'Check printer', exact: true })
    .click();
  await expect(printButton(page)).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText('Order submitted');
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
  await page.getByLabel('Name (optional)').fill('Keep this order');
  await chooseServing(page);
  await printButton(page).click();
  await expect(page.getByRole('status')).toContainText(
    'Order submission failed',
  );
  await expect(page.getByLabel('Name (optional)')).toHaveValue(
    'Keep this order',
  );
  await expect(page.getByLabel('Name (optional)')).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Submitted order', exact: true }),
  ).toBeVisible();
  failed = false;
  await page
    .getByRole('button', { name: 'Reprint last order', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Reprint submitted');
  await expect(page.getByLabel('Name (optional)')).toHaveValue('');
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
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  await expect(
    page.getByRole('button', { name: 'New order', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reprint last order', exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  expect(sends).toBe(1);
  await page
    .getByLabel('I checked the output and am ready to continue.')
    .check();
  await page.getByRole('button', { name: 'New order', exact: true }).click();
  await chooseServing(page, 'Chocolate', 'Cup');
  await expect(printButton(page)).toBeEnabled();
  // The acknowledgment also survives tab switches in this session.
  await page
    .getByRole('tab', { name: 'Printer settings', exact: true })
    .click();
  await page.getByRole('tab', { name: 'Order', exact: true }).click();
  await expect(printButton(page)).toBeEnabled();
});

test('pending requests block repeated taps and tab switches preserve the running submission', async ({
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
  await page
    .getByRole('tab', { name: 'Printer settings', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Check printer', exact: true }),
  ).toBeDisabled();
  await page.getByRole('tab', { name: 'Order', exact: true }).click();
  release();
  await expect(page.getByRole('status')).toContainText('Order submitted');
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
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
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
  await expect(page.getByRole('status')).toContainText('Order submitted');
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
  await expect(page.getByLabel('Name (optional)')).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('Order submitted');
  expect(submitted).toHaveLength(1);
});

test('overlength orders block printing with a clear message and recover after removing servings', async ({
  page,
}) => {
  const { submitted } = await mockUsb(page);
  await page.goto('/');
  await expect(page.getByLabel('Name (optional)')).toBeEnabled();
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
  await expect(page.getByRole('status')).toContainText('Order submitted');
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
  await page
    .getByRole('tab', { name: 'Printer settings', exact: true })
    .click();
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
    await page.getByLabel('Name (optional)').fill('Alex');
    await chooseServing(page, 'Chocolate Chip', 'Sugar Cone', ['Gummy Bears']);
    await page
      .getByRole('button', { name: 'Add scoop of Chocolate Chip', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Add scoop of Strawberry', exact: true })
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
    await page.screenshot({
      path: testInfo.outputPath('order-screen.png'),
      fullPage: true,
    });
    await page.getByText('Ticket preview', { exact: true }).click();
    await expect(page.getByLabel('Preparation ticket preview')).toContainText(
      'ALEX',
    );
    await page
      .getByRole('tab', { name: 'Printer settings', exact: true })
      .click();
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
