import {
  parseTicket,
  parseServing,
  parseReference,
  cleanCustomerName,
  maxScoopsPerServing,
  totalScoops,
  widestBlankNameLabel,
  type Serving,
  type ServingEditor,
  type OrderTicket,
} from './ticket';
import { menuNames, type ChoiceCategory, type Menu } from './menu';
export { totalScoops, maxScoopsPerServing };
export type {
  Flavor,
  Container,
  Topping,
  Serving,
  ServingEditor,
} from './ticket';
export function scoopSummary(serving: Pick<ServingEditor, 'flavors'>): string {
  return serving.flavors
    .map(
      ({ flavor, count }) =>
        `${count} ${count === 1 ? 'scoop' : 'scoops'} ${flavor}`,
    )
    .join(' + ');
}
export interface OrderDraft {
  readonly name: string;
  readonly reference?: string;
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

/** Cancel a new serving or discard an edit without touching saved servings. */
export function cancelServing(draft: OrderDraft): OrderDraft {
  return parseDraft({
    ...draft,
    editor: emptyEditor(),
    editingIndex: undefined,
  });
}
/** Protect an unfinished serving when another saved serving is tapped. */
export function editServing(draft: OrderDraft, index: number): OrderDraft {
  const valid = parseDraft(draft);
  if (
    valid.submittedTicketId ||
    valid.editingIndex === index ||
    (valid.editingIndex === undefined && hasPendingServing(valid))
  )
    return valid;
  if (!Number.isInteger(index) || !valid.servings[index])
    throw new Error('Invalid serving being edited.');
  return parseDraft({
    ...valid,
    editor: valid.servings[index],
    editingIndex: index,
  });
}

/** Compare normalized menu selections, independent of selection order. */
export function sameServing(a: ServingEditor, b: ServingEditor): boolean {
  const key = (value: ServingEditor) => {
    const s = parseServing(value, true);
    return JSON.stringify([
      [...s.flavors].sort((x, y) => (x.flavor < y.flavor ? -1 : 1)),
      s.container,
      [...s.toppings].sort(),
    ]);
  };
  return key(a) === key(b);
}

/** Puts selections in current menu order; names no longer on the menu keep their order at the end. */
export function orderByMenu<T extends ServingEditor>(
  serving: T,
  menu: Menu,
): T {
  const rank = (category: ChoiceCategory) => {
    const names = menuNames(menu, category);
    return (name: string) => {
      const index = names.indexOf(name);
      return index < 0 ? names.length : index;
    };
  };
  const flavor = rank('flavor');
  const topping = rank('topping');
  return {
    ...serving,
    flavors: [...serving.flavors].sort(
      (a, b) => flavor(a.flavor) - flavor(b.flavor),
    ),
    toppings: [...serving.toppings].sort((a, b) => topping(a) - topping(b)),
  };
}

function choiceKeys(draft: OrderDraft): Set<string> {
  const keys = new Set<string>();
  for (const s of [...draft.servings, draft.editor]) {
    for (const { flavor } of s.flavors) keys.add(`flavor:${flavor}`);
    if (s.container) keys.add(`container:${s.container}`);
    for (const topping of s.toppings) keys.add(`topping:${topping}`);
  }
  return keys;
}

/** Menu names that `after` uses and `before` did not; only these must be on the current menu. */
export function newChoices(
  before: OrderDraft,
  after: OrderDraft,
): readonly { readonly category: ChoiceCategory; readonly name: string }[] {
  const old = choiceKeys(before);
  return [...choiceKeys(after)]
    .filter((key) => !old.has(key))
    .map((key) => {
      const colon = key.indexOf(':');
      return {
        category: key.slice(0, colon) as ChoiceCategory,
        name: key.slice(colon + 1),
      };
    });
}

export function removeServing(draft: OrderDraft, index: number): OrderDraft {
  const valid = parseDraft(draft);
  if (!Number.isInteger(index) || !valid.servings[index])
    throw new Error('Invalid serving being removed.');
  if (valid.submittedTicketId)
    throw new Error('This order is already submitted.');
  return parseDraft({
    ...valid,
    servings: valid.servings.filter((_, i) => i !== index),
    editor: valid.editingIndex === index ? emptyEditor() : valid.editor,
    editingIndex:
      valid.editingIndex === index
        ? undefined
        : valid.editingIndex !== undefined && valid.editingIndex > index
          ? valid.editingIndex - 1
          : valid.editingIndex,
  });
}

/** Commit exactly one complete serving, replacing it when editing. */
export function commitServing(draft: OrderDraft): OrderDraft {
  const valid = parseDraft(draft);
  if (valid.submittedTicketId)
    throw new Error('This order is already submitted.');
  const missing = [
    ...(!valid.editor.flavors.length ? ['add at least one scoop'] : []),
    ...(!valid.editor.container ? ['choose a container'] : []),
  ];
  if (missing.length)
    throw new Error(`To finish this serving: ${missing.join(' and ')}.`);
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
  const probe = draftTicket(
    prepared,
    'I'.repeat(100),
    '2000-01-01T00:00:00.000Z',
    String(Number.MAX_SAFE_INTEGER),
  );
  // The real ticket ID picks the blank-name label, so check the widest one.
  if (!probe.customerName)
    parseTicket({ ...probe, displayName: widestBlankNameLabel });
  return prepared;
}

export function newDraft(): OrderDraft {
  return parseDraft({
    name: '',
    servings: [],
    editor: emptyEditor(),
  });
}

/** Drafts may have an incomplete editor, but committed servings are complete. */
export function parseDraft(value: unknown): OrderDraft {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid order draft.');
  const v = value as OrderDraft;
  const name = cleanCustomerName(v.name, false);
  const reference =
    v.reference === undefined ? undefined : parseReference(v.reference);
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
  if (v.submittedTicketId && !reference)
    throw new Error('Submitted orders need an assigned reference.');
  return Object.freeze({
    name,
    reference,
    servings: Object.freeze(Array.from(v.servings, (s) => parseServing(s))),
    editor: parseServing(v.editor, true),
    editingIndex: v.editingIndex,
    submittedTicketId: v.submittedTicketId,
  });
}

export function draftTicket(
  draft: OrderDraft,
  id: string,
  createdAt: string,
  reference = draft.reference,
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
    schema: 2,
    id,
    createdAt,
    reference,
    customerName: valid.name,
    servings: valid.servings,
  });
}
