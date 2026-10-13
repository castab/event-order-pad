import { parseOrder, type QueueOrder } from './order';

export interface QueueVersion {
  readonly instanceId: string;
  readonly revision: number;
}
export interface QueueSnapshot extends QueueVersion {
  readonly orders: readonly QueueOrder[];
}
export interface OrderChange extends QueueVersion {
  readonly order: QueueOrder;
}
export function parseVersion(value: unknown): QueueVersion {
  const v = value as QueueVersion | undefined;
  if (
    !v ||
    typeof v.instanceId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v.instanceId) ||
    !Number.isSafeInteger(v.revision) ||
    v.revision < 0
  )
    throw new Error('Invalid queue version.');
  return Object.freeze({ instanceId: v.instanceId, revision: v.revision });
}
export function parseQueueOrders(value: unknown): readonly QueueOrder[] {
  if (!Array.isArray(value)) throw new Error('Invalid build queue response.');
  const orders = value.map(parseOrder);
  if (new Set(orders.map((o) => o.ticket.id)).size !== orders.length)
    throw new Error('Duplicate order IDs in queue response.');
  return Object.freeze(orders);
}
export function parseSnapshot(value: unknown): QueueSnapshot {
  return Object.freeze({
    ...parseVersion(value),
    orders: parseQueueOrders((value as QueueSnapshot).orders),
  });
}
export function parseChange(value: unknown): OrderChange {
  return Object.freeze({
    ...parseVersion(value),
    order: parseOrder((value as OrderChange).order),
  });
}
