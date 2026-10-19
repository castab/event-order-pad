import { test, expect, type Page } from '@playwright/test';
import { mockStationApi } from './helpers/station-api';

const code = 'K7QM4XTD9A';
async function widget(page: Page, automatic = true) {
  await page.route(
    'https://challenges.cloudflare.com/turnstile/v0/api.js*',
    (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
    (() => { let callback; window.turnstileResets = 0; window.turnstileOptions = [];
      const issue = () => setTimeout(() => callback && callback('test-token'), 1);
      window.issueTurnstileToken = issue;
      window.turnstile = {
      render: (_element, options) => { callback = options.callback; window.turnstileOptions.push(options); if (${automatic}) issue(); return 'widget'; },
      reset: () => { window.turnstileResets++; if (${automatic}) issue(); }, remove: () => {}
    }; })();`,
      }),
  );
}
async function setup(
  page: Page,
  initial = false,
  { automaticTurnstile = true } = {},
) {
  const station = await mockStationApi(page);
  let signedIn = initial;
  let limited = false;
  let current = code;
  const used = new Set<string>();
  await widget(page, automaticTurnstile);
  await page.route('**/api/auth/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body =
      route.request().method() === 'POST' ? route.request().postDataJSON() : {};
    const reply = (json: unknown, status = 200) =>
      route.fulfill({ status, json });
    if (path.endsWith('/config')) return reply({ sitekey: 'test-sitekey' });
    if (path.endsWith('/session'))
      return signedIn
        ? reply({
            expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(),
            authenticatedAt: new Date().toISOString(),
          })
        : reply(
            { error: 'Sign in to continue.', code: 'authentication-required' },
            401,
          );
    if (path.endsWith('/logout')) {
      signedIn = false;
      return reply({ ok: true });
    }
    if (path.endsWith('/login')) {
      if (limited)
        return reply({ error: 'Too many attempts. Try again later.' }, 429);
      const typed = String(body.code).replace(/[\s-]/g, '').toUpperCase();
      if (typed !== current || used.has(typed) || !body.turnstile)
        return reply(
          {
            error:
              'That code isn’t valid. Each code works once, within an hour of printing. Ask for a new slip.',
          },
          401,
        );
      used.add(typed);
      signedIn = true;
      return reply({ ok: true });
    }
    return reply({ error: 'Not found' }, 404);
  });
  await page.route('**/api/features', (r) =>
    r.fulfill({ json: { trackingEnabled: true } }),
  );
  await page.route('**/api/printer', (r) =>
    r.fulfill({ json: { ready: true, message: 'Ready', queue: 'OrderPad' } }),
  );
  return {
    ...station,
    /** The station signed this device out and handed it a fresh code. */
    rotate: (next: string) => {
      current = next;
      signedIn = false;
    },
    signOut: () => {
      signedIn = false;
    },
    limit: () => {
      limited = true;
    },
  };
}
async function enterCode(page: Page, value = code) {
  await page.getByLabel('Access code', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Start shift', exact: true }).click();
}
const accessMenu = (page: Page) =>
  page.getByRole('button', { name: /^Access until / });
async function signOut(page: Page) {
  await accessMenu(page).click();
  await page
    .getByRole('menuitem', { name: 'Sign out this device', exact: true })
    .click();
}
test('Turnstile keeps a successful token until submission and refreshes once after rejection', async ({
  page,
}) => {
  await page.clock.install();
  const auth = await setup(page);
  auth.limit();
  await page.goto('/login/');
  const resets = () =>
    page.evaluate(
      () => (window as unknown as { turnstileResets: number }).turnstileResets,
    );
  // Wait for the widget to render, then let it issue its token.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { turnstileOptions?: unknown[] })
            .turnstileOptions?.length,
      ),
    )
    .toBe(1);
  await page.clock.runFor(1000);
  expect(await resets()).toBe(0);
  const submitted = page.waitForRequest('**/api/auth/login');
  await enterCode(page);
  expect((await submitted).postDataJSON().turnstile).toBe('test-token');
  await expect(page.getByRole('alert')).toContainText('Too many attempts');
  await page.clock.runFor(1000);
  expect(await resets()).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Start shift', exact: true }),
  ).toBeEnabled();
});
test('an access code signs in, the access menu signs out, and back navigation stays protected', async ({
  page,
}) => {
  const auth = await setup(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\/?$/);
  await expect(page.getByRole('link', { name: /enroll|recover/i })).toHaveCount(
    0,
  );
  const loginRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/login'))
      loginRequests.push(request.url());
  });
  const field = page.getByLabel('Access code', { exact: true });
  const start = page.getByRole('button', { name: 'Start shift', exact: true });
  await expect(start).toBeDisabled();
  await expect(page.locator('#access-code-count')).toHaveText(
    '10 letters and numbers. Capitals and the dash are added for you.',
  );
  // Letters the code alphabet leaves out (O, I, L, 0, 1) are ignored as typed.
  await field.pressSequentially('k7qm4o1xi');
  await expect(field).toHaveValue('K7QM4-X');
  await expect(page.locator('#access-code-count')).toHaveText(
    '6 of 10 characters',
  );
  await expect(start).toBeDisabled();
  await field.pressSequentially('td9bL');
  await expect(field).toHaveValue('K7QM4-XTD9B');
  await expect(page.locator('#access-code-count')).toHaveText('Ready');
  expect(loginRequests).toHaveLength(0);
  await start.click();
  await expect(page.getByRole('alert')).toHaveText(
    'That code isn’t valid. Each code works once, within an hour of printing. Ask for a new slip.',
  );
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  // Typed the way it might be read off the slip: lowercase, with the hyphen.
  await enterCode(page, 'k7qm4-xtd9a');
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  const menu = accessMenu(page);
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('menuitem', { name: 'Sign out this device' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(menu).toBeFocused();
  await signOut(page);
  await expect(page).toHaveURL(/\/login\/?$/);
  await page.goBack();
  await expect(page.getByLabel('Customer name (optional)')).not.toBeVisible();
  await page.goto('/login/');
  auth.limit();
  await enterCode(page);
  await expect(page.getByRole('alert')).toContainText('Too many attempts');
});
test('pressing Start shift before Turnstile has a token waits for it instead of failing', async ({
  page,
}) => {
  await setup(page, false, { automaticTurnstile: false });
  await page.goto('/login/');
  const button = page.getByRole('button', { name: 'Start shift', exact: true });
  await page.getByLabel('Access code', { exact: true }).fill(code);
  await expect(button).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              turnstileOptions?: { appearance: string; theme: string }[];
            }
          ).turnstileOptions?.[0],
      ),
    )
    .toMatchObject({ appearance: 'interaction-only', theme: 'light' });
  let requested = false;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/login')) requested = true;
  });
  await enterCode(page);
  await expect(
    page.getByRole('button', { name: 'Checking…', exact: true }),
  ).toBeDisabled();
  expect(requested).toBe(false);
  await expect(page.getByRole('alert')).toHaveCount(0);
  const submitted = page.waitForRequest('**/api/auth/login');
  await page.evaluate(() =>
    (
      window as unknown as { issueTurnstileToken(): void }
    ).issueTurnstileToken(),
  );
  expect((await submitted).postDataJSON().turnstile).toBe('test-token');
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
});
test('a Turnstile token that never arrives stops waiting after 15 seconds', async ({
  page,
}) => {
  await page.clock.install();
  await setup(page, false, { automaticTurnstile: false });
  await page.goto('/login/');
  await enterCode(page);
  await expect(
    page.getByRole('button', { name: 'Checking…', exact: true }),
  ).toBeVisible();
  await page.clock.runFor(15000);
  await expect(page.getByRole('alert')).toHaveText(
    'Couldn’t verify this browser. Check your connection and try again.',
  );
  await expect(
    page.getByRole('button', { name: 'Start shift', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { turnstileResets: number }).turnstileResets,
    ),
  ).toBe(1);
});
test('a new code during a print waits for it, then recovers its durable result without replay', async ({
  page,
}) => {
  const auth = await setup(page, true);
  let complete!: () => void;
  let reached!: () => void;
  const printing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let sends = 0;
  let expired = false;
  await page.route('**/api/station', async (route) => {
    if (
      route.request().method() === 'POST' &&
      route.request().postDataJSON().operation === 'finishAttempt' &&
      expired
    )
      return route.fulfill({
        status: 401,
        json: {
          error: 'Sign in to continue.',
          code: 'authentication-required',
        },
      });
    return route.fallback();
  });
  await page.route('**/api/print', async (route) => {
    sends++;
    const body = route.request().postDataJSON();
    reached();
    await finish;
    const attempt = auth.station.store.attempts.get(body.attemptId)!;
    const result = {
      status: 'accepted' as const,
      simulated: false,
      message: 'CUPS accepted the job.',
    };
    await auth.station.store.finishAttempt({
      ...attempt,
      result,
      completedAt: new Date().toISOString(),
    });
    await route.fulfill({ json: { attemptId: body.attemptId, result } });
  });
  await page.goto('/');
  await page
    .getByRole('button', { name: 'Add a Vanilla scoop', exact: true })
    .click();
  await page.getByRole('button', { name: 'Cup', exact: true }).click();
  await page.getByRole('button', { name: /^Print order/ }).click();
  await printing;
  auth.rotate('ZYXWV98765');
  expired = true;
  // The session poll must not navigate while the print request remains pending.
  await expect(
    page.getByText(
      'Signed out or the session ended. Waiting for current work to finish safely…',
    ),
  ).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL('http://localhost:4175/');
  complete();
  await expect(page).toHaveURL(/\/login\/?$/);
  expired = false;
  await enterCode(page, code);
  await expect(page.getByRole('alert')).toHaveText(
    'That code isn’t valid. Each code works once, within an hour of printing. Ask for a new slip.',
  );
  await enterCode(page, 'ZYXWV98765');
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  expect(sends).toBe(1);
  expect([...auth.station.store.attempts.values()].at(-1)?.result?.status).toBe(
    'accepted',
  );
});
test('offline navigation never serves a cached protected page after logout', async ({
  page,
  context,
}) => {
  await setup(page, true);
  await page.goto('/');
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await signOut(page);
  await expect(page).toHaveURL(/\/login\/?$/);
  const paths = await page.evaluate(async () => {
    const all = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        all.push(new URL(request.url).pathname);
    return all;
  });
  expect(paths).not.toContain('/');
  expect(paths).not.toContain('/queue/');
  expect(paths.some((p) => p.startsWith('/api/'))).toBe(false);
  await context.setOffline(true);
  await page.goto('/').catch(() => undefined);
  await expect(page.getByLabel('Customer name (optional)')).not.toBeVisible();
  await context.setOffline(false);
});

test('signing in with a new code restores this browser’s saved draft', async ({
  page,
}) => {
  const auth = await setup(page, true);
  await page.goto('/');
  await page.getByLabel('Customer name (optional)').fill('Before the new code');
  await expect
    .poll(async () => (await auth.station.load()).draft.name)
    .toBe('Before the new code');
  auth.rotate('ZYXWV98765');
  await page.reload();
  await expect(page).toHaveURL(/\/login\/?$/);
  await enterCode(page, 'ZYXWV98765');
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'Before the new code',
  );
});
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
])
  test(`the sign-in screen and access menu lay out at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.goto('/login/');
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    const field = page.getByLabel('Access code', { exact: true });
    expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await enterCode(page);
    await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
    const menu = accessMenu(page);
    await expect(menu).toBeVisible();
    expect((await menu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    // Phones keep the time as the accessible name only.
    const label = (await page.getByText(/^Until /).boundingBox())!;
    if (viewport.width > 520) expect(label.width).toBeGreaterThan(40);
    else expect(label.width).toBeLessThanOrEqual(1);
    await menu.click();
    const item = page.getByRole('menuitem', { name: 'Sign out this device' });
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
