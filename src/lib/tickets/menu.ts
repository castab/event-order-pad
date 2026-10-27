export const CHOICE_CATEGORIES = ['flavor', 'container', 'topping'] as const;
export type ChoiceCategory = (typeof CHOICE_CATEGORIES)[number];
export const maxChoiceName = 40;
export const maxChoiceDescription = 200;
export const maxChoicesPerCategory = 50;

export interface ChoiceData {
  readonly category: ChoiceCategory;
  readonly displayName: string;
  readonly description?: string;
}
export interface MenuChoice {
  readonly id: string;
  readonly category: ChoiceCategory;
  readonly position: number;
  readonly data: ChoiceData;
}
export interface Menu {
  readonly revision: number;
  readonly flavor: readonly MenuChoice[];
  readonly container: readonly MenuChoice[];
  readonly topping: readonly MenuChoice[];
}
export type MenuChange =
  | {
      readonly command: 'add';
      readonly category: ChoiceCategory;
      readonly displayName: string;
      readonly description?: string;
    }
  | {
      readonly command: 'edit';
      readonly id: string;
      readonly displayName: string;
      readonly description?: string;
    }
  | { readonly command: 'remove'; readonly id: string }
  | {
      readonly command: 'move';
      readonly id: string;
      readonly direction: 'up' | 'down';
    };

const controls = /[\p{Cc}\u2028\u2029]/u;
export const categoryLabels: Readonly<
  Record<ChoiceCategory, { one: string; many: string }>
> = Object.freeze({
  flavor: { one: 'flavor', many: 'Flavors' },
  container: { one: 'container', many: 'Containers' },
  topping: { one: 'topping', many: 'Toppings' },
});

export function parseCategory(value: unknown): ChoiceCategory {
  if (!CHOICE_CATEGORIES.includes(value as ChoiceCategory))
    throw new Error('Choose flavor, container or topping.');
  return value as ChoiceCategory;
}

/** A menu name as it is shown, stored on tickets and printed. */
export function parseChoiceName(value: unknown, label = 'Name'): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const clean = value.trim();
  if (
    !clean ||
    Array.from(clean).length > maxChoiceName ||
    controls.test(clean)
  )
    throw new Error(
      `${label} must contain 1–${maxChoiceName} printable characters.`,
    );
  return clean;
}

function parseDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Description must be text.');
  const clean = value.trim();
  if (Array.from(clean).length > maxChoiceDescription || controls.test(clean))
    throw new Error(
      `Description must contain at most ${maxChoiceDescription} printable characters.`,
    );
  return clean || undefined;
}

/** The self-describing jsonb entry; its category must match the row's. */
export function parseChoiceData(
  value: unknown,
  category?: ChoiceCategory,
): ChoiceData {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid menu choice.');
  const raw = value as Record<string, unknown>;
  const kind = parseCategory(raw.category);
  if (category && kind !== category)
    throw new Error('Menu choice category does not match.');
  const description = parseDescription(raw.description);
  return Object.freeze({
    category: kind,
    displayName: parseChoiceName(raw.displayName),
    ...(description && { description }),
  });
}

function parseId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,100}$/.test(value))
    throw new Error('Invalid menu choice ID.');
  return value;
}
function parseRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid menu revision.');
  return value as number;
}

function sameName(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/** Validates `{ revision, choices }` and returns each category frozen in position order. */
export function parseMenu(value: unknown): Menu {
  if (!value || typeof value !== 'object') throw new Error('Invalid menu.');
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.choices)) throw new Error('Invalid menu.');
  const grouped: Record<ChoiceCategory, MenuChoice[]> = {
    flavor: [],
    container: [],
    topping: [],
  };
  const ids = new Set<string>();
  for (const entry of raw.choices as unknown[]) {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid menu.');
    const row = entry as Record<string, unknown>;
    const category = parseCategory(row.category);
    const id = parseId(row.id);
    if (ids.has(id)) throw new Error('Duplicate menu choice ID.');
    ids.add(id);
    if (!Number.isSafeInteger(row.position) || (row.position as number) < 0)
      throw new Error('Invalid menu position.');
    const data = parseChoiceData(row.data, category);
    const list = grouped[category];
    if (list.some((c) => sameName(c.data.displayName, data.displayName)))
      throw new Error(`“${data.displayName}” is on the menu twice.`);
    if (list.length >= maxChoicesPerCategory)
      throw new Error(
        `The menu can hold at most ${maxChoicesPerCategory} choices per category.`,
      );
    list.push(
      Object.freeze({ id, category, position: row.position as number, data }),
    );
  }
  const sorted = (list: MenuChoice[]) =>
    Object.freeze(list.sort((a, b) => a.position - b.position));
  return Object.freeze({
    revision: parseRevision(raw.revision),
    flavor: sorted(grouped.flavor),
    container: sorted(grouped.container),
    topping: sorted(grouped.topping),
  });
}

