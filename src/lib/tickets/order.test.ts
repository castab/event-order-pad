import { describe, expect, it } from 'vitest';
import {
  commitServing,
  cancelServing,
  editServing,
  sameServing,
  removeServing,
  prepareDraftForPrint,
  draftTicket,
  emptyEditor,
  flavors,
  newDraft,
  parseDraft,
  toppings,
  type OrderDraft,
  type Flavor,
  type Serving,
} from './order';

const time = '2026-10-11T20:00:00.000Z';
const serving = (flavor: Flavor = 'Vanilla', scoops = 1): Serving => ({
  flavors: [{ flavor, count: scoops }],
  container: 'Cup',
  toppings: [],
});
const draft = (extra: Partial<OrderDraft> = {}): OrderDraft => ({
  ...newDraft(),
  servings: [serving()],
  ...extra,
});

describe('ice cream orders with flavor scoops', () => {
  it('prepares additions and edits without mutating the saved draft', () => {
    const addition = draft({
      editor: {
        ...serving('Chocolate', 2),
        container: 'Sugar Cone',
        toppings: ['Gummy Bears'],
      },
    });
    const prepared = prepareDraftForPrint(addition);
    expect(prepared.servings).toHaveLength(2);
    expect(addition.servings).toHaveLength(1);
    expect(addition.editor.flavors).toEqual([
      { flavor: 'Chocolate', count: 2 },
    ]);
    expect(prepared.editor).toEqual(emptyEditor());
    const edit = commitServing({ ...addition, editingIndex: 0 });
    expect(edit.servings).toHaveLength(1);
    expect(edit.servings[0].flavors).toEqual([
      { flavor: 'Chocolate', count: 2 },
    ]);
    expect(edit.editingIndex).toBeUndefined();
    expect(prepareDraftForPrint(draft()).servings).toHaveLength(1);
  });
  it('requires a scoop and container and enforces the serving-count limit only for additions', () => {
    expect(() => prepareDraftForPrint(newDraft())).toThrow('start your order');
    for (const editor of [
      emptyEditor(),
      {
        ...emptyEditor(),
        flavors: [{ flavor: 'Vanilla' as const, count: 1 }],
      },
      { ...emptyEditor(), container: 'Cup' as const },
      { ...emptyEditor(), toppings: ['Gummy Bears' as const] },
    ]) {
      expect(() => commitServing(draft({ editor }))).toThrow(
        'To finish this serving:',
      );
    }
    const full = draft({
      servings: Array(30).fill(serving()),
      editor: serving('Chocolate', 5),
    });
    expect(() => prepareDraftForPrint(full)).toThrow('30');
    expect(
      prepareDraftForPrint({ ...full, editingIndex: 29 }).servings,
    ).toHaveLength(30);
    expect(() =>
      commitServing({
        ...full,
        submittedTicketId: 'locked',
        reference: '0001',
      }),
    ).toThrow('submitted');
  });
  it('retains servings, numeric identity, and resolved names when producing tickets', () => {
    const original = draft({
      servings: [serving(), serving(), serving('Chocolate', 2)],
      name: '  María & Pat  ',
    });
    const ticket = draftTicket(original, 'id', time, '0001');
    expect(ticket.servings).toEqual(original.servings);
    expect(ticket.reference).toBe('0001');
    expect(ticket.displayName).toBe('María & Pat');
    expect(
      draftTicket(draft({ reference: '0043', name: '  ' }), 'id', time)
        .displayName,
    ).toBe('Friendly Sprinkle');
    expect(newDraft().reference).toBeUndefined();
    expect(() => draftTicket(draft(), 'id', time)).toThrow('reference');
  });
  it('allows incomplete editors but rejects incomplete committed servings and malformed drafts', () => {
    expect(parseDraft(newDraft()).editor).toEqual(emptyEditor());
    expect(parseDraft(draft({ name: 'Pat\nCut' })).name).toBe('PatCut');
    expect(parseDraft(draft({ name: 'Pat ' })).name).toBe('Pat ');
    expect(
      draftTicket(draft({ name: 'Pat ' }), 'id', time, '0001').displayName,
    ).toBe('Pat');
    expect(() => parseDraft(draft({ name: 'A'.repeat(81) }))).toThrow('Name');
    expect(() =>
      parseDraft(draft({ servings: [{ ...serving(), flavors: [] }] })),
    ).toThrow('at least one scoop');
    expect(() =>
      draftTicket(draft({ servings: [] }), 'id', time, '0001'),
    ).toThrow('1–30');
    expect(() => draftTicket(draft({ editor: serving() }), 'id', time)).toThrow(
      'Add or cancel',
    );
    expect(() => draftTicket(draft({ editingIndex: 0 }), 'id', time)).toThrow(
      'Add or cancel',
    );
    expect(() =>
      parseDraft(draft({ servings: Array(31).fill(serving()) })),
    ).toThrow('30');
    for (const editingIndex of [-1, 1, 1.5])
      expect(() => parseDraft(draft({ editingIndex }))).toThrow('edited');
    for (const submittedTicketId of ['', 3, 'A'.repeat(101)])
      expect(() => parseDraft({ ...draft(), submittedTicketId })).toThrow(
        'submitted',
      );
    expect(() => parseDraft(null)).toThrow('draft');
    expect(() =>
      parseDraft({
        ...draft(),
        editor: {
          ...emptyEditor(),
          flavors: [{ flavor: 'Vanilla', count: 6 }],
        },
      }),
    ).toThrow('whole numbers');
    expect(() =>
      parseDraft({
        ...draft(),
        editor: { ...emptyEditor(), container: 'Waffle Cone' },
      }),
    ).toThrow('container');
  });
  it('blocks an oversized prospective print while allowing the saved draft to be corrected', () => {
    const busy: Serving = {
      flavors: flavors.map((flavor) => ({ flavor, count: 1 })),
      container: 'Cup',
      toppings: [...toppings],
    };
    const large = draft({ servings: Array(30).fill(busy) });
    expect(parseDraft(large).servings).toHaveLength(30);
    expect(() => prepareDraftForPrint(large)).toThrow('length limit');
    expect(
      prepareDraftForPrint({ ...large, servings: [busy] }).servings,
    ).toHaveLength(1);
  });
  it('cancels unfinished servings and edits, protects pending work and removes saved servings', () => {
    const original = draft({
      servings: [serving(), serving('Chocolate'), serving('Strawberry')],
    });
    const pending = parseDraft({
      ...original,
      editor: { ...emptyEditor(), toppings: ['Gummy Bears'] },
    });
    expect(editServing(pending, 1)).toEqual(pending);
    expect(cancelServing(pending).servings).toEqual(original.servings);
    expect(cancelServing(pending).editor).toEqual(emptyEditor());
    const editing = editServing(original, 1);
    expect(editing.editor).toEqual(original.servings[1]);
    expect(editing.editingIndex).toBe(1);
    const changed = { ...editing, editor: serving('Vanilla', 5) };
    expect(cancelServing(changed).servings).toEqual(original.servings);
    expect(cancelServing(changed).editingIndex).toBeUndefined();
    expect(commitServing(changed).servings).toEqual([
      serving(),
      serving('Vanilla', 5),
      serving('Strawberry'),
    ]);
    expect(prepareDraftForPrint(changed).servings).toHaveLength(3);
    const removed = removeServing(editing, 0);
    expect(removed.servings).toEqual(original.servings.slice(1));
    expect(removed.editingIndex).toBe(0);
    expect(removeServing(editing, 1).editor).toEqual(emptyEditor());
    expect(removeServing(editing, 1).editingIndex).toBeUndefined();
    for (const index of [-1, 3, 1.5]) {
      expect(() => editServing(original, index)).toThrow();
      expect(() => removeServing(original, index)).toThrow();
    }
  });
  it('names exactly what is missing from a pending serving', () => {
    expect(() => commitServing(draft({ editor: emptyEditor() }))).toThrow(
      'To finish this serving: add at least one scoop and choose a container.',
    );
    expect(() =>
      commitServing(draft({ editor: { ...emptyEditor(), container: 'Cup' } })),
    ).toThrow('To finish this serving: add at least one scoop.');
    expect(() =>
      commitServing(
        draft({ editor: { ...emptyEditor(), flavors: serving().flavors } }),
      ),
    ).toThrow('To finish this serving: choose a container.');
  });
  it('switches saved edits by discarding unsaved changes while protecting a new serving', () => {
    const original = draft({ servings: [serving(), serving('Chocolate')] });
    const changed = {
      ...editServing(original, 0),
      editor: serving('Strawberry', 3),
    };
    expect(editServing(changed, 0).editor).toEqual(changed.editor);
    const switched = editServing(changed, 1);
    expect(switched.editingIndex).toBe(1);
    expect(switched.editor).toEqual(original.servings[1]);
    expect(switched.servings).toEqual(original.servings);
    for (const editor of [
      serving(),
      { ...emptyEditor(), container: 'Cup' as const },
      { ...emptyEditor(), toppings: ['Gummy Bears' as const] },
    ]) {
      const pending = parseDraft({ ...original, editor });
      expect(editServing(pending, 1)).toEqual(pending);
    }
    const locked = parseDraft({
      ...original,
      submittedTicketId: 'locked',
      reference: '0001',
    });
    expect(editServing(locked, 1)).toEqual(locked);
  });
  it('compares all serving selections after menu normalization', () => {
    const mixed: Serving = {
      flavors: [
        { flavor: 'Chocolate', count: 2 },
        { flavor: 'Vanilla', count: 1 },
      ],
      container: 'Cup',
      toppings: ['Whipped cream', 'Gummy Bears'],
    };
    expect(
      sameServing(mixed, {
        ...mixed,
        flavors: [...mixed.flavors].reverse(),
        toppings: [...mixed.toppings].reverse(),
      }),
    ).toBe(true);
    for (const changed of [
      { ...mixed, container: 'Sugar Cone' as const },
      { ...mixed, toppings: [] },
      { ...mixed, flavors: [{ flavor: 'Chocolate' as const, count: 3 }] },
      {
        ...mixed,
        flavors: [
          { flavor: 'Chocolate' as const, count: 1 },
          { flavor: 'Vanilla' as const, count: 1 },
        ],
      },
    ])
      expect(sameServing(mixed, changed)).toBe(false);
    expect(sameServing(emptyEditor(), emptyEditor())).toBe(true);
    expect(sameServing(emptyEditor(), mixed)).toBe(false);
  });
});
