import type { MenuStore } from '../../printer-service/menu-database';
import {
  applyMenuChange,
  CHOICE_CATEGORIES,
  MenuConflict,
  parseMenu,
  type ChoiceCategory,
  type Menu,
  type MenuChange,
} from '../../src/lib/tickets/menu';

/** The menu the migration seeds, which used to be hard-coded. */
export const defaultChoices: Readonly<
  Record<ChoiceCategory, readonly string[]>
> = {
  flavor: ['Chocolate', 'Vanilla', 'Strawberry', 'Chocolate Chip'],
  container: ['Cup', 'Cake Cone', 'Sugar Cone'],
  topping: [
    'Whipped cream',
    'Gummy Bears',
    'Caramel Sauce',
    'Chocolate Sauce',
    'Sliced Almonds',
    'Maraschino Cherries',
    'Rainbow Sprinkles',
    'Chocolate Sprinkles',
  ],
};

export function menuOf(
  choices: Partial<Record<ChoiceCategory, readonly string[]>> = defaultChoices,
  revision = 0,
): Menu {
  return parseMenu({
    revision,
    choices: CHOICE_CATEGORIES.flatMap((category) =>
      (choices[category] ?? []).map((displayName, position) => ({
        id: `${category}-${position}`,
        category,
        position,
        data: { category, displayName },
      })),
    ),
  });
}
export const defaultMenu = menuOf();

/** In-memory menu with the same revision and refusal rules as Postgres. */
export class MemoryMenu implements MenuStore {
  private next = 0;
  constructor(public menu: Menu = defaultMenu) {}
  async load() {
    return this.menu;
  }
  async revision() {
    return this.menu.revision;
  }
  async change(change: MenuChange, revision: number) {
    if (revision !== this.menu.revision) throw new MenuConflict();
    const choices = applyMenuChange(
      this.menu,
      change,
      () => `added-${++this.next}`,
    );
    this.menu = parseMenu({ revision: revision + 1, choices });
    return this.menu;
  }
  /** Test shortcut: replace the menu as an admin would, bumping the revision. */
  set(choices: Partial<Record<ChoiceCategory, readonly string[]>>) {
    this.menu = menuOf(choices, this.menu.revision + 1);
  }
}
