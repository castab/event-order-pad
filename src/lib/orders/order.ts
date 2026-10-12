import { parseTicket, type OrderTicket } from '../tickets/ticket';

export interface QueueOrder {
  readonly ticket: OrderTicket;
  readonly submittedAt: string;
  readonly status: 'open' | 'done';
  readonly doneAt?: string;
}

export function parseOrder(value: unknown): QueueOrder {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid queue order.');
  const v = value as QueueOrder;
  const timestamp = (date: unknown): date is string =>
    typeof date === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString() === date;
  if (
    !timestamp(v.submittedAt) ||
    !['open', 'done'].includes(v.status) ||
    (v.status === 'done' ? !timestamp(v.doneAt) : v.doneAt !== undefined)
  )
    throw new Error('Invalid queue status or timestamp.');
  return Object.freeze({
    ticket: parseTicket(v.ticket),
    submittedAt: v.submittedAt,
    status: v.status,
    ...(v.status === 'done' ? { doneAt: v.doneAt } : {}),
  });
}

export function sortOrders(
  orders: readonly QueueOrder[],
  status: 'open' | 'done',
): QueueOrder[] {
  return orders
    .filter((o) => o.status === status)
    .sort(
      (a, b) =>
        (status === 'open'
          ? a.submittedAt.localeCompare(b.submittedAt)
          : b.doneAt!.localeCompare(a.doneAt!)) ||
        a.ticket.id.localeCompare(b.ticket.id),
    );
}

export function waitMinutes(order: QueueOrder, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(order.submittedAt)) / 60000));
}
export function waitLabel(minutes: number): string {
  return minutes < 1 ? 'Just now' : `${minutes} min`;
}
export function waitTone(minutes: number): 'moss' | 'olive' | 'rust' {
  return minutes < 5 ? 'moss' : minutes < 10 ? 'olive' : 'rust';
}
