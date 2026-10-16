import { testAuth } from './helpers/auth';
import { test, expect } from '@playwright/test';
import { realpath } from 'node:fs/promises';
import { createApp } from '../printer-service/http';
import { Orders } from '../printer-service/orders';
import { Cups, type Command } from '../printer-service/cups';
import { Printing } from '../printer-service/printing';
import { MemoryStationRepository, MemoryPrintJournal } from './helpers/station';
import {
  MemoryOrderRepository,
  testCaptureFrom,
} from './helpers/order-repository';

test('two authenticated browsers edit independently, serialize prints, and recover their own tickets', async ({
  browser,
}) => {
  const repository = new MemoryOrderRepository();
  const station = new MemoryStationRepository(repository);
  const journal = new MemoryPrintJournal();
  const origin = new URL('http://127.0.0.1:0');
  const submissions: string[] = [];
  let release!: () => void;
  let reached!: () => void;
  const firstSubmission = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const run: Command = async (program, args) => {
    if (program === 'lpoptions')
      return 'PageSize/Size: *Custom\nPageType/Type: *Variable0\nPageCutType/Cut: *NoCutPage0\nDocCutType/Cut: *PartialCutDoc1';
    if (program === 'lpstat')
      return args.includes('-o')
        ? ''
        : 'printer OrderPad idle\nOrderPad accepting requests\ndevice: usb://Star/TSP';
    const attemptId = args[args.indexOf('-t') + 1].replace('OrderPad-', '');
    expect((await journal.get(attemptId))?.request).toBeDefined();
    expect((await repository.list('open')).length).toBeGreaterThanOrEqual(1);
    submissions.push(attemptId);
    if (submissions.length === 1) {
      reached();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return 'request id is OrderPad-' + submissions.length + ' (1 file(s))';
  };
  const server = createApp({
    auth: testAuth(),
    origin,
    port: 4174,
    root: await realpath('build'),
    station,
    orders: new Orders(repository, testCaptureFrom),
    cups: new Cups('OrderPad', run),
    printing: new Printing(
      new Cups('OrderPad', run),
      journal,
      'Courier',
      async () => Buffer.from('%PDF-test'),
    ),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin.port = String((server.address() as { port: number }).port);
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    const first = await a.newPage();
    const second = await b.newPage();
    await Promise.all([first.goto(origin.origin), second.goto(origin.origin)]);
    const name = (page: typeof first) =>
      page.getByLabel('Customer name (optional)');
    await expect(name(first)).toBeEnabled();
    await expect(name(second)).toBeEnabled();
    await expect(
      first.getByRole('banner').getByText('New order', { exact: true }),
    ).toBeVisible();
    await expect(
      second.getByRole('banner').getByText('New order', { exact: true }),
    ).toBeVisible();
    const cookiesA = await a.cookies();
    const cookie = cookiesA.find(
      (cookie) => cookie.name === '__Host-order-pad-browser',
    )!;
    expect(cookie).toMatchObject({
      secure: true,
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(
      (await b.cookies()).find(
        (cookie) => cookie.name === '__Host-order-pad-browser',
      )?.value,
    ).not.toBe(cookie.value);
    const configure = async (
      page: typeof first,
      customer: string,
      flavor: string,
    ) => {
      await name(page).fill(customer);
      await page
        .getByRole('button', {
          name: 'Add a ' + flavor + ' scoop',
          exact: true,
        })
        .click();
      await page.getByRole('button', { name: 'Cup', exact: true }).click();
    };
    await Promise.all([
      configure(first, 'Alice', 'Vanilla'),
      configure(second, 'Bob', 'Chocolate'),
    ]);
    await first
      .getByRole('button', { name: 'Print order', exact: true })
      .click();
    await firstSubmission;
    await expect(name(second)).toHaveValue('Bob');
    await second
      .getByRole('button', { name: 'Print order', exact: true })
      .click();
    await expect
      .poll(async () => (await repository.list('open')).length)
      .toBe(2);
    expect(submissions).toHaveLength(1);
    release();
    await expect(first.getByLabel('Print notification')).toContainText(
      'Order #0001 sent',
    );
    await expect(second.getByLabel('Print notification')).toContainText(
      'Order #0002 sent',
    );
    expect(submissions).toHaveLength(2);
    await Promise.all([
      name(first).fill('Next Alice'),
      name(second).fill('Next Bob'),
    ]);
    await Promise.all([first.reload(), second.reload()]);
    await expect(name(first)).toHaveValue('Next Alice');
    await expect(name(second)).toHaveValue('Next Bob');
    await first
      .getByRole('button', { name: 'Reprint last order', exact: true })
      .click();
    await expect(first.getByLabel('Print notification')).toContainText(
      'Reprint of #0001 sent',
    );
    expect(submissions).toHaveLength(3);
    expect(await repository.list('open')).toHaveLength(2);
    await expect(name(second)).toHaveValue('Next Bob');
    const restored = await browser.newContext({
      storageState: await a.storageState(),
    });
    try {
      const page = await restored.newPage();
      await page.goto(origin.origin);
      await expect(name(page)).toHaveValue('Next Alice');
    } finally {
      await restored.close();
    }
  } finally {
    release?.();
    await Promise.all([a.close(), b.close()]);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
