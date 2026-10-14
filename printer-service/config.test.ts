import { expect, it } from 'vitest';
import {
  parseTrackingEnabled,
  parsePrintMode,
  parseServiceOrigin,
  assertPrintPlatform,
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
