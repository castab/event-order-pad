import { test as base, expect } from '@playwright/test';
import { createAdminApp } from '../printer-service/admin-http';
import type { AccessResult } from '../printer-service/access-admin';

const capability = 'fionasicecream.com/cap/order-pad-admin';
const granted = JSON.stringify({ [capability]: [{}] });
const expiresAt = new Date('2026-10-18T23:00:00.000Z');

type Admin = {
  url: string;
  commands: string[];
  posts: () => number;
  hold: () => () => void;
  failSlip: () => void;
  dropReplies: (count: number) => void;
};
// The production listener is a Unix socket behind Tailscale Serve; the browser
// test serves the same app on loopback TCP and supplies Serve's capability header.
const test = base.extend<{ admin: Admin }>({
  admin: async ({}, use) => {
    const origin = new URL('http://127.0.0.1');
    const commands: string[] = [];
    let posts = 0;
    let gate: Promise<void> | undefined;
    let slipFails = false;
    let dropReplies = 0;
    let active = false;
    const server = createAdminApp({
      origin,
      capability,
      access: async (command): Promise<AccessResult> => {
        commands.push(command);
        if (command === 'status')
          return active
            ? { kind: 'status', expiresAt, sessions: 1 }
            : { kind: 'status', sessions: 0 };
        await gate;
        if (command === 'revoke') {
          const revoked = active;
          active = false;
          return { kind: 'revoked', revoked };
        }
        active = true;
        return { kind: 'minted', code: 'K7QM4XTD9A', expiresAt };
      },
      slip: async () => {
        if (slipFails) throw new Error('Queue paused.');
        return 'Star_TSP143-9';
      },
      log: () => {},
    });
    server.prependListener('request', (req) => {
      if (req.method !== 'POST') return;
      posts++;
      if (dropReplies > 0) {
        dropReplies--;
        req.socket.destroy();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    origin.port = String((server.address() as { port: number }).port);
    await use({
      url: origin.origin + '/',
      commands,
      posts: () => posts,
      hold: () => {
        let release!: () => void;
        gate = new Promise((resolve) => (release = resolve));
        return () => {
          release();
          gate = undefined;
        };
      },
      failSlip: () => (slipFails = true),
      dropReplies: (count) => (dropReplies = count),
    });
    await new Promise((resolve) => server.close(resolve));
  },
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Tailscale-App-Capabilities': granted });
});

test('confirms before minting once, shows the code and can hide it', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  await expect(page.getByRole('status')).toHaveText(
    'No access code is active.',
  );
  await page.getByRole('button', { name: 'Mint new code' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mint a new code?' });
  await expect(dialog).toContainText('signs out every staff device');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(admin.posts()).toBe(0);

  const release = admin.hold();
  await page.getByRole('button', { name: 'Mint new code' }).click();
  await dialog
    .getByRole('button', { name: 'Mint and sign out devices' })
    .click();
  await expect(page.getByText('Minting…')).toBeVisible();
  for (const name of ['Mint new code', 'Revoke code', 'Refresh status'])
    await expect(page.getByRole('button', { name })).toBeDisabled();
  release();
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  await expect(
    page.getByText('Slip submitted to the printer (Star_TSP143-9).'),
  ).toBeVisible();
  await expect(page.getByRole('status')).toContainText(
    'Access code active until',
  );
  await expect(page.getByRole('status')).toContainText('1 signed-in device');
  expect(admin.posts()).toBe(1);
  expect(admin.commands.filter((c) => c === 'mint')).toHaveLength(1);

  await page.getByRole('button', { name: 'Hide code' }).click();
  await expect(page.getByText('K7QM4-XTD9A')).toHaveCount(0);
});

test('keeps the valid code visible when the slip fails', async ({
  page,
  admin,
}) => {
  admin.failSlip();
  await page.goto(admin.url);
  await page.getByRole('button', { name: 'Mint new code' }).click();
  await page.getByRole('button', { name: 'Mint and sign out devices' }).click();
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  await expect(
    page.getByText(
      'The slip did not print: Queue paused. The code above is valid; write it down for staff.',
    ),
  ).toBeVisible();
});

// Chromium transparently resends a POST whose reused connection closed before
// any reply bytes; the request ID makes the station refuse that resend.
test('refuses a browser resend of a confirmed mint', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  admin.dropReplies(1);
  await page.getByRole('button', { name: 'Mint new code' }).click();
  await page.getByRole('button', { name: 'Mint and sign out devices' }).click();
  await expect(
    page.getByText(
      'The station already received this request, so it wasn’t repeated. A new code may already be valid; check the slip or reload status before trying again.',
    ),
  ).toBeVisible();
  expect(admin.posts()).toBe(2);
  expect(admin.commands.filter((c) => c === 'mint')).toHaveLength(1);
});

test('reports a lost reply as possibly minted and never retries', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  admin.dropReplies(Infinity);
  await page.getByRole('button', { name: 'Mint new code' }).click();
  await page.getByRole('button', { name: 'Mint and sign out devices' }).click();
  await expect(
    page.getByText(
      'The station didn’t answer. A new code may already be valid, so check the slip or reload status before minting again. Nothing was retried.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Mint new code' }),
  ).toBeEnabled();
  const posts = admin.posts();
  await page.waitForTimeout(500);
  expect(admin.posts()).toBe(posts);
  expect(admin.commands.filter((c) => c === 'mint')).toHaveLength(1);
});

test('revokes after confirmation', async ({ page, admin }) => {
  await page.goto(admin.url);
  await page.getByRole('button', { name: 'Mint new code' }).click();
  await page.getByRole('button', { name: 'Mint and sign out devices' }).click();
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke code' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke the access code?' })
    .getByRole('button', { name: 'Revoke and sign out devices' })
    .click();
  await expect(
    page.getByText(
      'The access code is void and every device signed in with it has been signed out.',
    ),
  ).toBeVisible();
  await expect(page.getByText('K7QM4-XTD9A')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText(
    'No access code is active.',
  );
});

test('refuses devices the tailnet policy has not granted', async ({
  page,
  admin,
}) => {
  await page.setExtraHTTPHeaders({});
  const response = await page.goto(admin.url);
  expect(response?.status()).toBe(403);
  await expect(page.getByText('Mint new code')).toHaveCount(0);
});
