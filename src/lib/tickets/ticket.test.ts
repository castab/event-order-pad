import { describe, expect, it } from 'vitest';
import { parseTicket, sampleTicket } from './ticket';
import { formatTicket, ticketText } from './format';

const ticket = sampleTicket('stable-ticket-id', '2026-10-09T20:00:00.000Z');
describe('ticket validation and shared layout', () => {
  it('keeps immutable identifiers and nested items', () => {
    expect(Object.isFrozen(ticket)).toBe(true);
    expect(Object.isFrozen(ticket.items[0].modifiers)).toBe(true);
    expect(ticket.id).toBe('stable-ticket-id');
  });
  it.each([0, -1, 1.5, 100, '2'])('rejects invalid quantity %s', (quantity) => {
    expect(() =>
      parseTicket({ ...ticket, items: [{ ...ticket.items[0], quantity }] }),
    ).toThrow('Quantity');
  });
  it('rejects missing items, invalid dates and control characters', () => {
    expect(() => parseTicket({ ...ticket, items: [] })).toThrow();
    expect(() => parseTicket({ ...ticket, createdAt: 'yesterday' })).toThrow();
    expect(() =>
      parseTicket({ ...ticket, createdAt: '2026-02-30T20:00:00.000Z' }),
    ).toThrow();
    expect(() => parseTicket({ ...ticket, notes: 'hello\x1bcut' })).toThrow();
  });
  it('formats quantities, modifiers, instructions and the end marker', () => {
    const output = ticketText(ticket);
    expect(output).toContain('ORDER #0042');
    expect(output).toContain('2 x Vanilla ice cream');
    expect(output).toContain('  + Waffle cone');
    expect(output).toContain('  PLEASE: Sprinkles on one cone only.');
    expect(output).toContain('--- END OF TICKET ---');
  });
  it('wraps long words and notes without truncating content', () => {
    const long = parseTicket({
      ...ticket,
      notes: 'A'.repeat(150) + ' ' + 'long note '.repeat(35),
    });
    const lines = formatTicket(long);
    expect(lines.every((line) => line.text.length <= 42)).toBe(true);
    expect(
      lines
        .map((line) => line.text)
        .join('')
        .replace(/\s/g, ''),
    ).toContain('A'.repeat(150));
  });
  it('omits empty optional notes and marks a reprint without mutating the ticket', () => {
    const noNotes = parseTicket({
      ...ticket,
      notes: '  ',
      items: [{ ...ticket.items[0], instructions: '' }],
    });
    expect(ticketText(noNotes)).not.toContain('NOTE:');
    expect(ticketText(noNotes)).not.toContain('PLEASE:');
    expect(ticketText(ticket, true)).toMatch(/^REPRINT\n/);
    expect(ticketText(ticket, true)).toContain(ticket.id);
    expect(ticketText(ticket)).not.toContain('REPRINT');
  });
});
