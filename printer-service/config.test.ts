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
