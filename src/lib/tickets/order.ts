import {
  parseTicket,
  parseServing,
  parseReference,
  cleanCustomerName,
  maxScoopsPerServing,
  FLAVORS as flavors,
  CONTAINERS as containers,
  TOPPINGS as toppings,
  totalScoops,
  type Serving,
  type ServingEditor,
  type OrderTicket,
} from './ticket';
export { flavors, containers, toppings, totalScoops, maxScoopsPerServing };
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
  if (hasPendingServing(valid) || valid.submittedTicketId) return valid;
  if (!Number.isInteger(index) || !valid.servings[index])
    throw new Error('Invalid serving being edited.');
  return parseDraft({
    ...valid,
    editor: valid.servings[index],
    editingIndex: index,
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
  draftTicket(prepared, 'I'.repeat(100), '2000-01-01T00:00:00.000Z');
  return prepared;
}

export function newDraft(previousReference?: string): OrderDraft {
  const n =
    previousReference === undefined
      ? 1
      : Number(parseReference(previousReference)) + 1;
  return parseDraft({
    name: '',
    reference: parseReference(String(n)),
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
  const reference = parseReference(v.reference);
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
    reference: valid.reference,
    customerName: valid.name,
    servings: valid.servings,
  });
}
