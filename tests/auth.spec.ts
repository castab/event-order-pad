import { test, expect, type Page } from '@playwright/test';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type WebAuthnCredential,
} from '@simplewebauthn/server';
import { mockStationApi } from './helpers/station-api';

async function widget(page: Page) {
  await page.route(
    'https://challenges.cloudflare.com/turnstile/v0/api.js*',
    (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `
    (() => { let callback; window.turnstile = {
      render: (_element, options) => { callback = options.callback; setTimeout(() => callback('test-token'), 1); return 'widget'; },
      reset: () => setTimeout(() => callback && callback('test-token'), 1), remove: () => {}
    }; })();`,
      }),
  );
}
async function setup(page: Page, initial = false) {
  const station = await mockStationApi(page);
  let signedIn = initial;
  let failPassword = false;
  const passkeys: { name: string; credential: WebAuthnCredential }[] = [];
  let challenge = '';
  let validToken = 'a'.repeat(64);
  await widget(page);
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
            authenticatedAt: new Date().toISOString(),
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
    passkeys,
  };
}
async function openAccount(page: Page) {
  const link = page.getByRole('link', { name: 'Account', exact: true });
  if (!(await link.isVisible()))
    await page
      .getByRole('button', { name: 'Order tools', exact: true })
      .click();
  await link.click();
}
async function passwordLogin(page: Page) {
  await page.getByLabel('Username', { exact: true }).fill('staff');
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long enough password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('password login, rate-limit feedback, logout and back navigation protect the builder', async ({
  page,
}) => {
  const auth = await setup(page);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\/?$/);
  await passwordLogin(page);
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login\/?$/);
  await page.goBack();
  await expect(page.getByLabel('Customer name (optional)')).not.toBeVisible();
  await page.goto('/login/');
  auth.limitPassword();
  await passwordLogin(page);
  await expect(page.getByRole('alert')).toContainText('Too many attempts');
});
test('enrollment removes its fragment and validates password confirmation', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/enroll/#' + 'a'.repeat(64));
  await expect(page).toHaveURL(/\/enroll\/?$/);
  await expect(page.getByLabel('Enrollment code')).toHaveValue('a'.repeat(64));
  await page
    .getByLabel('New password', { exact: true })
    .fill('a long enough password');
  await page
    .getByLabel('Confirm password', { exact: true })
    .fill('another long password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('alert')).toContainText('do not match');
  await page
    .getByLabel('Confirm password', { exact: true })
    .fill('a long enough password');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByLabel('Customer name (optional)')).toBeEnabled();
});
test('a virtual authenticator enrolls a discoverable passkey and signs in without a password', async ({
  page,
  context,
}) => {
  const auth = await setup(page, true);
  const client = await context.newCDPSession(page);
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
  try {
    await page.goto('/account/');
    await page.getByLabel('Passkey name').fill('Test phone');
    await page
      .getByRole('button', { name: 'Add a passkey', exact: true })
      .click();
    await expect(page.getByRole('status')).toContainText('Passkey added');
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
    await client.send('WebAuthn.removeVirtualAuthenticator', {
      authenticatorId,
    });
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
  await openAccount(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await passwordLogin(page);
  await expect(page.getByLabel('Customer name (optional)')).toHaveValue(
    'First user’s draft',
  );
});
