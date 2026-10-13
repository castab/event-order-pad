import type { OrderRepository } from '../../printer-service/orders';
import { OrderNotFound } from '../../printer-service/orders';
import { parseTicket, type OrderTicket } from '../../src/lib/tickets/ticket';
import {
  parseOrder,
  sortOrders,
  type QueueOrder,
} from '../../src/lib/orders/order';

/** Test fixture only; production order durability belongs to PostgreSQL. */
export class MemoryOrderRepository implements OrderRepository {
  readonly records = new Map<string, QueueOrder>();
  async upsert(value: OrderTicket) {
    const ticket = parseTicket(value);
    const existing = this.records.get(ticket.id);
    if (existing) return { order: existing, created: false };
    const order = parseOrder({
      ticket,
      submittedAt: ticket.createdAt,
      status: 'open',
    });
    this.records.set(ticket.id, order);
    return { order, created: true };
  }
  async changeStatus(id: string, status: 'open' | 'done', at: string) {
    const existing = this.records.get(id);
    if (!existing) throw new OrderNotFound('Order not found.');
    if (existing.status === status) return { order: existing, changed: false };
    const order = parseOrder({
      ticket: existing.ticket,
      submittedAt: existing.submittedAt,
      status,
      ...(status === 'done' ? { doneAt: at } : {}),
    });
    this.records.set(id, order);
    return { order, changed: true };
  }
  async list(status?: 'open' | 'done'): Promise<readonly QueueOrder[]> {
    const records = [...this.records.values()];
    const open = sortOrders(records, 'open');
    const done = sortOrders(records, 'done').slice(0, 8);
    return Object.freeze(
      status === 'open' ? open : status === 'done' ? done : [...open, ...done],
    );
  }
}
export const testCaptureFrom = '2020-01-01T00:00:00.000Z';
