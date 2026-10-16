import { test, expect, type Page } from '@playwright/test';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { mockStationApi } from './helpers/station-api';

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
  let failPassword = false;
  const passkeys: { name: string; credential: WebAuthnCredential }[] = [];
  let challenge = '';
  let validToken = 'a'.repeat(64);
  let authenticatedAt = Date.now();
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
            user: { id: 'staff', username: 'staff' },
            expiresAt: new Date(Date.now() + 57600000).toISOString(),
            authenticatedAt: new Date(authenticatedAt).toISOString(),
          })
        : reply(
            { error: 'Sign in to continue.', code: 'authentication-required' },
            401,
          );
    if (path.endsWith('/logout') || path.endsWith('/logout-all')) {
      signedIn = false;
      return reply({ ok: true });
    }
    if (path.endsWith('/enroll') || path.endsWith('/recover')) {
      if (body.token !== validToken)
        return reply(
          { error: 'This enrollment or recovery link is invalid or expired.' },
          400,
        );
      validToken = '';
      signedIn = true;
      authenticatedAt = Date.now();
      return reply({ ok: true });
    }
    if (path.endsWith('/reauthenticate')) {
      if (body.password !== 'a long enough password' || !body.turnstile)
        return reply({ error: 'Sign-in failed.' }, 401);
      authenticatedAt = Date.now();
      return reply({ ok: true });
    }
    if (path.endsWith('/password')) {
      if (Date.now() - authenticatedAt > 300000)
        return reply(
          {
            error:
              'Confirm your password or passkey before changing credentials.',
          },
          403,
        );
      return reply({ ok: true });
    }
    if (path.endsWith('/login')) {
      if (failPassword)
        return reply({ error: 'Too many attempts. Try again later.' }, 429);
      if (
        body.username !== 'staff' ||
        body.password !== 'a long enough password' ||
        !body.turnstile
      )
        return reply({ error: 'Sign-in failed.' }, 401);
      signedIn = true;
      return reply({ ok: true });
    }
    if (path.endsWith('/passkeys'))
      return reply({
        passkeys: passkeys.map((k) => ({
          id: k.credential.id,
          name: k.name,
          createdAt: new Date().toISOString(),
        })),
      });
    if (path.endsWith('/register/options')) {
      const options = await generateRegistrationOptions({
        rpName: 'Order Pad',
        rpID: 'localhost',
        userName: 'staff',
        userID: new TextEncoder().encode('staff'),
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
      });
      challenge = options.challenge;
      return reply({ options });
    }
    if (path.endsWith('/register/verify')) {
      const verified = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: 'http://localhost:4175',
        expectedRPID: 'localhost',
        requireUserVerification: true,
      });
      if (!verified.verified || !verified.registrationInfo)
        return reply({ error: 'Invalid passkey' }, 400);
      passkeys.push({
        name: body.name,
        credential: verified.registrationInfo.credential,
      });
      challenge = '';
      return reply({ ok: true });
    }
    if (path.endsWith('/login/options')) {
      expect(body.turnstile).toBeTruthy();
      const options = await generateAuthenticationOptions({
        rpID: 'localhost',
        userVerification: 'required',
      });
      challenge = options.challenge;
      return reply({ options });
    }
    if (path.endsWith('/login/verify')) {
      const credential = passkeys.find(
        (k) => k.credential.id === body.response.id,
      )?.credential;
      if (!credential) return reply({ error: 'Invalid passkey' }, 400);
      const verified = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: challenge,
        expectedOrigin: 'http://localhost:4175',
        expectedRPID: 'localhost',
        requireUserVerification: true,
        credential,
      });
      expect(verified.verified).toBe(true);
      credential.counter = verified.authenticationInfo.newCounter;
      challenge = '';
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
    signOut: () => {
      signedIn = false;
    },
    limitPassword: () => {
      failPassword = true;
    },
    authenticatedMinutesAgo: (minutes: number) => {
      authenticatedAt = Date.now() - minutes * 60000;
    },
    passkeys,
  };
}
async function openAccount(page: Page, username = 'staff') {
  await page.getByRole('button', { name: username, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Your account' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your account', level: 1 }),
  ).toBeVisible();
}
async function virtualAuthenticator(page: Page) {
  const client = await page.context().newCDPSession(page);
  await client.send('WebAuthn.enable');
  const { authenticatorId } = await client.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  );
  return {
    client,
    authenticatorId,
    remove: () =>
      client.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }),
  };
}
async function passwordLogin(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill('staff');
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long enough password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('Turnstile keeps a successful token until submission and refreshes once after rejection', async ({
  page,
}) => {
  await page.clock.install();
  const auth = await setup(page);
  auth.limitPassword();
  await page.goto('/login/');
  await page.clock.runFor(1000);
  const resets = () =>
    page.evaluate(
      () => (window as unknown as { turnstileResets: number }).turnstileResets,
    );
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeEnabled();
  expect(await resets()).toBe(0);
  const submitted = page.waitForRequest('**/api/auth/login');
  await passwordLogin(page);
  expect((await submitted).postDataJSON().turnstile).toBe('test-token');
  await expect(page.getByRole('alert')).toContainText('Too many attempts');
  await page.clock.runFor(1000);
  expect(await resets()).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeEnabled();
});
test('password login, rate-limit feedback, logout and back navigation protect the builder', async ({
  page,
}) => {
  const auth = await setup(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\/?$/);
  const loginRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/login'))
      loginRequests.push(request.url());
  });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Enter your username and password.',
  );
  await expect(page.getByLabel('Username', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(loginRequests).toHaveLength(0);
  await passwordLogin(page);
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  const menu = page.getByRole('button', { name: 'staff', exact: true });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('menuitem', { name: 'Your account' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(menu).toBeFocused();
  await menu.click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login\/?$/);
  await page.goBack();
  await expect(page.getByLabel('Customer name (optional)')).not.toBeVisible();
  await page.goto('/login/');
  auth.limitPassword();
  await passwordLogin(page);
  await expect(page.getByRole('alert')).toContainText('Too many attempts');
});
test('enrollment removes its fragment, shows the linked code and checks both passwords', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/enroll/#' + 'a'.repeat(64));
  await expect(page).toHaveURL(/\/enroll\/?$/);
  await expect(
    page.getByText('Invite code added from your link'),
  ).toBeVisible();
  await expect(page.getByLabel('Invite code')).toHaveCount(0);
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeDisabled();
  const password = page.getByLabel('New password', { exact: true });
  await password.fill('mint chip');
  await expect(
    page.getByText('9 of 15 characters. 6 more to go.'),
  ).toBeVisible();
  await password.fill('a long enough password');
  await expect(page.getByText('✓ Long enough.')).toBeVisible();
  await page
    .getByLabel('Type it again', { exact: true })
    .fill('another long password');
  await expect(
    page.getByText('The two passwords don’t match yet.'),
  ).toBeVisible();
  await expect(create).toBeDisabled();
  await page
    .getByLabel('Type it again', { exact: true })
    .fill('a long enough password');
  await create.click();
  await expect(
    page.getByRole('heading', { name: 'Your account is ready' }),
  ).toBeVisible();
  await expect(page.getByLabel('Name this device')).toHaveValue(
    'This computer',
  );
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'All set' })).toBeVisible();
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
});
test('the code field appears only without a link code or when asked for', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/enroll/');
  await expect(page.getByText('Invite code added from your link')).toHaveCount(
    0,
  );
  await expect(page.getByLabel('Invite code')).toBeVisible();
  await expect(
    page.getByText('Paste the code from the link you were sent.'),
  ).toBeVisible();
  await page.goto('/recover/#' + 'b'.repeat(64));
  await expect(page).toHaveURL(/\/recover\/?$/);
  await expect(
    page.getByRole('heading', { name: 'Recover your account' }),
  ).toBeVisible();
  await expect(
    page.getByText('Recovery code added from your link'),
  ).toBeVisible();
  await expect(page.getByLabel('Recovery code')).toHaveCount(0);
  await page.getByRole('button', { name: 'Enter a code instead' }).click();
  await expect(page.getByLabel('Recovery code')).toBeFocused();
  await expect(page.getByLabel('Recovery code')).toHaveValue('');
});
test('an expired or used code explains how to get a new one', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/recover/#' + 'c'.repeat(64));
  await page
    .getByLabel('New password', { exact: true })
    .fill('a long enough password');
  await page
    .getByLabel('Type it again', { exact: true })
    .fill('a long enough password');
  await page.getByRole('button', { name: 'Set new password' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Ask whoever runs the station for a new one. Recovery codes last 30 minutes.',
  );
});
test('enrollment offers a passkey and adds one before opening the builder', async ({
  page,
}) => {
  const auth = await setup(page);
  const authenticator = await virtualAuthenticator(page);
  try {
    await page.goto('/enroll/#' + 'a'.repeat(64));
    await page
      .getByLabel('New password', { exact: true })
      .fill('a long enough password');
    await page
      .getByLabel('Type it again', { exact: true })
      .fill('a long enough password');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByLabel('Name this device').fill('Trailer tablet');
    await page
      .getByRole('button', { name: 'Add a passkey', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Passkey added' }),
    ).toBeVisible();
    expect(auth.passkeys.map((key) => key.name)).toEqual(['Trailer tablet']);
    await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  } finally {
    await authenticator.remove();
  }
});
test('pressing Sign in before Turnstile has a token waits for it instead of failing', async ({
  page,
}) => {
  await setup(page, false, { automaticTurnstile: false });
  await page.goto('/login/');
  const button = page.getByRole('button', { name: 'Sign in', exact: true });
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
  await passwordLogin(page);
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
  await passwordLogin(page);
  await expect(
    page.getByRole('button', { name: 'Checking…', exact: true }),
  ).toBeVisible();
  await page.clock.runFor(15000);
  await expect(page.getByRole('alert')).toHaveText(
    'Couldn’t verify this browser. Check your connection and try again.',
  );
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as unknown as { turnstileResets: number }).turnstileResets,
    ),
  ).toBe(1);
});
test('a virtual authenticator enrolls a discoverable passkey and signs in without a password', async ({
  page,
}) => {
  const auth = await setup(page, true);
  const { client, authenticatorId, remove } = await virtualAuthenticator(page);
  try {
    await page.goto('/account/');
    await expect(
      page.getByText('No passkeys yet. You sign in with your password.'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Add a passkey', exact: true })
      .click();
    // A fresh sign-in needs no confirmation.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Name this device').fill('Test phone');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('Passkey added.')).toBeVisible();
    await expect(page.getByText('Test phone')).toBeVisible();
    expect(auth.passkeys).toHaveLength(1);
    const credentials = await client.send('WebAuthn.getCredentials', {
      authenticatorId,
    });
    expect(credentials.credentials[0].isResidentCredential).toBe(true);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
    expect(auth.passkeys[0].credential.counter).toBeGreaterThan(0);
  } finally {
    await remove();
  }
});
test('session loss waits for the active print and recovers its durable result without replay', async ({
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
  auth.signOut();
  expired = true;
  // The session poll must not navigate while the print request remains pending.
  await expect(
    page.getByText(
      'Sign-in expired. Waiting for current work to finish safely…',
    ),
  ).toBeVisible({ timeout: 20000 });
  await expect(page).toHaveURL('http://localhost:4175/');
  complete();
  await expect(page).toHaveURL(/\/login\/?$/);
  expired = false;
  await passwordLogin(page);
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
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
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

test('switching accounts in one browser hides and restores each user’s saved draft', async ({
  page,
}) => {
  const { MemoryStationRepository } = await import('./helpers/station');
  const stations = {
    staff: new MemoryStationRepository(),
    second: new MemoryStationRepository(),
  };
  let user: 'staff' | 'second' | undefined = 'staff';
  await setup(page, true);
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      status: user ? 200 : 401,
      json: user
        ? {
            user: { id: user, username: user },
            expiresAt: new Date(Date.now() + 57600000).toISOString(),
            authenticatedAt: new Date().toISOString(),
          }
        : { code: 'authentication-required', error: 'Sign in to continue.' },
    }),
  );
  await page.route('**/api/auth/logout', (route) => {
    user = undefined;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/auth/login', (route) => {
    user = route.request().postDataJSON().username;
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/station', async (route) => {
    if (!user)
      return route.fulfill({
        status: 401,
        json: { code: 'authentication-required' },
      });
    const state =
      route.request().method() === 'POST'
        ? await stations[user].mutate(route.request().postDataJSON())
        : await stations[user].load();
    return route.fulfill({ json: state });
  });
  await page.goto('/');
  await page.getByLabel('Customer name (optional)').fill('First user’s draft');
  await expect
    .poll(async () => (await stations.staff.load()).draft.name)
    .toBe('First user’s draft');
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('second');
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long enough password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue('');
  await page.getByLabel('Customer name (optional)').fill('Second user’s draft');
  await expect
    .poll(async () => (await stations.second.load()).draft.name)
    .toBe('Second user’s draft');
  await openAccount(page, 'second');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await passwordLogin(page);
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'First user’s draft',
  );
});

test('an older sign-in asks “Confirm it’s you” and then continues into the pressed action', async ({
  page,
}) => {
  const auth = await setup(page, true);
  auth.authenticatedMinutesAgo(10);
  await page.goto('/account/');
  await expect(page.getByText(/Changes unlocked/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Change password' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(
      'To change your password, confirm your identity. Changes stay unlocked for 5 minutes.',
    ),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Confirm with a passkey' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Change password' }).click();
  await dialog
    .getByLabel('Password for staff', { exact: true })
    .fill('a long enough password');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('Changes unlocked · 5 min left', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('New password', { exact: true })
    .fill('a brand new long password');
  await page
    .getByLabel('Type it again', { exact: true })
    .fill('a brand new long password');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(
    page.getByText(
      'Password changed. You’ve been signed out on your other devices.',
    ),
  ).toBeVisible();
  // Locking only hides the unlock here, so the next change asks again.
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(page.getByText(/Changes unlocked/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(dialog).toBeVisible();
});
test('sign out everywhere also ends this session and says so', async ({
  page,
}) => {
  await setup(page, true);
  await page.goto('/account/');
  await page.getByRole('button', { name: 'Sign out everywhere' }).click();
  await expect(page).toHaveURL(/\/login\/?$/);
  await expect(page.getByRole('status')).toHaveText(
    'Signed out everywhere, including this device.',
  );
});
for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
])
  test(`the account page lays out at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page, true);
    await page.goto('/');
    await openAccount(page);
    const box = async (name: string) =>
      (await page.getByRole('region', { name, exact: true }).boundingBox())!;
    const who = await box('Signed-in user');
    const keys = await box('Passkeys');
    const password = await box('Password');
    const sessions = await box('Signed in');
    const admin = await box('Adding staff or locked out?');
    const nav = page.getByRole('navigation', { name: 'Main' });
    if (viewport.width < 860) {
      await expect(nav).toBeHidden();
      // One column in reading order.
      expect(who.y).toBeLessThan(keys.y);
      expect(keys.y).toBeLessThan(password.y);
      expect(password.y).toBeLessThan(sessions.y);
      expect(sessions.y).toBeLessThan(admin.y);
      expect(Math.abs(keys.x - sessions.x)).toBeLessThan(2);
    } else {
      await expect(nav).toBeVisible();
      await expect(
        nav.getByRole('link', { name: 'Now Scooping' }),
      ).toBeVisible();
      expect(keys.x).toBeGreaterThan(who.x + who.width);
      expect(Math.abs(password.x - keys.x)).toBeLessThan(2);
      expect(Math.abs(sessions.x - who.x)).toBeLessThan(40);
      expect(sessions.y).toBeGreaterThan(who.y);
      expect(admin.y).toBeGreaterThan(sessions.y);
    }
    const overflow = await page.evaluate(() => {
      const root = document.querySelector('.account-app')!;
      return root.scrollWidth - root.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    for (const button of await page.getByRole('button').all())
      if (await button.isVisible())
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
