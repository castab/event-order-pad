import { parseOrder, type QueueOrder } from './order';

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
  if (!Array.isArray(data.orders))
    throw new Error('Invalid build queue response.');
  const orders: QueueOrder[] = data.orders.map(parseOrder);
  if (new Set(orders.map((o) => o.ticket.id)).size !== orders.length)
    throw new Error('Duplicate order IDs in queue response.');
  return Object.freeze(orders);
}
export async function changeOrderStatus(
  id: string,
  action: 'done' | 'reopen',
): Promise<QueueOrder> {
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
  const order = parseOrder((await response.json()).order);
  if (
    order.ticket.id !== id ||
    order.status !== (action === 'done' ? 'done' : 'open')
  )
    throw new Error('Order update did not match the request.');
  return order;
}
