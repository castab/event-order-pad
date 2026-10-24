import { test as base, expect, type Page } from '@playwright/test';
import { createAdminApp } from '../printer-service/admin-http';
import {
  AccessRefused,
  type AccessStatus,
  type MintedCode,
} from '../printer-service/access-admin';

const capability = 'fionasicecream.com/cap/order-pad-admin';
const granted = JSON.stringify({ [capability]: [{}] });
const codes = [
  'K7QM4XTD9A',
  'B3NR8PWX2C',
  'HJ5TZ7Q9MV',
  'D2F4G6H8JK',
  'M3P5R7T9VX',
];

type Admin = {
  url: string;
  mints: number[];
  revokes: unknown[];
  posts: () => number;
  hold: () => () => void;
  failSlip: () => void;
  slips: string[];
  refuseMint: (message: string) => void;
  dropReplies: (count: number) => void;
};
// The production listener is a Unix socket behind Tailscale Serve; the browser
// test serves the same app on loopback TCP and supplies Serve's capability header.
const test = base.extend<{ admin: Admin }>({
  admin: async ({}, use) => {
    const origin = new URL('http://127.0.0.1');
    const mints: number[] = [];
    const revokes: unknown[] = [];
    const slips: string[] = [];
    let posts = 0;
    let gate: Promise<void> | undefined;
    let slipFails = false;
    let refusal = '';
    let dropReplies = 0;
    let unused: AccessStatus['unused'][number][] = [];
    let devices: AccessStatus['devices'][number][] = [
      {
        id: 'device-1',
        device: 'Safari on iPad',
        signedInAt: new Date(Date.now() - 3600000),
        expiresAt: new Date(Date.now() + 7 * 3600000),
      },
    ];
    let next = 0;
    const server = createAdminApp({
      origin,
      capability,
      assets: 'static',
      access: {
        status: async () => ({ unused: [...unused], devices: [...devices] }),
        mint: async (count) => {
          mints.push(count);
          await gate;
          if (refusal) throw new AccessRefused(refusal);
          const redeemBy = new Date(Date.now() + 3600000);
          const minted: MintedCode[] = Array.from({ length: count }, () => {
            const id = `code-${next}`;
            return { id, code: codes[next++ % codes.length], redeemBy };
          });
          unused.push(
            ...minted.map((m) => ({
              id: m.id,
              createdAt: new Date(),
              redeemBy,
            })),
          );
          return minted;
        },
        revoke: async (target) => {
          revokes.push(target);
          await gate;
          const hit = (id: string) => target === 'all' || target.id === id;
          const voided = unused.filter((c) => hit(c.id)).length;
          const signedOut = devices.filter((d) => hit(d.id)).length;
          unused = unused.filter((c) => !hit(c.id));
          devices = devices.filter((d) => !hit(d.id));
          return target !== 'all' && !voided && !signedOut
            ? { kind: 'gone' }
            : { kind: 'revoked', voided, signedOut };
        },
      },
      slip: async (code) => {
        slips.push(code);
        if (slipFails) throw new Error('Queue paused.');
        return `Star_TSP143-${code}`;
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
      mints,
      revokes,
      slips,
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
      refuseMint: (message) => (refusal = message),
      dropReplies: (count) => (dropReplies = count),
    });
    await new Promise((resolve) => server.close(resolve));
  },
});
test.beforeEach(async ({ page }) => {
  await page.setExtraHTTPHeaders({ 'Tailscale-App-Capabilities': granted });
});

const count = (page: Page) =>
  page.getByRole('textbox', {
    name: 'How many access codes would you like to mint?',
  });
const newCodes = (page: Page) =>
  page.getByRole('region', { name: 'New access codes' });
async function mint(page: Page, n: number) {
  await count(page).fill(String(n));
  await page
    .getByRole('button', { name: `Mint ${n} code${n === 1 ? '' : 's'}` })
    .click();
}

test('caps the count at 5, mints that many once and shows every code', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  await expect(
    page.getByRole('heading', { name: 'Mint access codes' }),
  ).toBeVisible();
  await expect(count(page)).toHaveValue('1');
  await expect(page.getByRole('button', { name: 'Mint 1 code' })).toBeEnabled();
  await count(page).fill('9');
  await expect(count(page)).toHaveValue('5');
  await expect(
    page.getByRole('button', { name: 'Mint 5 codes' }),
  ).toBeVisible();
  await count(page).fill('');
  await expect(page.getByRole('button', { name: 'Mint codes' })).toBeDisabled();
  await count(page).fill('x');
  await expect(count(page)).toHaveValue('');
  await count(page).fill('0');
  await expect(count(page)).toHaveValue('1');
  expect(admin.posts()).toBe(0);

  const release = admin.hold();
  await mint(page, 3);
  await expect(page.locator('#badge')).toHaveText('Minting');
  await expect(page.getByRole('button', { name: 'Minting…' })).toBeDisabled();
  await expect(count(page)).toBeDisabled();
  release();
  const shown = newCodes(page);
  for (const code of ['K7QM4-XTD9A', 'B3NR8-PWX2C', 'HJ5TZ-7Q9MV'])
    await expect(shown.getByText(code)).toBeVisible();
  await expect(shown.getByRole('listitem')).toHaveCount(3);
  await expect(
    shown.getByText('Slip submitted to the printer (Star_TSP143-K7QM4XTD9A).'),
  ).toBeVisible();
  await expect(shown.getByText(/^Use by /)).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: 'Copy code B3NR8-PWX2C' }),
  ).toBeVisible();
  expect(admin.posts()).toBe(1);
  expect(admin.mints).toEqual([3]);
  await expect(page.locator('#unused-count')).toHaveText('3');
  await expect(page.locator('#unused').getByRole('listitem')).toHaveCount(3);
  await expect(page.locator('#badge')).toHaveText('1 device signed in');

  await page.getByRole('button', { name: 'Hide codes' }).click();
  await expect(page.getByText('K7QM4-XTD9A')).toHaveCount(0);
});

