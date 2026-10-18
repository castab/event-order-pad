import { test as base, expect, type Page } from '@playwright/test';
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
      assets: 'static',
      access: async (command): Promise<AccessResult> => {
        commands.push(command);
        if (command === 'status')
          return active
            ? { kind: 'status', expiresAt, sessions: 3 }
            : { kind: 'status', sessions: 0 };
        await gate;
        if (command === 'revoke') {
          const revoked = active;
          active = false;
          return { kind: 'revoked', revoked, signedOut: revoked ? 3 : 0 };
        }
        const signedOut = active ? 3 : 0;
        active = true;
        return { kind: 'minted', code: 'K7QM4XTD9A', expiresAt, signedOut };
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

const heading = (page: Page) => page.locator('#status-title');
async function mint(page: Page, confirm = 'Mint code') {
  await page.getByRole('button', { name: 'Mint a code' }).click();
  await page.getByRole('dialog').getByRole('button', { name: confirm }).click();
}

test('confirms before minting once, shows the code and can hide it', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  await expect(heading(page)).toHaveText('No code is active');
  await expect(page.locator('#badge')).toHaveText('No code');
  await expect(page.getByRole('button', { name: 'Revoke code' })).toBeHidden();
  await page.getByRole('button', { name: 'Mint a code' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mint an access code?' });
  await expect(dialog).toContainText('prints a slip for staff');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect(admin.posts()).toBe(0);

  const release = admin.hold();
  await mint(page);
  await expect(heading(page)).toHaveText('Minting a new code…');
  await expect(page.locator('#badge')).toHaveText('Minting');
  for (const name of ['Mint a code', 'Check again'])
    await expect(page.getByRole('button', { name })).toBeDisabled();
  release();
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  await expect(page.getByText('(8 hours).')).toBeVisible();
  await expect(
    page.getByText('Slip submitted to the printer (Star_TSP143-9).'),
  ).toBeVisible();
  await expect(heading(page)).toContainText('Code works until');
  await expect(page.locator('#badge')).toHaveText('Active');
  await expect(page.locator('#devices')).toHaveText('3 devices');
  await expect(
    page.getByRole('button', { name: 'Replace code', exact: true }),
  ).toBeEnabled();
  expect(admin.posts()).toBe(1);
  expect(admin.commands.filter((c) => c === 'mint')).toHaveLength(1);

  await page.getByRole('button', { name: 'Hide code' }).click();
  await expect(page.getByText('K7QM4-XTD9A')).toHaveCount(0);
});

test('replacing a code names the devices it signs out', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  await mint(page);
  await expect(page.locator('#devices')).toHaveText('3 devices');
  await page.getByRole('button', { name: 'Replace code', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Replace the access code?' });
  await expect(dialog).toContainText(
    '3 devices signed in now will be signed out.',
  );
  await dialog.getByRole('button', { name: 'Replace code' }).click();
  await expect(
    page.getByText(
      'The old code stopped working and 3 devices signed in with it were signed out.',
    ),
  ).toBeVisible();
  expect(admin.commands.filter((c) => c === 'mint')).toHaveLength(2);
});

test('keeps the valid code visible when the slip fails', async ({
  page,
  admin,
}) => {
  admin.failSlip();
  await page.goto(admin.url);
  await mint(page);
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(
    'The slip didn’t print: Queue paused. The code above still works, so write it down for staff.',
  );
});

// Chromium transparently resends a POST whose reused connection closed before
// any reply bytes; the request ID makes the station refuse that resend.
test('refuses a browser resend of a confirmed mint', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  admin.dropReplies(1);
  await mint(page);
  await expect(page.getByRole('alert')).toContainText(
    'The station already received this request, so it wasn’t repeated. A new code may already be valid; check the slip or reload status before trying again.',
  );
  expect(admin.posts()).toBe(2);
  expect(admin.commands.filter((c) => c === 'mint')).toHaveLength(1);
});

test('reports a lost reply as possibly minted and never retries', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  admin.dropReplies(Infinity);
  await mint(page);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The station didn’t answer');
  await expect(alert).toContainText(
    'A new code may already be valid. Nothing was retried. Check the printer for a slip and check status before minting again.',
  );
  const posts = admin.posts();
  await page.waitForTimeout(500);
  expect(admin.posts()).toBe(posts);
  expect(admin.commands.filter((c) => c === 'mint')).toHaveLength(1);
  await alert.getByRole('button', { name: 'Check status' }).click();
  await expect(alert).toBeHidden();
  await expect(heading(page)).toContainText('Code works until');
});

test('revokes after confirmation', async ({ page, admin }) => {
  await page.goto(admin.url);
  await mint(page);
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  await page.getByRole('button', { name: 'Revoke code' }).click();
  await page
    .getByRole('dialog', { name: 'Revoke the access code?' })
    .getByRole('button', { name: 'Revoke and sign out' })
    .click();
  await expect(
    page.getByText(
      'Code revoked. 3 devices signed out. Nobody can sign in until you mint a new code.',
    ),
  ).toBeVisible();
  await expect(page.getByText('K7QM4-XTD9A')).toHaveCount(0);
  await expect(heading(page)).toHaveText('No code is active');
});

test('shows the station header and lays out at phone and laptop widths', async ({
  page,
  admin,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(admin.url);
    await expect(heading(page)).toHaveText('No code is active');
    await expect(
      page.getByRole('heading', { name: 'Access codes', level: 1 }),
    ).toBeVisible();
    expect(
      await page
        .getByRole('img', { name: 'Fiona’s Ice Cream' })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    ).toBeGreaterThan(0);
    await expect(page.getByText(new URL(admin.url).host)).toBeVisible({
      visible: viewport.width >= 640,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    const button = page.getByRole('button', { name: 'Mint a code' });
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test('refuses devices the tailnet policy has not granted', async ({
  page,
  admin,
}) => {
  await page.setExtraHTTPHeaders({});
  const response = await page.goto(admin.url);
  expect(response?.status()).toBe(403);
  await expect(page.getByText('Mint a code')).toHaveCount(0);
});
