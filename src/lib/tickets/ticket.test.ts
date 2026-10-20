import { describe, expect, it } from 'vitest';
import {
  FLAVORS,
  CONTAINERS,
  TOPPINGS,
  blankNameLabel,
  blankNameLabels,
  parseReference,
  parseTicket,
  sampleTicket,
  totalScoops,
  widestBlankNameLabel,
} from './ticket';
import {
  assertPrintable,
  formatTicket,
  localTicketTime,
  maxTicketLines,
  prepTicketLayout,
  ticketText,
  wrapText,
} from './format';
import { receiptHtml, passPrntUri } from '../printing/adapters/passprnt';
import { receiptLayout, receiptPdf } from '../../../printer-service/receipt';

const ticket = sampleTicket('stable-ticket-id', '2026-10-12T02:42:00.000Z');
const simple = {
  flavors: [{ flavor: 'Vanilla', count: 1 }],
  container: 'Cup',
  toppings: [],
};
const input = (servings: unknown = [simple]) => ({
  schema: 2,
  id: 'id',
  reference: '0043',
  createdAt: ticket.createdAt,
  servings,
});

describe('structured immutable tickets', () => {
  it('matches the #0043 sample and freezes every nested value', () => {
    expect(ticket.reference).toBe('0043');
    expect(ticket.customerName).toBe('Maria');
    expect(ticket.displayName).toBe('Maria');
    expect(ticket.servings).toHaveLength(3);
    expect(ticket.servings.reduce((sum, s) => sum + totalScoops(s), 0)).toBe(6);
    expect(ticket.servings[0].flavors).toEqual([
      { flavor: 'Strawberry', count: 1 },
      { flavor: 'Chocolate Chip', count: 2 },
    ]);
    expect(ticket.servings.map((s) => s.container)).toEqual([
      'Sugar Cone',
      'Cup',
      'Cake Cone',
    ]);
    for (const value of [
      ticket,
      ticket.servings,
      ...ticket.servings,
      ...ticket.servings.flatMap((s) => [s.flavors, s.toppings, ...s.flavors]),
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it('supports every flavor/count/container and all 256 topping combinations', () => {
    for (const flavor of FLAVORS)
      for (const container of CONTAINERS)
        for (const count of [1, 2, 3, 4, 5])
          for (let mask = 0; mask < 1 << TOPPINGS.length; mask++) {
            const toppings = TOPPINGS.filter((_, i) => mask & (1 << i));
            const result = parseTicket(
              input([{ flavors: [{ flavor, count }], container, toppings }]),
            );
            expect(result.servings[0]).toEqual({
              flavors: [{ flavor, count }],
              container,
              toppings,
            });
          }
  }, 15_000);
  it.each([0, -1, 1.5, 6, '2', null, undefined, NaN, Infinity])(
    'rejects invalid scoop count %s',
    (count) => {
      expect(() =>
        parseTicket(
          input([{ ...simple, flavors: [{ flavor: 'Vanilla', count }] }]),
        ),
      ).toThrow('whole numbers');
    },
  );
  it('accepts mixed totals of five and rejects excess totals, empty portions and duplicates', () => {
    const flavors = FLAVORS.map((flavor, i) => ({
      flavor,
      count: i === 0 ? 2 : 1,
    }));
    expect(
      totalScoops(parseTicket(input([{ ...simple, flavors }])).servings[0]),
    ).toBe(5);
    expect(() =>
      parseTicket(
        input([
          {
            ...simple,
            flavors: [
              { flavor: 'Vanilla', count: 3 },
              { flavor: 'Chocolate', count: 3 },
            ],
          },
        ]),
      ),
    ).toThrow('at most 5');
    expect(() => parseTicket(input([{ ...simple, flavors: [] }]))).toThrow(
      'at least one scoop',
    );
    expect(() =>
      parseTicket(
        input([{ ...simple, flavors: [...simple.flavors, ...simple.flavors] }]),
      ),
    ).toThrow('only once');
    expect(() =>
      parseTicket(
        input([{ ...simple, toppings: ['Gummy Bears', 'Gummy Bears'] }]),
      ),
    ).toThrow('toppings');
  });
  it.each([
    { flavors: null },
    { flavors: Array(1) },
    { flavors: [null] },
    { flavors: [{ flavor: 'Soft serve', count: 1 }] },
    { flavors: [{ flavor: 'Mint', count: 1 }] },
    { container: '' },
    { container: ['Cup', 'Cake Cone'] },
    { container: 'Waffle Cone' },
    { toppings: null },
    { toppings: Array(1) },
    { toppings: ['Sprinkles'] },
  ])('rejects malformed or unknown serving values %j', (extra) => {
    expect(() => parseTicket(input([{ ...simple, ...extra }]))).toThrow();
  });
  it.each([[], Array(31).fill(simple), Array(1), null, undefined, [null]])(
    'rejects invalid serving lists',
    (servings) => {
      expect(() => parseTicket({ ...input(), servings })).toThrow();
    },
  );
  it('normalizes menu order and retains identical servings as separate blocks', () => {
    const a = {
      ...simple,
      flavors: [
        { flavor: 'Chocolate Chip', count: 2 },
        { flavor: 'Vanilla', count: 1 },
      ],
      toppings: [...TOPPINGS].reverse(),
    };
    const b = {
      ...a,
      flavors: [...a.flavors].reverse(),
      toppings: [...TOPPINGS],
    };
    expect(JSON.stringify(parseTicket(input([a])))).toBe(
      JSON.stringify(parseTicket(input([b]))),
    );
    expect(parseTicket(input([simple, simple])).servings).toHaveLength(2);
    expect(ticketText(parseTicket(input([simple, simple])))).toContain(
      'SERVING 2 OF 2',
    );
    expect(parseTicket(input(Array(30).fill(simple))).servings).toHaveLength(
      30,
    );
  });
  it.each([
    'yesterday',
    '2026-02-30T20:00:00.000Z',
    '2026-10-12T02:42:00Z',
    '2026-10-12T02:42:00.000+00:00',
  ])('rejects invalid UTC timestamp %s', (createdAt) => {
    expect(() => parseTicket({ ...input(), createdAt })).toThrow('timestamp');
  });
  it('rejects old schemas and invalid IDs', () => {
    expect(() => parseTicket({ ...input(), schema: 1 })).toThrow('schema');
    expect(() => parseTicket({ ...input(), items: [] })).toThrow('schema');
    for (const id of ['', 'A'.repeat(101), 'cut\x1b', null])
      expect(() => parseTicket({ ...input(), id })).toThrow();
  });
  it('cleans names, enforces 80 printable characters, and preserves stored display names', () => {
    const named = parseTicket({
      ...input(),
      customerName: '  María\n &\x1b Pat\u0085  ',
    });
    expect(named.customerName).toBe('María & Pat');
    expect(named.displayName).toBe('María & Pat');
    expect(
      parseTicket({ ...input(), customerName: '😀'.repeat(80) }).customerName,
    ).toHaveLength(160);
    expect(() =>
      parseTicket({ ...input(), customerName: 'A'.repeat(81) }),
    ).toThrow('80');
    for (const customerName of [null, 3, []])
      expect(() => parseTicket({ ...input(), customerName })).toThrow('Name');
    for (const customerName of [undefined, '', '  \n\x00 '])
      expect(parseTicket({ ...input(), customerName }).displayName).toBe(
        'Silly Meringue',
      );
    expect(
      parseTicket({ ...input(), displayName: 'Stored friendly label' })
        .displayName,
    ).toBe('Stored friendly label');
    expect(parseTicket(JSON.parse(JSON.stringify(named)))).toEqual(named);
    expect(() =>
      parseTicket({ ...named, displayName: 'Someone else' }),
    ).toThrow('match');
    for (const displayName of ['', 'A'.repeat(81), 'cut\x1b'])
      expect(() => parseTicket({ ...input(), displayName })).toThrow();
  });
  it('derives labels from ticket IDs, not references', () => {
    expect(blankNameLabel('id')).toBe('Silly Meringue');
    expect(blankNameLabel('id')).toBe(blankNameLabel('id'));
    expect(parseTicket({ ...input(), reference: '0001' }).displayName).toBe(
      parseTicket({ ...input(), reference: '0002' }).displayName,
    );
    expect(new Set(blankNameLabels).size).toBe(1024);
    const counts = new Map<string, number>();
    for (let i = 0; i < 64 * 1024; i++) {
      const label = blankNameLabel(i.toString(16).padStart(32, '0'));
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    expect(counts.size).toBe(1024);
    expect(Math.min(...counts.values())).toBeGreaterThan(32);
    expect(Math.max(...counts.values())).toBeLessThan(96);
    for (const id of ['', 43, undefined])
      expect(() => blankNameLabel(id as string)).toThrow('ticket ID');
  });
  it('never prints a blank-name label taller than the widest one checked before printing', () => {
    const size = (displayName: string) => {
      const ticket = parseTicket({ ...input(), displayName });
      return [
        prepTicketLayout(ticket, true).height,
        formatTicket(ticket, true, 36).length,
      ];
    };
    const [height, lines] = size(widestBlankNameLabel);
    for (const label of blankNameLabels) {
      const [labelHeight, labelLines] = size(label);
      expect(labelHeight).toBeLessThanOrEqual(height);
      expect(labelLines).toBeLessThanOrEqual(lines);
    }
  });
  it('uses safe numeric references', () => {
    expect(parseReference('43')).toBe('0043');
    expect(parseReference('10000')).toBe('10000');
    expect(parseTicket({ ...input(), reference: '43' }).reference).toBe('0043');
    for (const reference of [
      '0',
      '-1',
      '1.5',
      '1e3',
      'Sundae Sprinkle',
      '9007199254740992',
      43,
      '',
    ])
      expect(() => parseTicket({ ...input(), reference })).toThrow('reference');
  });
});

describe('prep-ticket layouts', () => {
  it('formats local time explicitly and never prints UTC timestamps', () => {
    expect(localTicketTime(ticket.createdAt, 'America/Los_Angeles')).toBe(
      'Sun 10/11 · 7:42 PM',
    );
    expect(localTicketTime(ticket.createdAt, 'UTC')).toBe(
      'Mon 10/12 · 2:42 AM',
    );
    expect(ticketText(ticket)).not.toContain('UTC');
  });
  it('prints every field in the specified order, with separators and correct singular/plural', () => {
    const output = ticketText(ticket).replace(/\s+/g, ' ');
    const fields = [
      'PREP TICKET',
      'ORDER #0043',
      'MARIA',
      '3 SERVINGS | 6 SCOOPS',
      '='.repeat(42),
      'SERVING 1 OF 3',
      '3 SCOOPS - SUGAR CONE',
      '1 x Strawberry',
      '2 x Chocolate Chip',
      'TOPPINGS: Whipped cream, Chocolate Sauce',
      '-'.repeat(42),
      'SERVING 2 OF 3',
      '1 SCOOP - CUP',
      '1 x Vanilla',
      'TOPPINGS: No toppings',
      'SERVING 3 OF 3',
      '2 SCOOPS - CAKE CONE',
      '1 x Chocolate',
      '1 x Vanilla',
      'TOPPINGS: Gummy Bears',
      '='.repeat(42),
      'END OF TICKET',
      `Ticket ID: ${ticket.id}`,
    ];
    let position = 0;
    for (const field of fields) {
      const index = output.indexOf(field, position);
      expect(index, field).toBeGreaterThanOrEqual(position);
      position = index + field.length;
    }
    expect(ticketText(parseTicket(input()))).toContain('1 SERVING | 1 SCOOP');
    expect(formatTicket(ticket).every((line) => line.text.length <= 42)).toBe(
      true,
    );
    expect(formatTicket(ticket)[0].text).toHaveLength(42);
  });
  it('wraps long names and IDs without truncation and marks reprints without mutation', () => {
    const long = parseTicket({
      ...input(),
      customerName: 'A'.repeat(80),
      id: 'B'.repeat(100),
    });
    const lines = formatTicket(long);
    expect(
      lines
        .filter((l) => l.role === 'name')
        .map((l) => l.text)
        .join(''),
    ).toBe('A'.repeat(80));
    expect(
      lines
        .map((l) => l.text)
        .join('')
        .replace(/\s/g, ''),
    ).toContain('B'.repeat(100));
    expect(wrapText('😀'.repeat(50), 24).join('')).toBe('😀'.repeat(50));
    const before = JSON.stringify(long);
    expect(ticketText(long, true)).toMatch(
      /^REPRINT\nCheck for the first copy before building/,
    );
    expect(ticketText(long, true).replace(/\s/g, '')).toContain(long.id);
    expect(ticketText(long)).not.toContain('REPRINT');
    expect(JSON.stringify(long)).toBe(before);
    expect(() => formatTicket(long, false, 23)).toThrow('width');
  });
  it('shares geometry, escapes HTML and makes one PDF page with all serving fields', async () => {
    const escaped = parseTicket({
      ...input(),
      customerName: '<Pat & Sam> "Crème"',
    });
    const html = receiptHtml(escaped, true);
    expect(html).toContain('&lt;PAT &amp;');
    expect(html).toContain('&quot;CRÈME&quot;');
    expect(html).not.toContain('<Pat');
    expect(html).not.toMatch(/src=|https?:/);
    const layout = receiptLayout(ticket, true);
    expect(layout.nodes).toEqual(prepTicketLayout(ticket, true).nodes);
    expect(layout.nodes.some((n) => n.kind === 'box' && n.filled)).toBe(true);
    expect(layout.nodes.some((n) => n.kind === 'rule' && n.dashed)).toBe(true);
    for (const node of layout.nodes) {
      if (node.kind !== 'text' || !node.inverse) continue;
      expect(
        layout.nodes.some(
          (box) =>
            box.kind === 'box' &&
            box.filled &&
            box.x <= node.x &&
            box.y <= node.y &&
            box.x + box.width >= node.x + node.width &&
            box.y + box.height >= node.y + node.height,
        ),
      ).toBe(true);
    }
    const pdf = await receiptPdf(ticket, true, 'Courier', layout.heightMm);
    expect(pdf.toString('ascii')).toMatch(/^%PDF-/);
    expect(pdf.toString('ascii').match(/\/Type \/Page\b/g)).toHaveLength(1);
    await expect(
      receiptPdf(ticket, true, 'Courier', layout.heightMm - 1),
    ).rejects.toThrow('short');
  });
  it('accepts the exact line limit but rejects overlength orders before creation, including reprint space', () => {
    const busy = {
      ...simple,
      flavors: FLAVORS.map((flavor) => ({ flavor, count: 1 })),
      toppings: TOPPINGS.slice(0, 6),
    };
    const servings = [
      ...Array(20).fill(busy),
      { ...busy, flavors: busy.flavors.slice(0, 3) },
    ];
    const valid = parseTicket(input(servings));
    expect(formatTicket(valid, true, 36)).toHaveLength(maxTicketLines);
    expect(formatTicket(valid, false, 36).length).toBeLessThan(maxTicketLines);
    expect(() => parseTicket(input(Array(21).fill(busy)))).toThrow(
      'length limit',
    );
    expect(prepTicketLayout(valid, true).heightMm).toBeLessThanOrEqual(2000);
    expect(
      passPrntUri(valid, true, 'attempt-id', 'https://pad.example/').length,
    ).toBeLessThanOrEqual(128 * 1024);
    expect(() =>
      assertPrintable({
        ...valid,
        servings: Array(100).fill(simple),
      } as typeof valid),
    ).toThrow('length limit');
    expect(() =>
      prepTicketLayout(
        { ...valid, servings: Array(100).fill(simple) } as typeof valid,
        true,
      ),
    ).toThrow('2000 mm');
  });
});
