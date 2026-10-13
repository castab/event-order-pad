import { describe, expect, it } from 'vitest';
import { columnCount, packColumns } from './pack';

describe('queue column count', () => {
  it('steps at 640, 1000 and 1500 pixels', () => {
    expect(
      [0, 390, 639, 640, 999, 1000, 1180, 1499, 1500, 2400].map(columnCount),
    ).toEqual([1, 1, 1, 2, 2, 3, 3, 3, 4, 4]);
  });
});

describe('packColumns', () => {
  it('fills the first row left to right, then the shortest column, leftmost on ties', () => {
    expect(packColumns([100, 100, 100, 100], 3)).toEqual([[0, 3], [1], [2]]);
    expect(packColumns([300, 100, 100, 100, 100], 3)).toEqual([
      [0],
      [1, 3],
      [2, 4],
    ]);
  });

  it('keeps age order inside each column and never leaves a card out', () => {
    const heights = [210, 90, 330, 120, 120, 80, 400, 60, 150];
    const stacks = packColumns(heights, 4);
    expect(stacks.flat().sort((a, b) => a - b)).toEqual(
      heights.map((_, index) => index),
    );
    for (const stack of stacks)
      expect(stack).toEqual([...stack].sort((a, b) => a - b));
  });

  it('puts everything in one column and tolerates no cards', () => {
    expect(packColumns([10, 20, 30], 1)).toEqual([[0, 1, 2]]);
    expect(packColumns([], 3)).toEqual([[], [], []]);
  });

  it('counts the gap, so a 100px card ties with two 40px cards', () => {
    // Column 0 is 100 + 20 = 120 and column 1 is (40 + 20) * 2 = 120, so the
    // last card breaks the tie toward the leftmost column.
    expect(packColumns([100, 40, 40, 10], 2)).toEqual([
      [0, 3],
      [1, 2],
    ]);
  });
});
