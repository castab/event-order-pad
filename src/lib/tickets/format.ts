import type { OrderTicket } from './ticket';

export const maxTicketLines = 240;
export const maxReceiptHeightMm = 2000;
export const receiptWidth = 576;
export const pixelsPerMm = 8; // 72 mm printable width on an 80 mm roll.
export const reprintWarning = 'Check for the first copy before building';
export interface TicketLine {
  readonly text: string;
  readonly role: 'heading' | 'reference' | 'reprint' | 'name' | 'body' | 'end';
}
export function localTicketTime(createdAt: string, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(createdAt));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)!.value;
  return `${part('weekday')} ${part('month')}/${part('day')} · ${part('hour')}:${part('minute')} ${part('dayPeriod')}`;
}

/** Wrap words, including uninterrupted names, without splitting Unicode code points. */
export function wrapText(value: string, columns: number): string[] {
  if (!Number.isInteger(columns) || columns < 1)
    throw new Error('Invalid line width.');
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const chars = Array.from(word);
    if (line && Array.from(line).length + chars.length + 1 > columns) {
      lines.push(line);
      line = '';
    }
    while (chars.length > columns) {
      lines.push(chars.splice(0, columns).join(''));
    }
    if (chars.length) line += (line ? ' ' : '') + chars.join('');
  }
  if (line) lines.push(line);
  return lines;
}
const scoops = (s: OrderTicket['servings'][number]) =>
  s.flavors.reduce((n, p) => n + p.count, 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 'S'}`;

/** Printer-neutral ASCII layout. Times are in the station's local timezone. */
export function formatTicket(
  ticket: OrderTicket,
  reprint = false,
  columns = 42,
): readonly TicketLine[] {
  if (columns < 24 || !Number.isInteger(columns))
    throw new Error('Invalid line width.');
  const lines: TicketLine[] = [];
  const add = (
    value: string,
    role: TicketLine['role'] = 'body',
    indent = '',
  ) => {
    lines.push(
      ...wrapText(value, columns - indent.length).map((text) => ({
        text: indent + text,
        role,
      })),
    );
  };
  const rule = (char: string) =>
    lines.push({ text: char.repeat(columns), role: 'body' });
  if (reprint) {
    add('REPRINT', 'reprint');
    add(reprintWarning);
  }
  const date = localTicketTime(ticket.createdAt)
    .replace(' · ', ' ')
    .toUpperCase();
  const gap = columns - 'PREP TICKET'.length - date.length;
  if (gap >= 1)
    lines.push({
      text: 'PREP TICKET' + ' '.repeat(gap) + date,
      role: 'heading',
    });
  else {
    add('PREP TICKET', 'heading');
    add(date);
  }
  add(`ORDER #${ticket.reference}`, 'reference');
  add(ticket.displayName.toUpperCase(), 'name');
  add(
    `${plural(ticket.servings.length, 'SERVING')} | ${plural(
      ticket.servings.reduce((n, s) => n + scoops(s), 0),
      'SCOOP',
    )}`,
  );
  rule('=');
  ticket.servings.forEach((serving, i) => {
    add(`SERVING ${i + 1} OF ${ticket.servings.length}`);
    add(
      `${plural(scoops(serving), 'SCOOP')} - ${serving.container.toUpperCase()}`,
      'body',
      '    ',
    );
    serving.flavors.forEach((p) =>
      add(`${p.count} x ${p.flavor}`, 'body', '    '),
    );
    add(
      `TOPPINGS: ${serving.toppings.join(', ') || 'No toppings'}`,
      'body',
      '    ',
    );
    rule(i === ticket.servings.length - 1 ? '=' : '-');
  });
  add('END OF TICKET', 'end');
  add(`Ticket ID: ${ticket.id}`);
  if (lines.length > maxTicketLines)
    throw new Error(
      'Ticket exceeds the 240-line length limit. Remove a serving before printing.',
    );
  return Object.freeze(lines.map((line) => Object.freeze(line)));
}
export function ticketText(ticket: OrderTicket, reprint = false): string {
  return formatTicket(ticket, reprint)
    .map((line) => line.text)
    .join('\n');
}

export type ReceiptNode =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly size: number;
      readonly height: number;
      readonly align: 'left' | 'center' | 'right';
      readonly inverse: boolean;
      readonly bold: boolean;
    }
  | {
      readonly kind: 'box';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly filled: boolean;
      readonly stroke: number;
    }
  | {
      readonly kind: 'rule';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly stroke: number;
      readonly dashed: boolean;
    };
export interface PrepTicketLayout {
  readonly nodes: readonly ReceiptNode[];
  readonly height: number;
  readonly heightMm: number;
}

