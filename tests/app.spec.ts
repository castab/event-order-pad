import { expect, test } from '@playwright/test';

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
  await page.getByLabel('Printer mode').selectOption('star-usb');
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
