import { describe, expect, it } from 'vitest';
import {
  parseTrackingEnabled,
  parsePrintMode,
  parseServiceOrigin,
  assertPrintPlatform,
  parseAdminConfig,
} from './config';

it('requires an explicit PDF mode and keeps CUPS Linux-only', () => {
  expect(parsePrintMode(undefined)).toBe('cups');
  expect(parsePrintMode('cups')).toBe('cups');
  expect(parsePrintMode('pdf')).toBe('pdf');
  for (const value of ['', 'PDF', 'false', ' pdf '])
    expect(() => parsePrintMode(value)).toThrow();
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    expect(() => assertPrintPlatform('pdf', platform)).not.toThrow();
    if (platform !== 'linux')
      expect(() => assertPrintPlatform('cups', platform)).toThrow();
  }
});

it('allows only loopback HTTP origins in PDF mode', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    expect(parseServiceOrigin(`http://${host}:4174`, 'pdf').protocol).toBe(
      'http:',
    );
    expect(() => parseServiceOrigin(`http://${host}:4174`, 'cups')).toThrow();
  }
  expect(parseServiceOrigin('https://mint.test', 'cups').origin).toBe(
    'https://mint.test',
  );
  for (const origin of [
    undefined,
    'http://remote.test',
    'http://localhost.evil.test',
    'https://mint.test/path',
    'https://user@mint.test',
    'https://mint.test/?q=1',
  ])
    expect(() => parseServiceOrigin(origin, 'pdf')).toThrow();
});

it.each([
  [undefined, true],
  ['true', true],
  ['false', false],
] as const)('reads the tracking setting %s as %s', (value, enabled) => {
  expect(parseTrackingEnabled(value)).toBe(enabled);
});
it.each(['', 'TRUE', 'False', '0', '1', 'yes', ' false '])(
  'rejects ambiguous tracking setting %s',
  (value) => {
    expect(() => parseTrackingEnabled(value)).toThrow(
      'ORDER_PAD_TRACKING_ENABLED must be true or false.',
    );
  },
);

it('validates database URLs without echoing credentials in errors', async () => {
  const { parseDatabaseUrl } = await import('./config');
  expect(parseDatabaseUrl('postgresql://user:secret@localhost/order_pad')).toBe(
    'postgresql://user:secret@localhost/order_pad',
  );
  for (const url of [
    undefined,
    '',
    'https://host/db',
    'postgresql://host/',
    'postgresql://remote.example/db',
    'postgresql://127.0.0.1/db?host=remote.example',
    'postgresql://127.0.0.1/db?hostaddr=192.0.2.1',
  ])
    expect(() => parseDatabaseUrl(url)).toThrow('DATABASE_URL');
});

it('requires a stable canonical capture cutoff', async () => {
  const { parseCaptureFrom } = await import('./config');
  expect(parseCaptureFrom('2026-10-13T00:00:00.000Z')).toBe(
    '2026-10-13T00:00:00.000Z',
  );
  for (const date of [
    undefined,
    '',
    '2026-10-13',
    '2026-10-13T00:00:00Z',
    '2026-02-30T00:00:00.000Z',
  ])
    expect(() => parseCaptureFrom(date)).toThrow('ORDER_PAD_CAPTURE_FROM');
});

describe('tailnet admin configuration', () => {
  const publicOrigin = new URL('https://orders.example.com');
  const valid = {
    ORDER_PAD_ADMIN_ORIGIN: 'https://station.example.ts.net:8443',
    ORDER_PAD_ADMIN_SOCKET: '/run/order-pad/admin.sock',
    ORDER_PAD_ADMIN_CAPABILITY: 'fionasicecream.com/cap/order-pad-admin',
  };

  it('stays disabled when unset and reads a complete setup', () => {
    expect(parseAdminConfig({}, publicOrigin)).toBeUndefined();
    const config = parseAdminConfig(valid, publicOrigin)!;
    expect(config.origin.host).toBe('station.example.ts.net:8443');
    expect(config.socket).toBe('/run/order-pad/admin.sock');
    expect(config.capability).toBe('fionasicecream.com/cap/order-pad-admin');
    expect(Object.isFrozen(config)).toBe(true);
    const defaultPort = parseAdminConfig(
      {
        ...valid,
        ORDER_PAD_ADMIN_ORIGIN: 'https://station.example.ts.net',
      },
      publicOrigin,
    )!;
    expect(defaultPort.origin.host).toBe('station.example.ts.net');
  });

  it.each(Object.keys(valid))('refuses a partial setup without %s', (key) => {
    expect(() =>
      parseAdminConfig({ ...valid, [key]: undefined }, publicOrigin),
    ).toThrow(key);
  });

  it.each([
    'http://station.example.ts.net:8443',
    'https://orders.example.com:8443',
    'https://station.example.ts.net.evil.test',
    'https://station.example.ts.net:8443/admin',
    'https://user@station.example.ts.net:8443',
    'not a url',
  ])('refuses admin origin %s', (origin) => {
    expect(() =>
      parseAdminConfig(
        { ...valid, ORDER_PAD_ADMIN_ORIGIN: origin },
        publicOrigin,
      ),
    ).toThrow('ORDER_PAD_ADMIN_ORIGIN');
  });

  it('refuses the public origin as the admin origin', () => {
    const tailnet = new URL('https://station.example.ts.net');
    expect(() =>
      parseAdminConfig(
        { ...valid, ORDER_PAD_ADMIN_ORIGIN: tailnet.origin },
        tailnet,
      ),
    ).toThrow('differs from ORDER_PAD_ORIGIN');
  });

  it.each(['admin.sock', './run/admin.sock', '', `/${'a'.repeat(107)}`])(
    'refuses socket path %j',
    (socket) => {
      expect(() =>
        parseAdminConfig(
          { ...valid, ORDER_PAD_ADMIN_SOCKET: socket },
          publicOrigin,
        ),
      ).toThrow('ORDER_PAD_ADMIN_SOCKET');
    },
  );

  it.each([
    '',
    'order-pad-admin',
    'fionasicecream.com',
    'fionasicecream.com/',
    'Fionasicecream.com/cap/admin',
    'fionasicecream.com/cap/order pad',
    'tailscale.com/cap/drive',
    'login.tailscale.com/cap/x',
  ])('refuses capability %j', (capability) => {
    expect(() =>
      parseAdminConfig(
        { ...valid, ORDER_PAD_ADMIN_CAPABILITY: capability },
        publicOrigin,
      ),
    ).toThrow('ORDER_PAD_ADMIN_CAPABILITY');
  });

  it('refuses the retired login allowlist instead of ignoring it', () => {
    for (const env of [
      { ...valid, ORDER_PAD_ADMIN_LOGINS: 'owner@example.com' },
      { ORDER_PAD_ADMIN_LOGINS: 'owner@example.com' },
    ])
      expect(() => parseAdminConfig(env, publicOrigin)).toThrow(
        'ORDER_PAD_ADMIN_LOGINS is no longer used',
      );
  });
});