test('shows the codes without printing slips when the option is off', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  const option = page.getByRole('checkbox', {
    name: 'Print a slip for each code',
  });
  await expect(option).toBeChecked();
  await option.uncheck();
  await mint(page, 2);
  const shown = newCodes(page);
  await expect(shown.getByText('K7QM4-XTD9A')).toBeVisible();
  await expect(shown.getByText('B3NR8-PWX2C')).toBeVisible();
  await expect(shown.getByText('No slip printed, as you chose.')).toHaveCount(
    2,
  );
  await expect(shown.getByText(/Slip submitted/)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(admin.mints).toEqual([2]);
  expect(admin.slips).toEqual([]);
});

test('prints slips by default', async ({ page, admin }) => {
  await page.goto(admin.url);
  await mint(page, 1);
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  expect(admin.slips).toEqual(['K7QM4XTD9A']);
});

test('keeps every valid code visible when a slip fails', async ({
  page,
  admin,
}) => {
  admin.failSlip();
  await page.goto(admin.url);
  await mint(page, 2);
  await expect(page.getByText('K7QM4-XTD9A')).toBeVisible();
  await expect(page.getByText('B3NR8-PWX2C')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText([
    'The slip didn’t print: Queue paused. This code still works, so write it down for staff.',
    'Not printed, because an earlier slip failed. This code still works, so write it down for staff.',
  ]);
});

test('shows a refusal that minted nothing', async ({ page, admin }) => {
  admin.refuseMint(
    '9 unused codes are still out, and at most 10 can be. Void some or let them expire first. Nothing was minted.',
  );
  await page.goto(admin.url);
  await mint(page, 2);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Check before trying again');
  await expect(alert).toContainText('Nothing was minted.');
  await expect(newCodes(page)).toBeHidden();
});

// Chromium transparently resends a POST whose reused connection closed before
// any reply bytes; the request ID makes the station refuse that resend.
test('refuses a browser resend of a mint', async ({ page, admin }) => {
  await page.goto(admin.url);
  admin.dropReplies(1);
  await mint(page, 2);
  await expect(page.getByRole('alert')).toContainText(
    'The station already received this request, so it wasn’t repeated. Check the printer and the lists before trying again.',
  );
  expect(admin.posts()).toBe(2);
  expect(admin.mints).toEqual([2]);
});

test('reports a lost reply as possibly minted and never retries', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  admin.dropReplies(Infinity);
  await mint(page, 1);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('The station didn’t answer');
  await expect(alert).toContainText(
    'Some codes may already be valid. Nothing was retried. Check the printer and the unused codes before minting again.',
  );
  const posts = admin.posts();
  await page.waitForTimeout(500);
  expect(admin.posts()).toBe(posts);
  expect(admin.mints).toEqual([1]);
  await alert.getByRole('button', { name: 'Check status' }).click();
  await expect(alert).toBeHidden();
  await expect(page.locator('#unused-count')).toHaveText('1');
});

