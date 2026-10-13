import type { QueueOrder } from './order';
import { parseQueueOrders, parseChange, type OrderChange } from './live';

export async function fetchOrders(
  signal?: AbortSignal,
): Promise<readonly QueueOrder[]> {
  const response = await fetch('/api/orders', {
    cache: 'no-store',
    signal: signal ?? AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      'Build queue unavailable. Check the connection to the Linux service.',
    );
  const data = await response.json();
  return parseQueueOrders(data.orders);
}
export async function changeOrderStatus(
  id: string,
  action: 'done' | 'reopen',
): Promise<OrderChange> {
  const response = await fetch(
    `/api/orders/${encodeURIComponent(id)}/${action}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok)
    throw new Error(
      'Could not update the order. Refresh the queue and try again.',
    );
  const change = parseChange(await response.json());
  const order = change.order;
  if (
    order.ticket.id !== id ||
    order.status !== (action === 'done' ? 'done' : 'open')
  )
    throw new Error('Order update did not match the request.');
  return change;
}
