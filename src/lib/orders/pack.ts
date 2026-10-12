export const COLUMN_GAP = 20;

/** Queue columns by container width: 1 below 640px, 2 below 1000, 3 below 1500, else 4. */
export function columnCount(width: number): number {
  return width < 640 ? 1 : width < 1000 ? 2 : width < 1500 ? 3 : 4;
}

/**
 * Place cards in order, each into the currently shortest column (leftmost on
 * ties), using their measured heights. Returns the card indexes per column.
 */
export function packColumns(
  heights: readonly number[],
  columns: number,
  gap = COLUMN_GAP,
): number[][] {
  const stacks: number[][] = Array.from(
    { length: Math.max(1, columns) },
    () => [],
  );
  const filled = stacks.map(() => 0);
  heights.forEach((height, index) => {
    let target = 0;
    for (let column = 1; column < stacks.length; column++)
      if (filled[column] < filled[target]) target = column;
    stacks[target].push(index);
    filled[target] += height + gap;
  });
  return stacks;
}
