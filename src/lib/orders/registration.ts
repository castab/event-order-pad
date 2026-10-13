import { parseOrder, type QueueOrder } from './order';

export type OrderRegistration =
  | { readonly order: QueueOrder; readonly created: boolean }
  | { readonly excluded: true; readonly ticketId: string };

/** Accept only a matching durable order or an explicit cutoff exclusion. */
export function parseRegistration(
  value: unknown,
  ticketId: string,
): OrderRegistration {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid order acknowledgment.');
  const v = value as Record<string, unknown>;
  if (
    v.excluded === true &&
    v.ticketId === ticketId &&
    v.order === undefined &&
    v.created === undefined
  )
    return Object.freeze({ excluded: true, ticketId });
  if (v.excluded !== undefined || typeof v.created !== 'boolean')
    throw new Error('Invalid order acknowledgment.');
  const order = parseOrder(v.order);
  if (order.ticket.id !== ticketId)
    throw new Error('Order acknowledgment did not match.');
  return Object.freeze({ order, created: v.created });
}