/** The wire shape for a parsed menu: one flat, position-ordered list. */
export function menuBody(menu: Menu) {
  return {
    revision: menu.revision,
    choices: CHOICE_CATEGORIES.flatMap((category) => menu[category]),
  };
}

export function menuNames(
  menu: Menu,
  category: ChoiceCategory,
): readonly string[] {
  return menu[category].map((c) => c.data.displayName);
}

export function onMenu(
  menu: Menu,
  category: ChoiceCategory,
  name: string,
): boolean {
  return menu[category].some((c) => c.data.displayName === name);
}

/** Validates one admin change; every change names the menu revision it was based on. */
export function parseMenuChange(
  value: unknown,
): MenuChange & { readonly revision: number } {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid menu change.');
  const raw = value as Record<string, unknown>;
  const revision = parseRevision(raw.revision);
  const description = parseDescription(raw.description);
  const named = () => ({
    displayName: parseChoiceName(raw.displayName),
    ...(description && { description }),
  });
  switch (raw.command) {
    case 'add':
      return Object.freeze({
        command: 'add',
        revision,
        category: parseCategory(raw.category),
        ...named(),
      });
    case 'edit':
      return Object.freeze({
        command: 'edit',
        revision,
        id: parseId(raw.id),
        ...named(),
      });
    case 'remove':
      return Object.freeze({
        command: 'remove',
        revision,
        id: parseId(raw.id),
      });
    case 'move':
      if (raw.direction !== 'up' && raw.direction !== 'down')
        throw new Error('Move a choice up or down.');
      return Object.freeze({
        command: 'move',
        revision,
        id: parseId(raw.id),
        direction: raw.direction,
      });
    default:
      throw new Error('Invalid menu change.');
  }
}

/** Applies one change to a menu, in memory; repositories persist the result. */
export function applyMenuChange(
  menu: Menu,
  change: MenuChange,
  id: () => string,
): readonly MenuChoice[] {
  const lists: Record<ChoiceCategory, MenuChoice[]> = {
    flavor: [...menu.flavor],
    container: [...menu.container],
    topping: [...menu.topping],
  };
  const find = (target: string) => {
    for (const category of CHOICE_CATEGORIES) {
      const index = lists[category].findIndex((c) => c.id === target);
      if (index >= 0) return { category, index };
    }
    throw new MenuRefused(
      'That choice is no longer on the menu. Nothing changed.',
    );
  };
  const unique = (category: ChoiceCategory, name: string, except?: string) => {
    if (
      lists[category].some(
        (c) => c.id !== except && sameName(c.data.displayName, name),
      )
    )
      throw new MenuRefused(
        `“${name}” is already a ${categoryLabels[category].one}. Nothing changed.`,
      );
  };
  const data = (
    category: ChoiceCategory,
    change: { displayName: string; description?: string },
  ) =>
    parseChoiceData({
      category,
      displayName: change.displayName,
      description: change.description,
    });
  switch (change.command) {
    case 'add': {
      const list = lists[change.category];
      if (list.length >= maxChoicesPerCategory)
        throw new MenuRefused(
          `The menu already has ${maxChoicesPerCategory} ${categoryLabels[change.category].many.toLowerCase()}. Remove one first. Nothing changed.`,
        );
      unique(change.category, change.displayName);
      list.push({
        id: id(),
        category: change.category,
        position: list.length,
        data: data(change.category, change),
      });
      break;
    }
    case 'edit': {
      const { category, index } = find(change.id);
      unique(category, change.displayName, change.id);
      lists[category][index] = {
        ...lists[category][index],
        data: data(category, change),
      };
      break;
    }
    case 'remove': {
      const { category, index } = find(change.id);
      if (category !== 'topping' && lists[category].length === 1)
        throw new MenuRefused(
          `Keep at least one ${categoryLabels[category].one} so orders can be built. Nothing changed.`,
        );
      lists[category].splice(index, 1);
      break;
    }
    case 'move': {
      const { category, index } = find(change.id);
      const list = lists[category];
      const to = change.direction === 'up' ? index - 1 : index + 1;
      if (to < 0 || to >= list.length)
        throw new MenuRefused(
          `“${list[index].data.displayName}” is already ${change.direction === 'up' ? 'first' : 'last'}. Nothing changed.`,
        );
      [list[index], list[to]] = [list[to], list[index]];
      break;
    }
  }
  return CHOICE_CATEGORIES.flatMap((category) =>
    lists[category].map((c, position) => Object.freeze({ ...c, position })),
  );
}

/** A change the station refused before writing anything; its message says why. */
export class MenuRefused extends Error {}
/** The change was based on a menu revision that is no longer current. */
export class MenuConflict extends Error {
  constructor() {
    super(
      'The menu changed on another device. Nothing changed; review it and try again.',
    );
  }
}
