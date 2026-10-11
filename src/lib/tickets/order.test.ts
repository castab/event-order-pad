import { describe, expect, it } from 'vitest';
import {
  containers,
  commitServing,
  prepareDraftForPrint,
  draftTicket,
  emptyEditor,
  flavors,
  newDraft,
  parseDraft,
  toppings,
  type OrderDraft,
} from './order';
import { ticketText } from './format';
import { receiptHtml } from '../printing/adapters/passprnt';
import { receiptLayout, receiptPdf } from '../../../printer-service/receipt';

const time = '2026-10-11T20:00:00.000Z';
const draft = (extra: Partial<OrderDraft> = {}): OrderDraft => ({
  ...newDraft(undefined, () => 0),
  servings: [{ flavor: 'Vanilla', container: 'Cup', toppings: [] }],
  ...extra,
});

describe('ice cream orders', () => {
  it('prepares additions and edits without mutating the saved draft', () => {
    const addition = draft({
      editor: {
        flavor: 'Chocolate',
        container: 'Sugar Cone',
        toppings: ['Gummy Bears'],
      },
    });
    const prepared = prepareDraftForPrint(addition);
    expect(prepared.servings).toHaveLength(2);
    expect(addition.servings).toHaveLength(1);
    expect(addition.editor.flavor).toBe('Chocolate');
    expect(prepared.editor).toEqual(emptyEditor());
    const edit = commitServing({ ...addition, editingIndex: 0 });
    expect(edit.servings).toHaveLength(1);
    expect(edit.servings[0].flavor).toBe('Chocolate');
    expect(edit.editingIndex).toBeUndefined();
    expect(prepareDraftForPrint(draft()).servings).toHaveLength(1);
  });
  it('requires complete choices and enforces the limit only for additions', () => {
    expect(() => prepareDraftForPrint(newDraft())).toThrow('start your order');
    for (const editor of [
      emptyEditor(),
      { ...emptyEditor(), flavor: 'Vanilla' as const },
      { ...emptyEditor(), container: 'Cup' as const },
      { ...emptyEditor(), toppings: ['Gummy Bears' as const] },
    ]) {
      expect(() => commitServing(draft({ editor }))).toThrow(
        'flavor and container',
      );
    }
    const full = draft({
      servings: Array(30).fill(draft().servings[0]),
      editor: { flavor: 'Chocolate', container: 'Cup', toppings: [] },
    });
    expect(() => prepareDraftForPrint(full)).toThrow('30');
    expect(
      prepareDraftForPrint({ ...full, editingIndex: 29 }).servings,
    ).toHaveLength(30);
    expect(() =>
      commitServing({ ...full, submittedTicketId: 'locked' }),
    ).toThrow('submitted');
  });
  it('supports every flavor and container, with zero or all toppings', () => {
    for (const flavor of flavors)
      for (const container of containers)
        for (const selected of [[], [...toppings]]) {
          const ticket = draftTicket(
            draft({ servings: [{ flavor, container, toppings: selected }] }),
            'id',
            time,
          );
          expect(ticket.items[0]).toEqual({
            name: `${flavor} ice cream`,
            quantity: 1,
            modifiers: [
              container,
              ...(selected.length ? selected : ['No toppings']),
            ],
            instructions: undefined,
          });
        }
  });
  it('retains distinct and identical servings as separate preparation blocks', () => {
    const one = draft().servings[0];
    const ticket = draftTicket(
      draft({
        servings: [
          one,
          one,
          {
            flavor: 'Chocolate Chip',
            container: 'Sugar Cone',
            toppings: ['Gummy Bears'],
          },
        ],
      }),
      'id',
      time,
    );
    expect(ticket.items).toHaveLength(3);
    expect(ticketText(ticket).match(/1 x Vanilla ice cream/g)).toHaveLength(2);
    expect(ticketText(ticket)).toContain('+ Gummy Bears');
  });
  it('trims names, accepts 80 characters and uses a stable two-word fallback', () => {
    expect(
      draftTicket(draft({ name: '  María & Pat  ' }), 'id', time).reference,
    ).toBe('María & Pat');
    expect(
      draftTicket(draft({ name: ' '.repeat(80) }), 'id', time).reference,
    ).toBe('Sundae Sprinkle');
    expect(
      draftTicket(draft({ name: 'A'.repeat(80) }), 'id', time).reference,
    ).toHaveLength(80);
    expect(newDraft('Sundae Sprinkle', () => 0).reference).toBe('Sundae Scoop');
    const ticket = draftTicket(draft(), 'id', time);
    expect(ticketText(ticket, true)).toContain('ORDER: Sundae Sprinkle');
    expect(ticket.reference).toBe('Sundae Sprinkle');
  });
  it('rejects invalid menu data, names, duplicates and incomplete orders', () => {
    expect(() => parseDraft(draft({ name: 'A'.repeat(81) }))).toThrow('Name');
    expect(() => parseDraft(draft({ name: 'Pat\nCut' }))).toThrow('Name');
    expect(() =>
      parseDraft({
        ...draft(),
        servings: [{ flavor: 'Mint', container: 'Cup', toppings: [] }],
      }),
    ).toThrow();
    expect(() =>
      parseDraft({
        ...draft(),
        servings: [
          { flavor: 'Vanilla', container: 'Waffle Cone', toppings: [] },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseDraft({
        ...draft(),
        servings: [
          {
            flavor: 'Vanilla',
            container: 'Cup',
            toppings: ['Gummy Bears', 'Gummy Bears'],
          },
        ],
      }),
    ).toThrow();
    expect(() => draftTicket(draft({ servings: [] }), 'id', time)).toThrow();
    expect(() =>
      draftTicket(
        draft({ editor: { ...emptyEditor(), flavor: 'Vanilla' } }),
        'id',
        time,
      ),
    ).toThrow('Add or cancel');
    expect(() => draftTicket(draft({ editingIndex: 0 }), 'id', time)).toThrow(
      'Add or cancel',
    );
    expect(() =>
      parseDraft(draft({ servings: Array(31).fill(draft().servings[0]) })),
    ).toThrow('30');
    expect(
      draftTicket(
        draft({ servings: Array(30).fill(draft().servings[0]) }),
        'id',
        time,
      ).items,
    ).toHaveLength(30);
  });
  it('preserves name and toppings in shared HTML/PDF layouts, including wrapped names', async () => {
    const ticket = draftTicket(
      draft({
        name: '<Pat & Sam> ' + 'A'.repeat(60),
        servings: [
          {
            flavor: 'Chocolate Chip',
            container: 'Cake Cone',
            toppings: [...toppings],
          },
        ],
      }),
      'id',
      time,
    );
    const html = receiptHtml(ticket, true);
    expect(html).toContain('&lt;Pat &amp; Sam&gt;');
    expect(html).not.toContain('<Pat & Sam>');
    const layout = receiptLayout(ticket, true);
    expect(layout.lines[0].text).toBe('REPRINT');
    expect(layout.lines.every((line) => line.text.length <= 36)).toBe(true);
    for (const topping of toppings)
      expect(layout.lines.some((line) => line.text.includes(topping))).toBe(
        true,
      );
    const pdf = await receiptPdf(ticket, true, 'Courier', layout.heightMm);
    expect(pdf.toString('ascii')).toMatch(/^%PDF-/);
    expect(pdf.toString('ascii').match(/\/Type \/Page\b/g)).toHaveLength(1);
  });
});
