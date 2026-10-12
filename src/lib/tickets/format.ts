import type { OrderTicket } from './ticket';

export interface TicketLine {
  readonly text: string;
  readonly role: 'heading' | 'reference' | 'reprint' | 'body' | 'end';
}

/** A small shared text layout, independent of UI and printer command languages. */
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
    const words = value.split(/\s+/).filter(Boolean);
    let line = indent;
    for (const word of words) {
      for (let offset = 0; offset < word.length;) {
        const chunk = word.slice(offset, offset + columns - indent.length);
        if (
          line.length > indent.length &&
          line.length + chunk.length + 1 > columns
        ) {
          lines.push({ text: line, role });
          line = indent;
        }
        line += (line.length > indent.length ? ' ' : '') + chunk;
        offset += chunk.length;
        if (offset < word.length) {
          lines.push({ text: line, role });
          line = indent;
        }
      }
    }
    if (line.length > indent.length) lines.push({ text: line, role });
  };
  if (reprint) add('REPRINT', 'reprint');
  add('PREPARATION TICKET', 'heading');
  add(`ORDER: ${ticket.reference}`, 'reference');
  add(ticket.createdAt.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC'));
  lines.push({ text: '-'.repeat(columns), role: 'body' });
  for (const item of ticket.items) {
    add(`${item.quantity} x ${item.name}`);
    item.modifiers.forEach((modifier) => add(`+ ${modifier}`, 'body', '  '));
    if (item.instructions) add(`PLEASE: ${item.instructions}`, 'body', '  ');
    lines.push({ text: '', role: 'body' });
  }
  if (ticket.notes) {
    add(`NOTE: ${ticket.notes}`);
    lines.push({ text: '', role: 'body' });
  }
  add(`Ticket ID: ${ticket.id}`);
  add('--- END OF TICKET ---', 'end');
  return lines;
}

export function ticketText(ticket: OrderTicket, reprint = false): string {
  return formatTicket(ticket, reprint)
    .map((line) => line.text)
    .join('\n');
}
