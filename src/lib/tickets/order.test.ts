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
  totalScoops,
  type OrderDraft,
  type Flavor,
  type Serving,
} from './order';
import { ticketText } from './format';
import { receiptHtml } from '../printing/adapters/passprnt';
import { receiptLayout, receiptPdf } from '../../../printer-service/receipt';

const time = '2026-10-11T20:00:00.000Z';
const serving = (flavor: Flavor = 'Vanilla', scoops = 1): Serving => ({
  flavors: [{ flavor, scoops }],
  container: 'Cup',
  toppings: [],
});
const draft = (extra: Partial<OrderDraft> = {}): OrderDraft => ({
  ...newDraft(undefined, () => 0),
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
      { flavor: 'Chocolate', scoops: 2 },
    ]);
    expect(prepared.editor).toEqual(emptyEditor());
    const edit = commitServing({ ...addition, editingIndex: 0 });
    expect(edit.servings).toHaveLength(1);
    expect(edit.servings[0].flavors).toEqual([
      { flavor: 'Chocolate', scoops: 2 },
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
        flavors: [{ flavor: 'Vanilla' as const, scoops: 1 }],
      },
      { ...emptyEditor(), container: 'Cup' as const },
      { ...emptyEditor(), toppings: ['Gummy Bears' as const] },
    ]) {
      expect(() => commitServing(draft({ editor }))).toThrow(
        'at least one scoop and choose a container',
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
      commitServing({ ...full, submittedTicketId: 'locked' }),
    ).toThrow('submitted');
  });
  it('supports every flavor, 1–5 scoops, and every container with zero or all toppings', () => {
    for (const flavor of flavors)
      for (const container of containers)
        for (const selected of [[], [...toppings]])
          for (const scoops of [1, 5]) {
            const ticket = draftTicket(
              draft({
                servings: [
                  { ...serving(flavor, scoops), container, toppings: selected },
                ],
              }),
              'id',
              time,
            );
            expect(ticket.items[0]).toEqual({
              name: `Ice cream (${scoops} ${scoops === 1 ? 'scoop' : 'scoops'})`,
              quantity: 1,
              modifiers: [
                container,
                `${scoops} ${scoops === 1 ? 'scoop' : 'scoops'} ${flavor}`,
                ...(selected.length ? selected : ['No toppings']),
              ],
              instructions: undefined,
            });
          }
  });
  it('keeps a mixed-flavor serving together with correct total and separate scoop counts', () => {
    const mixed: Serving = {
      ...serving(),
      flavors: [
        { flavor: 'Chocolate Chip', scoops: 2 },
        { flavor: 'Strawberry', scoops: 1 },
      ],
      toppings: ['Caramel Sauce'],
    };
    const ticket = draftTicket(
      draft({ servings: [mixed, serving('Vanilla', 5)] }),
      'id',
      time,
    );
    expect(totalScoops(mixed)).toBe(3);
    expect(ticket.items).toHaveLength(2);
    expect(ticket.items[0].name).toBe('Ice cream (3 scoops)');
    expect(ticket.items[0].quantity).toBe(1);
    expect(ticket.items[0].modifiers).toEqual([
      'Cup',
      '1 scoop Strawberry',
      '2 scoops Chocolate Chip',
      'Caramel Sauce',
    ]);
    expect(ticketText(ticket)).toContain('1 x Ice cream (3 scoops)');
    expect(ticketText(ticket)).toContain('2 scoops Chocolate Chip');
    expect(ticketText(ticket)).toContain('1 scoop Strawberry');
    expect(ticket.items[1].name).toBe('Ice cream (5 scoops)');
  });
  it('accepts five scoops shared across all flavors and rejects malformed counts, duplicates and totals over five', () => {
    const all = draft({
      servings: [
        {
          ...serving(),
          flavors: flavors.map((flavor, i) => ({
            flavor,
            scoops: i === 0 ? 2 : 1,
          })),
        },
      ],
    });
    expect(totalScoops(parseDraft(all).servings[0])).toBe(5);
    for (const count of [0, -1, 1.5, 6, '2', null, undefined, NaN, Infinity]) {
      expect(() =>
        parseDraft({
          ...draft(),
          servings: [
            { ...serving(), flavors: [{ flavor: 'Vanilla', scoops: count }] },
          ],
        }),
      ).toThrow('whole numbers');
    }
    expect(() =>
      parseDraft(
        draft({
          servings: [
            {
              ...serving(),
              flavors: [
                { flavor: 'Chocolate', scoops: 3 },
                { flavor: 'Vanilla', scoops: 3 },
              ],
            },
          ],
        }),
      ),
    ).toThrow('at most 5');
    expect(() =>
      parseDraft(
        draft({
          editor: {
            ...emptyEditor(),
            flavors: [
              { flavor: 'Chocolate', scoops: 4 },
              { flavor: 'Vanilla', scoops: 2 },
            ],
          },
        }),
      ),
    ).toThrow('at most 5');
    expect(() =>
      parseDraft(
        draft({
          servings: [
            {
              ...serving(),
              flavors: [
                { flavor: 'Vanilla', scoops: 1 },
                { flavor: 'Vanilla', scoops: 2 },
              ],
            },
          ],
        }),
      ),
    ).toThrow('only once');
    expect(() =>
      parseDraft(draft({ servings: [{ ...serving(), flavors: [] }] })),
    ).toThrow('at least one scoop');
    expect(() =>
      parseDraft({ ...draft(), editor: { ...emptyEditor(), flavors: null } }),
    ).toThrow('at least one scoop');
    expect(() =>
      parseDraft({
        ...draft(),
        servings: [{ ...serving(), flavors: [{ flavor: 'Mint', scoops: 1 }] }],
      }),
    ).toThrow('Invalid flavor');
  });
  it('migrates existing single-flavor servings and unfinished editors without changing names or lock identity', () => {
    const old = {
      ...newDraft(undefined, () => 0),
      name: 'Legacy customer',
      submittedTicketId: 'old-ticket',
      servings: [
        {
          flavor: 'Chocolate Chip',
          container: 'Sugar Cone',
          toppings: ['Gummy Bears'],
        },
      ],
      editor: { flavor: 'Strawberry', container: '', toppings: [] },
    };
    const migrated = parseDraft(old);
    expect(migrated.name).toBe('Legacy customer');
    expect(migrated.submittedTicketId).toBe('old-ticket');
    expect(migrated.servings[0]).toEqual({
      flavors: [{ flavor: 'Chocolate Chip', scoops: 1 }],
      container: 'Sugar Cone',
      toppings: ['Gummy Bears'],
    });
    expect(migrated.editor).toEqual({
      flavors: [{ flavor: 'Strawberry', scoops: 1 }],
      container: '',
      toppings: [],
    });
    expect(
      parseDraft({
        ...old,
        editor: { flavor: '', container: '', toppings: [] },
      }).editor,
    ).toEqual(emptyEditor());
    expect(() =>
      parseDraft({
        ...old,
        servings: [{ flavor: 'Mint', container: 'Cup', toppings: [] }],
      }),
    ).toThrow('Invalid flavor');
    expect(Object.isFrozen(migrated.servings[0].flavors[0])).toBe(true);
  });
  it('retains identical servings as separate preparation blocks and stable fallback labels', () => {
    const ticket = draftTicket(
      draft({ servings: [serving(), serving(), serving('Chocolate', 2)] }),
      'id',
      time,
    );
    expect(ticket.items).toHaveLength(3);
    expect(ticketText(ticket).match(/1 x Ice cream \(1 scoop\)/g)).toHaveLength(
      2,
    );
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
  });
  it('rejects invalid names, toppings, containers, incomplete orders and excess servings', () => {
    expect(() => parseDraft(draft({ name: 'A'.repeat(81) }))).toThrow('Name');
    expect(() => parseDraft(draft({ name: 'Pat\nCut' }))).toThrow('Name');
    expect(() =>
      parseDraft({
        ...draft(),
        servings: [{ ...serving(), container: 'Waffle Cone' }],
      }),
    ).toThrow('container');
    expect(() =>
      parseDraft(
        draft({
          servings: [
            { ...serving(), toppings: ['Gummy Bears', 'Gummy Bears'] },
          ],
        }),
      ),
    ).toThrow('toppings');
    expect(() => draftTicket(draft({ servings: [] }), 'id', time)).toThrow();
    expect(() =>
      draftTicket(
        draft({
          editor: {
            ...emptyEditor(),
            flavors: [{ flavor: 'Vanilla', scoops: 1 }],
          },
        }),
        'id',
        time,
      ),
    ).toThrow('Add or cancel');
    expect(() => draftTicket(draft({ editingIndex: 0 }), 'id', time)).toThrow(
      'Add or cancel',
    );
    expect(() =>
      parseDraft(draft({ servings: Array(31).fill(serving()) })),
    ).toThrow('30');
    expect(
      draftTicket(draft({ servings: Array(30).fill(serving()) }), 'id', time)
        .items,
    ).toHaveLength(30);
  });
  it('preserves mixed scoop counts, toppings and escaped names in shared HTML/PDF layouts', async () => {
    const ticket = draftTicket(
      draft({
        name: '<Pat & Sam> ' + 'A'.repeat(60),
        servings: [
          {
            flavors: [
              { flavor: 'Chocolate Chip', scoops: 2 },
              { flavor: 'Strawberry', scoops: 1 },
            ],
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
    expect(html).toContain('2 scoops Chocolate Chip');
    expect(html).toContain('1 scoop Strawberry');
    const layout = receiptLayout(ticket, true);
    expect(layout.lines[0].text).toBe('REPRINT');
    expect(layout.lines.every((line) => line.text.length <= 36)).toBe(true);
    expect(
      layout.lines.some((line) =>
        line.text.includes('2 scoops Chocolate Chip'),
      ),
    ).toBe(true);
    for (const topping of toppings)
      expect(layout.lines.some((line) => line.text.includes(topping))).toBe(
        true,
      );
    const pdf = await receiptPdf(ticket, true, 'Courier', layout.heightMm);
    expect(pdf.toString('ascii')).toMatch(/^%PDF-/);
    expect(pdf.toString('ascii').match(/\/Type \/Page\b/g)).toHaveLength(1);
  });
});
