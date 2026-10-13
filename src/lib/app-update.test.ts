import { describe, expect, it } from 'vitest';
import {
  idleAfterInputMs,
  settleAfterLoadMs,
  shouldApplyUpdate,
} from './app-update';

const base = {
  held: false,
  hidden: false,
  msSinceLoad: settleAfterLoadMs + 1,
  msSinceInput: 1000,
};

describe('shouldApplyUpdate', () => {
  it('never applies while work is held', () => {
    expect(
      shouldApplyUpdate({
        ...base,
        held: true,
        hidden: true,
        msSinceLoad: 0,
        msSinceInput: idleAfterInputMs,
      }),
    ).toBe(false);
  });

  it('waits while the user is actively using a loaded page', () => {
    expect(shouldApplyUpdate(base)).toBe(false);
  });

  it('applies when hidden, freshly loaded, or idle', () => {
    expect(shouldApplyUpdate({ ...base, hidden: true })).toBe(true);
    expect(shouldApplyUpdate({ ...base, msSinceLoad: 0 })).toBe(true);
    expect(shouldApplyUpdate({ ...base, msSinceInput: idleAfterInputMs })).toBe(
      true,
    );
  });
});