test('voids an unused code and signs out a device only after confirming', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  await mint(page, 2);
  await expect(page.locator('#unused-count')).toHaveText('2');
  const unused = page.locator('#unused');
  await unused
    .getByRole('listitem')
    .first()
    .getByRole('button', { name: /^Void/ })
    .click();
  const voiding = page.getByRole('dialog', { name: 'Void this code?' });
  await expect(voiding).toContainText('Throw its slip away.');
  await voiding.getByRole('button', { name: 'Cancel' }).click();
  expect(admin.revokes).toEqual([]);
  await unused
    .getByRole('listitem')
    .first()
    .getByRole('button', { name: /^Void/ })
    .click();
  await voiding.getByRole('button', { name: 'Void code' }).click();
  await expect(page.getByText('Voided 1 unused code.')).toBeVisible();
  await expect(page.locator('#unused-count')).toHaveText('1');
  expect(admin.revokes).toEqual([{ id: 'code-0' }]);

  await page.getByRole('button', { name: 'Sign out: Safari on iPad' }).click();
  const signingOut = page.getByRole('dialog', {
    name: 'Sign out this device?',
  });
  await expect(signingOut).toContainText('Safari on iPad');
  await signingOut.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out 1 device.')).toBeVisible();
  await expect(page.getByText('No devices are signed in.')).toBeVisible();
  await expect(page.locator('#badge')).toHaveText('0 devices signed in');
  expect(admin.revokes).toEqual([{ id: 'code-0' }, { id: 'device-1' }]);
});

test('signs out everyone after confirming what it ends', async ({
  page,
  admin,
}) => {
  await page.goto(admin.url);
  await mint(page, 1);
  await expect(page.locator('#unused-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Sign out everyone' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign out everyone?' });
  await expect(dialog).toContainText(
    '1 unused code will be voided and 1 device signed out.',
  );
  await dialog.getByRole('button', { name: 'Sign out everyone' }).click();
  await expect(
    page.getByText('Voided 1 unused code. Signed out 1 device.'),
  ).toBeVisible();
  await expect(
    page.getByText('No unused codes.', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Sign out everyone' }),
  ).toBeHidden();
  expect(admin.revokes).toEqual(['all']);
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
    await expect(page.locator('#unused-count')).toHaveText('None');
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
    for (const target of [
      count(page),
      page.getByRole('button', { name: 'Mint 1 code' }),
      page.getByRole('button', { name: 'Sign out: Safari on iPad' }),
    ])
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});

test('refuses devices the tailnet policy has not granted', async ({
  page,
  admin,
}) => {
  await page.setExtraHTTPHeaders({});
  const response = await page.goto(admin.url);
  expect(response?.status()).toBe(403);
  await expect(page.getByText('How many access codes')).toHaveCount(0);
});