/** Absolute geometry shared by raster HTML and PDF. No DOM, font lookup or transport. */
export function prepTicketLayout(
  ticket: OrderTicket,
  reprint = false,
): PrepTicketLayout {
  const nodes: ReceiptNode[] = [];
  let y = 28;
  const box = (
    x: number,
    top: number,
    width: number,
    height: number,
    filled = false,
    stroke = 3,
  ) => nodes.push({ kind: 'box', x, y: top, width, height, filled, stroke });
  const rule = (
    top: number,
    stroke: number,
    dashed = false,
    x = 24,
    width = 528,
  ) => nodes.push({ kind: 'rule', x, y: top, width, stroke, dashed });
  const text = (
    value: string,
    x: number,
    top: number,
    width: number,
    size: number,
    height: number,
    align: 'left' | 'center' | 'right' = 'left',
    inverse = false,
    bold = true,
  ) => {
    const lines = wrapText(
      value,
      Math.max(1, Math.floor((width + 0.001) / (size * 0.65))),
    );
    lines.forEach((text, i) =>
      nodes.push({
        kind: 'text',
        text,
        x,
        y: top + i * height,
        width,
        size,
        height,
        align,
        inverse,
        bold,
      }),
    );
    return lines.length * height;
  };
  if (reprint) {
    box(24, y, 528, 106, true, 0);
    text('REPRINT', 42, y + 10, 492, 44, 50, 'center', true);
    text(reprintWarning, 42, y + 66, 492, 18, 26, 'center', true);
    y += 128;
  }
  text('PREP TICKET', 24, y, 150, 20, 26);
  text(localTicketTime(ticket.createdAt), 182, y, 370, 18, 26, 'right');
  y += 32;
  const referenceSize = Math.min(
    156,
    528 / (Array.from(`#${ticket.reference}`).length * 0.65),
  );
  text(`#${ticket.reference}`, 24, y, 528, referenceSize, 172);
  y += 172;
  y += text(ticket.displayName.toUpperCase(), 24, y, 528, 54, 64);
  y += 18;
  box(24, y, 528, 60);
  box(288, y, 0, 60, false, 3);
  text(plural(ticket.servings.length, 'SERVING'), 38, y + 12, 236, 26, 36);
  text(
    plural(
      ticket.servings.reduce((n, s) => n + scoops(s), 0),
      'SCOOP',
    ),
    302,
    y + 12,
    236,
    26,
    36,
  );
  y += 82;
  rule(y, 8);
  y += 28;
  ticket.servings.forEach((serving, i) => {
    text(
      `SERVING ${i + 1} OF ${ticket.servings.length}`,
      24,
      y + 5,
      528,
      24,
      32,
    );
    y += 54;
    box(24, y, 60, 58, true, 0);
    text(String(scoops(serving)), 24, y + 3, 60, 46, 52, 'center', true);
    const container = `${scoops(serving) === 1 ? 'SCOOP' : 'SCOOPS'} · ${serving.container.toUpperCase()}`;
    text(
      container,
      98,
      y + 6,
      454,
      Math.min(44, 454 / (container.length * 0.65)),
      50,
    );
    y += 72;
    serving.flavors.forEach((portion) => {
      text(`${portion.count} ×`, 28, y, 72, 36, 46);
      y += text(portion.flavor, 110, y, 442, 36, 46);
    });
    y += 14;
    rule(y, 2);
    y += 12;
    text('TOPPINGS', 24, y + 4, 150, 20, 32);
    y += Math.max(
      40,
      text(
        serving.toppings.join(', ') || 'No toppings',
        188,
        y,
        364,
        30,
        41,
        'left',
        false,
        serving.toppings.length > 0,
      ),
    );
    y += 24;
    rule(
      y,
      i === ticket.servings.length - 1 ? 8 : 3,
      i !== ticket.servings.length - 1,
    );
    y += 28;
  });
  y += text('END OF TICKET', 24, y, 528, 22, 30, 'center');
  y +=
    text(
      `Ticket ID: ${ticket.id}`,
      24,
      y + 6,
      528,
      18,
      26,
      'center',
      false,
      false,
    ) + 46;
  const heightMm = Math.ceil(y / pixelsPerMm);
  if (heightMm > maxReceiptHeightMm)
    throw new Error(
      'Ticket exceeds the 2000 mm receipt length limit. Remove a serving before printing.',
    );
  return Object.freeze({
    nodes: Object.freeze(nodes.map((node) => Object.freeze(node))),
    height: heightMm * pixelsPerMm,
    heightMm,
  });
}

/** Reserve the warning space so every accepted ticket can also be reprinted. */
export function assertPrintable(ticket: OrderTicket): void {
  formatTicket(ticket, true);
  formatTicket(ticket, true, 36);
  prepTicketLayout(ticket, true);
}
