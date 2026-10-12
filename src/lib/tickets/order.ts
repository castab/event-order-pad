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
export const maxScoopsPerServing = 5;
export interface FlavorScoops {
  readonly flavor: Flavor;
  readonly scoops: number;
}
export interface Serving {
  readonly flavors: readonly FlavorScoops[];
  readonly container: Container;
  readonly toppings: readonly Topping[];
}
export interface ServingEditor {
  readonly flavors: readonly FlavorScoops[];
  readonly container: Container | '';
  readonly toppings: readonly Topping[];
}
export function totalScoops(serving: Pick<ServingEditor, 'flavors'>): number {
  return serving.flavors.reduce((total, portion) => total + portion.scoops, 0);
}
export function scoopSummary(serving: Pick<ServingEditor, 'flavors'>): string {
  return serving.flavors
    .map(
      ({ flavor, scoops }) =>
        `${scoops} ${scoops === 1 ? 'scoop' : 'scoops'} ${flavor}`,
    )
    .join(' + ');
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
  return { flavors: [], container: '', toppings: [] };
}

export function hasPendingServing(draft: OrderDraft): boolean {
  return (
    draft.editingIndex !== undefined ||
    draft.editor.flavors.length > 0 ||
    !!draft.editor.container ||
    draft.editor.toppings.length > 0
  );
}

/** Commit exactly one complete serving, replacing it when editing. */
export function commitServing(draft: OrderDraft): OrderDraft {
  const valid = parseDraft(draft);
  if (valid.submittedTicketId)
    throw new Error('This order is already submitted.');
  if (!valid.editor.flavors.length || !valid.editor.container)
    throw new Error(
      'Add at least one scoop and choose a container for the current serving.',
    );
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
    throw new Error(
      'Add at least one scoop and choose a container to start your order.',
    );
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
  const parseServing = (value: unknown, partial: boolean): ServingEditor => {
    if (!value || typeof value !== 'object')
      throw new Error('Invalid serving.');
    const raw = value as Record<string, unknown>;
    // Existing stored single-flavor drafts represent one scoop. Canonical drafts
    // always use a flavor/count list; submitted tickets themselves stay immutable.
    let portions: unknown = raw.flavors;
    if (portions === undefined) {
      if (
        !flavors.includes(raw.flavor as Flavor) &&
        !(partial && raw.flavor === '')
      )
        throw new Error('Invalid flavor.');
      portions = raw.flavor ? [{ flavor: raw.flavor, scoops: 1 }] : [];
    }
    if (
      !Array.isArray(portions) ||
      portions.length > flavors.length ||
      (!partial && !portions.length)
    )
      throw new Error('Add at least one scoop.');
    const selected = portions.map((value: unknown) => {
      if (!value || typeof value !== 'object')
        throw new Error('Invalid flavor scoops.');
      const portion = value as FlavorScoops;
      if (!flavors.includes(portion.flavor)) throw new Error('Invalid flavor.');
      if (
        !Number.isInteger(portion.scoops) ||
        portion.scoops < 1 ||
        portion.scoops > maxScoopsPerServing
      )
        throw new Error('Scoop counts must be whole numbers from 1 to 5.');
      return Object.freeze({ flavor: portion.flavor, scoops: portion.scoops });
    });
    if (
      new Set(selected.map((portion) => portion.flavor)).size !==
      selected.length
    )
      throw new Error('Each flavor can appear only once per serving.');
    if (totalScoops({ flavors: selected }) > maxScoopsPerServing)
      throw new Error('A serving can contain at most 5 scoops.');
    if (
      !containers.includes(raw.container as Container) &&
      !(partial && raw.container === '')
    )
      throw new Error('Choose a container.');
    if (
      !Array.isArray(raw.toppings) ||
      raw.toppings.some((t) => !toppings.includes(t)) ||
      new Set(raw.toppings).size !== raw.toppings.length
    )
      throw new Error('Invalid toppings.');
    return Object.freeze({
      flavors: Object.freeze(
        flavors.flatMap((flavor) =>
          selected.filter((portion) => portion.flavor === flavor),
        ),
      ),
      container: raw.container as Container | '',
      toppings: Object.freeze(
        toppings.filter((t) => (raw.toppings as unknown[]).includes(t)),
      ),
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
    valid.editor.flavors.length ||
    valid.editor.container ||
    valid.editor.toppings.length
  )
    throw new Error('Add or cancel the serving before printing.');
  return parseTicket({
    id,
    createdAt,
    reference: valid.name.trim() || valid.reference,
    items: valid.servings.map((s) => ({
      name: `Ice cream (${totalScoops(s)} ${totalScoops(s) === 1 ? 'scoop' : 'scoops'})`,
      quantity: 1,
      modifiers: [
        s.container,
        ...s.flavors.map(
          ({ flavor, scoops }) =>
            `${scoops} ${scoops === 1 ? 'scoop' : 'scoops'} ${flavor}`,
        ),
        ...(s.toppings.length ? s.toppings : ['No toppings']),
      ],
    })),
  });
}
