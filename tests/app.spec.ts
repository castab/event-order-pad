import { expect, test } from '@playwright/test';

test('PassPRNT link follows saved intent; correlated callback survives offline and cannot rewrite history', async ({
  browser,
}, testInfo) => {
  // Desktop browser with Android UA + mapped HTTPS assets. This validates the
  // web handoff/recovery only; it never opens PassPRNT or sends USB data.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 12; SM-G970U) Chrome/140.0.0.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  await context.route('https://order-pad.test/**', async (route) => {
    const path = new URL(route.request().url());
    const response = await route.fetch({
      url: `http://127.0.0.1:4173${path.pathname}${path.search}`,
    });
    await route.fulfill({ response });
  });
  await page.goto('https://order-pad.test/');
  await page.getByLabel('Printer mode').selectOption('star-passprnt');
  await page
    .getByLabel('I completed USB permission and printer selection.')
    .check();
  await page
    .getByRole('button', { name: 'Print Test Ticket', exact: true })
    .click();
  const link = page.getByRole('link', { name: 'Open PassPRNT and print' });
  await expect(link).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'awaiting PassPRNT result',
  );
  await expect(page.locator('.attempts > li')).toHaveCount(1);
  const uri = new URL((await link.getAttribute('href'))!);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('phone-handoff.png'),
    fullPage: true,
  });
  const receipt = await context.newPage();
  await receipt.setViewportSize({ width: 620, height: 1100 });
  await receipt.setContent(uri.searchParams.get('html')!);
  expect(
    await receipt.locator('body').evaluate((body) => body.scrollWidth),
  ).toBe(576);
  expect(
    await receipt.locator('body').evaluate((body) => body.scrollHeight),
  ).toBeLessThan(8000);
  await expect(receipt.locator('.reference')).toContainText('ORDER #0042');
  await receipt.screenshot({
    path: testInfo.outputPath('passprnt-html.png'),
    fullPage: true,
  });
  await receipt.close();
  const back = new URL(uri.searchParams.get('back')!);
  back.searchParams.set('passprnt_code', '0');
  await expect(
    page.getByText('App assets cached · test reopening offline on this device'),
  ).toBeVisible();
  // The cached shell serves a callback navigation with query data offline.
  await context.unroute('https://order-pad.test/**');
  await context.setOffline(true);
  await page.goto(back.href);
  await expect(page.getByRole('status')).toContainText(
    'Star PassPRNT reported success',
  );
  await expect(page.locator('.attempts > li')).toHaveCount(1);
  expect(new URL(page.url()).search).toBe('');
  back.searchParams.set('passprnt_code', '7');
  await page.goto(back.href);
  await expect(page.getByRole('status')).toContainText(
    'Star PassPRNT reported success',
  );
  await context.close();
});

test('missing PassPRNT return recovers unknown without offering another launch', async ({
  browser,
}) => {
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Linux; Android 12) Chrome/140 Mobile Safari/537.36',
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  await page.route('https://order-pad.test/**', async (route) => {
    const path = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({
        url: `http://127.0.0.1:4173${path.pathname}${path.search}`,
      }),
    });
  });
  await page.goto('https://order-pad.test/');
  await page.getByLabel('Printer mode').selectOption('star-passprnt');
  await page
    .getByLabel('I completed USB permission and printer selection.')
    .check();
  await page
    .getByRole('button', { name: 'Print Test Ticket', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Open PassPRNT and print' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Recover without resending' }).click();
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  await expect(
    page.getByRole('link', { name: 'Open PassPRNT and print' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Reprint Last Ticket' }),
  ).toBeDisabled();
  await expect(page.locator('.attempts > li')).toHaveCount(1);
  await context.close();
});

test('simulate, recover, explicitly reprint, and reopen offline', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Print Test Ticket', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText('SIMULATED · NO PHYSICAL PRINT', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Print Test Ticket', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText(
    'Nothing was physically printed.',
  );
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Print Test Ticket', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reprint Last Ticket' }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Reprint Last Ticket' }).click();
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    'REPRINT',
  );
  await expect(page.getByRole('status')).toContainText(
    'Nothing was physically printed.',
  );
  await expect(
    page.getByText('App assets cached · test reopening offline on this device'),
  ).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Reprint Last Ticket' }),
  ).toBeEnabled();
  await expect(page.getByLabel('Preparation ticket preview')).toContainText(
    'REPRINT',
  );
});

test('unknown requires deliberate confirmation and never falls back from real mode', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Simulate an outcome').selectOption('outcome-unknown');
  await page
    .getByRole('button', { name: 'Print Test Ticket', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  await expect(
    page.getByRole('button', { name: 'Reprint Last Ticket' }),
  ).toBeDisabled();
  await page
    .getByLabel('I checked the output and want another ticket.')
    .check();
  await expect(
    page.getByRole('button', { name: 'Reprint Last Ticket' }),
  ).toBeEnabled();
  await page.getByLabel('Printer mode').selectOption('star-passprnt');
  await expect(
    page.getByText('Unsupported runtime', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reprint Last Ticket' }),
  ).toBeDisabled();
});

for (const viewport of [
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`tablet/readability layout ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(
      page.getByRole('button', { name: 'Print Test Ticket', exact: true }),
    ).toBeEnabled();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(page.getByLabel('Preparation ticket preview')).toContainText(
      'ORDER #0042',
    );
    await page.screenshot({
      path: testInfo.outputPath('ticket-screen.png'),
      fullPage: true,
    });
  });
}

test('unsupported IndexedDB blocks sends with an actionable notice', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get: () => {
        throw new Error('unsupported');
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('status')).toContainText(
    'IndexedDB is unavailable',
  );
  await expect(
    page.getByRole('button', { name: 'Print Test Ticket', exact: true }),
  ).toBeDisabled();
});

test('reload during an attempt recovers unknown without resending', async ({
  page,
}) => {
  // Hold only the simulator's completion timer so this recovery test does not
  // race against the speed of the browser or CI machine. No hardware is involved.
  await page.addInitScript(() => {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) =>
      originalTimeout(
        handler,
        delay === 350 ? 5000 : delay,
        ...args,
      )) as typeof window.setTimeout;
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Print Test Ticket', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Attempt saved');
  await page.reload();
  await expect(page.getByRole('status')).toContainText('Outcome unknown');
  await expect(
    page.getByRole('button', { name: 'Reprint Last Ticket' }),
  ).toBeDisabled();
  await expect(page.locator('.attempts > li')).toHaveCount(1);
});
