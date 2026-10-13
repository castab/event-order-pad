import { expect, it } from 'vitest';
import { parseTrackingEnabled } from './config';

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
  for (const url of [undefined, '', 'https://host/db', 'postgresql://host/'])
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
