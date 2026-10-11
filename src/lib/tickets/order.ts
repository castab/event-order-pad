import { parseTicket, type OrderTicket } from './ticket';

export const flavors = [
  'Chocolate',
  'Vanilla',
  'Strawberry',
  'Chocolate Chip',
] as const;
export const containers = ['Cup', 'Cake Cone', 'Sugar Cone'] as const;
export const toppings = [
  'Whipped cream',
  'Gummy Bears',
  'Caramel Sauce',
  'Chocolate Sauce',
  'Sliced Almonds',
  'Maraschino Cherries',
] as const;
export type Flavor = (typeof flavors)[number];
export type Container = (typeof containers)[number];
export type Topping = (typeof toppings)[number];
export interface Serving {
  readonly flavor: Flavor;
  readonly container: Container;
  readonly toppings: readonly Topping[];
}
export interface ServingEditor {
  readonly flavor: Flavor | '';
  readonly container: Container | '';
  readonly toppings: readonly Topping[];
}
export interface OrderDraft {
  readonly name: string;
  readonly reference: string;
  readonly servings: readonly Serving[];
  readonly editor: ServingEditor;
  readonly editingIndex?: number;
  readonly submittedTicketId?: string;
}

export function emptyEditor(): ServingEditor {
  return { flavor: '', container: '', toppings: [] };
}

export function hasPendingServing(draft: OrderDraft): boolean {
  return (
    draft.editingIndex !== undefined ||
    !!draft.editor.flavor ||
    !!draft.editor.container ||
    draft.editor.toppings.length > 0
  );
}

/** Commit exactly one complete serving, replacing it when editing. */
export function commitServing(draft: OrderDraft): OrderDraft {
  const valid = parseDraft(draft);
  if (valid.submittedTicketId)
    throw new Error('This order is already submitted.');
  if (!valid.editor.flavor || !valid.editor.container)
    throw new Error('Choose a flavor and container for the current serving.');
  const servings = [...valid.servings];
  const serving = valid.editor as Serving;
  if (valid.editingIndex !== undefined) servings[valid.editingIndex] = serving;
  else {
    if (servings.length >= 30)
      throw new Error(
        'An order can contain at most 30 servings. Cancel the current serving to print this order.',
      );
    servings.push(serving);
  }
  return parseDraft({
    ...valid,
    servings,
    editor: emptyEditor(),
    editingIndex: undefined,
  });
}

/** Printing and preview use the same prospective order without changing the editor. */
export function prepareDraftForPrint(draft: OrderDraft): OrderDraft {
  const valid = parseDraft(draft);
  const prepared = hasPendingServing(valid) ? commitServing(valid) : valid;
  if (!prepared.servings.length)
    throw new Error('Choose a flavor and container to start your order.');
  return prepared;
}

const firstWords = [
  'Sundae',
  'Gelato',
  'Sorbet',
  'Waffle',
  'Fudge',
  'Caramel',
  'Vanilla',
  'Cocoa',
];
const secondWords = [
  'Sprinkle',
  'Scoop',
  'Swirl',
  'Cone',
  'Float',
  'Ripple',
  'Cherry',
  'Crunch',
];
export function newDraft(
  previousReference?: string,
  random = () => crypto.getRandomValues(new Uint32Array(1))[0],
): OrderDraft {
  const labels = firstWords
    .flatMap((first) => secondWords.map((second) => `${first} ${second}`))
    .filter((label) => label !== previousReference);
  return {
    name: '',
    reference: labels[random() % labels.length],
    servings: [],
    editor: emptyEditor(),
  };
}

/** Drafts may have an incomplete editor, but committed servings are complete. */
export function parseDraft(value: unknown): OrderDraft {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid order draft.');
  const v = value as OrderDraft;
  if (
    typeof v.name !== 'string' ||
    v.name.length > 80 ||
    /[\x00-\x1f\x7f]/.test(v.name)
  )
    throw new Error('Name must contain at most 80 printable characters.');
  if (
    !firstWords.some((first) =>
      secondWords.some((second) => v.reference === `${first} ${second}`),
    )
  )
    throw new Error('Invalid generated order label.');
  const parseServing = (
    raw: ServingEditor,
    partial: boolean,
  ): ServingEditor => {
    if (
      !raw ||
      (!flavors.includes(raw.flavor as Flavor) &&
        !(partial && raw.flavor === '')) ||
      (!containers.includes(raw.container as Container) &&
        !(partial && raw.container === ''))
    )
      throw new Error('Choose a flavor and container.');
    if (
      !Array.isArray(raw.toppings) ||
      raw.toppings.some((t) => !toppings.includes(t)) ||
      new Set(raw.toppings).size !== raw.toppings.length
    )
      throw new Error('Invalid toppings.');
    return Object.freeze({
      flavor: raw.flavor,
      container: raw.container,
      toppings: Object.freeze(toppings.filter((t) => raw.toppings.includes(t))),
    });
  };
  if (!Array.isArray(v.servings) || v.servings.length > 30)
    throw new Error('An order can contain at most 30 servings.');
  if (
    v.editingIndex !== undefined &&
    (!Number.isInteger(v.editingIndex) ||
      v.editingIndex < 0 ||
      v.editingIndex >= v.servings.length)
  )
    throw new Error('Invalid serving being edited.');
  if (
    v.submittedTicketId !== undefined &&
    (typeof v.submittedTicketId !== 'string' ||
      !v.submittedTicketId ||
      v.submittedTicketId.length > 100)
  )
    throw new Error('Invalid submitted ticket.');
  return Object.freeze({
    name: v.name,
    reference: v.reference,
    servings: Object.freeze(
      v.servings.map((s) => parseServing(s, false) as Serving),
    ),
    editor: parseServing(v.editor, true),
    editingIndex: v.editingIndex,
    submittedTicketId: v.submittedTicketId,
  });
}

export function draftTicket(
  draft: OrderDraft,
  id: string,
  createdAt: string,
): OrderTicket {
  const valid = parseDraft(draft);
  if (
    valid.editingIndex !== undefined ||
    valid.editor.flavor ||
    valid.editor.container ||
    valid.editor.toppings.length
  )
    throw new Error('Add or cancel the serving before printing.');
  return parseTicket({
    id,
    createdAt,
    reference: valid.name.trim() || valid.reference,
    items: valid.servings.map((s) => ({
      name: `${s.flavor} ice cream`,
      quantity: 1,
      modifiers: [
        s.container,
        ...(s.toppings.length ? s.toppings : ['No toppings']),
      ],
    })),
  });
}
