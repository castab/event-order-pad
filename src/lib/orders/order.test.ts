import { describe, expect, it } from 'vitest';
import {
  parseOrder,
  sortOrders,
  waitMinutes,
  waitLabel,
  waitTone,
} from './order';
import { sampleTicket } from '../tickets/ticket';
const ticket = sampleTicket('ticket-43', '2026-10-11T20:00:00.000Z');
const order = parseOrder({
  ticket,
  submittedAt: ticket.createdAt,
  status: 'open',
});
describe('queue orders and wait labels', () => {
  it('validates frozen tickets, status and exact timestamps', () => {
    expect(Object.isFrozen(order)).toBe(true);
    expect(Object.isFrozen(order.ticket.servings[0])).toBe(true);
    for (const value of [
      null,
      {},
      { ...order, status: 'pending' },
      { ...order, submittedAt: 'bad' },
      { ...order, submittedAt: '2026-02-31T20:00:00.000Z' },
      { ...order, doneAt: ticket.createdAt },
      { ...order, status: 'done' },
      { ...order, ticket: { ...ticket, servings: [] } },
    ])
      expect(() => parseOrder(value)).toThrow();
    expect(
      parseOrder({ ...order, status: 'done', doneAt: ticket.createdAt }).status,
    ).toBe('done');
  });
  it.each([
    [-1, 0, 'Just now', 'moss'],
    [0, 0, 'Just now', 'moss'],
    [59999, 0, 'Just now', 'moss'],
    [60000, 1, '1 min', 'moss'],
    [299999, 4, '4 min', 'moss'],
    [300000, 5, '5 min', 'olive'],
    [599999, 9, '9 min', 'olive'],
    [600000, 10, '10 min', 'rust'],
  ])(
    'maps elapsed %i ms to wait labels and tones',
    (elapsed, minutes, label, tone) => {
      const wait = waitMinutes(
        order,
        Date.parse(order.submittedAt) + Number(elapsed),
      );
      expect(wait).toBe(minutes);
      expect(waitLabel(wait)).toBe(label);
      expect(waitTone(wait)).toBe(tone);
    },
  );
  it('sorts open oldest first and done newest first with stable ties', () => {
    const newer = parseOrder({
      ...order,
      ticket: { ...ticket, id: 'z' },
      submittedAt: '2026-10-11T20:01:00.000Z',
    });
    const done = parseOrder({
      ...order,
      status: 'done',
      doneAt: '2026-10-11T20:02:00.000Z',
    });
    const laterDone = parseOrder({
      ...newer,
      status: 'done',
      doneAt: '2026-10-11T20:03:00.000Z',
    });
    expect(sortOrders([newer, done, order, laterDone], 'open')).toEqual([
      order,
      newer,
    ]);
    expect(sortOrders([newer, done, order, laterDone], 'done')).toEqual([
      laterDone,
      done,
    ]);
  });
});
