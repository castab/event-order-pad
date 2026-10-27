import { describe, expect, it } from 'vitest';
import {
  applyMenuChange,
  menuBody,
  menuNames,
  MenuRefused,
  parseChoiceData,
  parseMenu,
  parseMenuChange,
  type MenuChange,
} from './menu';
import {
  defaultChoices,
  defaultMenu,
  menuOf,
} from '../../../tests/helpers/menu';

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'a1',
  category: 'flavor',
  position: 0,
  data: { category: 'flavor', displayName: 'Mint Chip' },
  ...extra,
});

describe('menu choices', () => {
  it('parses self-describing entries and drops empty descriptions', () => {
    expect(
      parseChoiceData({
        category: 'topping',
        displayName: '  Hot Fudge ',
        description: 'Warm.',
      }),
    ).toEqual({
      category: 'topping',
      displayName: 'Hot Fudge',
      description: 'Warm.',
    });
    const plain = parseChoiceData({
      category: 'flavor',
      displayName: 'Vanilla',
      description: '  ',
    });
    expect(plain).toEqual({ category: 'flavor', displayName: 'Vanilla' });
    expect(Object.isFrozen(plain)).toBe(true);
  });

  it.each([
    [null, 'Invalid'],
    [{ category: 'cone', displayName: 'Waffle' }, 'Choose'],
    [{ category: 'flavor', displayName: '' }, '1–40'],
    [{ category: 'flavor', displayName: 'x'.repeat(41) }, '1–40'],
    [{ category: 'flavor', displayName: 'Mint\nChip' }, '1–40'],
    [{ category: 'flavor', displayName: 3 }, 'text'],
    [
      { category: 'flavor', displayName: 'Mint', description: 'x'.repeat(201) },
      '200',
    ],
  ])('rejects choice data %j', (value, message) => {
    expect(() => parseChoiceData(value)).toThrow(message);
  });

  it('requires the jsonb category to match its row', () => {
    expect(() =>
      parseMenu({ revision: 0, choices: [row({ category: 'topping' })] }),
    ).toThrow('does not match');
  });

  it('groups by category in position order and round-trips the wire shape', () => {
    const menu = parseMenu({
      revision: 4,
      choices: [
        row({
          id: 'b',
          position: 1,
          data: { category: 'flavor', displayName: 'B' },
        }),
        row({
          id: 'a',
          position: 0,
          data: { category: 'flavor', displayName: 'A' },
        }),
        row({
          id: 'c',
          category: 'container',
          data: { category: 'container', displayName: 'Cup' },
        }),
      ],
    });
    expect(menu.revision).toBe(4);
    expect(menuNames(menu, 'flavor')).toEqual(['A', 'B']);
    expect(menuNames(menu, 'topping')).toEqual([]);
    expect(parseMenu(JSON.parse(JSON.stringify(menuBody(menu))))).toEqual(menu);
    expect(Object.isFrozen(menu.flavor)).toBe(true);
  });

  it.each([
    [{ revision: -1, choices: [] }, 'revision'],
    [{ revision: 0 }, 'Invalid menu'],
    [{ revision: 0, choices: [row(), row()] }, 'Duplicate'],
    [
      {
        revision: 0,
        choices: [
          row(),
          row({
            id: 'a2',
            data: { category: 'flavor', displayName: 'MINT CHIP' },
          }),
        ],
      },
      'twice',
    ],
    [{ revision: 0, choices: [row({ id: 'no spaces!' })] }, 'ID'],
    [{ revision: 0, choices: [row({ position: -1 })] }, 'position'],
  ])('rejects menu %j', (value, message) => {
    expect(() => parseMenu(value)).toThrow(message);
  });

  it('validates admin changes before anything is written', () => {
    expect(
      parseMenuChange({
        command: 'add',
        revision: 2,
        category: 'topping',
        displayName: ' Hot Fudge ',
        description: '',
      }),
    ).toEqual({
      command: 'add',
      revision: 2,
      category: 'topping',
      displayName: 'Hot Fudge',
    });
    for (const bad of [
      { command: 'add', revision: 0, category: 'cone', displayName: 'X' },
      { command: 'edit', revision: 0, id: 'a1', displayName: '' },
      { command: 'move', revision: 0, id: 'a1', direction: 'left' },
      { command: 'remove', revision: '0', id: 'a1' },
      { command: 'drop', revision: 0 },
      null,
    ])
      expect(() => parseMenuChange(bad)).toThrow();
  });

  describe('applying changes', () => {
    const apply = (change: MenuChange, menu = defaultMenu) =>
      parseMenu({
        revision: menu.revision + 1,
        choices: applyMenuChange(menu, change, () => 'new-id'),
      });

    it('adds to the end, edits in place and renumbers after removal', () => {
      const added = apply({
        command: 'add',
        category: 'flavor',
        displayName: 'Mint Chip',
        description: 'Cool.',
      });
      expect(menuNames(added, 'flavor')).toEqual([
        ...defaultChoices.flavor,
        'Mint Chip',
      ]);
      expect(added.flavor.at(-1)).toMatchObject({ id: 'new-id', position: 4 });
      const edited = apply(
        { command: 'edit', id: 'flavor-1', displayName: 'French Vanilla' },
        added,
      );
      expect(menuNames(edited, 'flavor')[1]).toBe('French Vanilla');
      const removed = apply({ command: 'remove', id: 'flavor-0' }, edited);
      expect(removed.flavor.map((c) => c.position)).toEqual([0, 1, 2, 3]);
      expect(menuNames(removed, 'flavor')[0]).toBe('French Vanilla');
    });

    it('moves a choice one place and refuses moving past either end', () => {
      const moved = apply({
        command: 'move',
        id: 'topping-1',
        direction: 'up',
      });
      expect(menuNames(moved, 'topping').slice(0, 2)).toEqual([
        'Gummy Bears',
        'Whipped cream',
      ]);
      expect(() =>
        apply({ command: 'move', id: 'topping-0', direction: 'up' }),
      ).toThrow('already first');
      expect(() =>
        apply({ command: 'move', id: 'container-2', direction: 'down' }),
      ).toThrow('already last');
    });

    it('refuses duplicates, missing choices and removing the last flavor or container', () => {
      expect(() =>
        apply({ command: 'add', category: 'flavor', displayName: 'vanilla' }),
      ).toThrow(MenuRefused);
      expect(() =>
        apply({ command: 'edit', id: 'flavor-0', displayName: 'Vanilla' }),
      ).toThrow('already a flavor');
      expect(
        menuNames(
          apply({ command: 'edit', id: 'flavor-1', displayName: 'VANILLA' }),
          'flavor',
        )[1],
      ).toBe('VANILLA');
      expect(() => apply({ command: 'remove', id: 'gone' })).toThrow(
        'no longer on the menu',
      );
      const lean = menuOf({
        flavor: ['Vanilla'],
        container: ['Cup'],
        topping: ['Fudge'],
      });
      expect(() => apply({ command: 'remove', id: 'flavor-0' }, lean)).toThrow(
        'at least one flavor',
      );
      expect(() =>
        apply({ command: 'remove', id: 'container-0' }, lean),
      ).toThrow('at least one container');
      expect(
        apply({ command: 'remove', id: 'topping-0' }, lean).topping,
      ).toEqual([]);
    });
  });
});
