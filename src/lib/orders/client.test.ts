import { afterEach, expect, it, vi } from 'vitest';
import { changeOrderStatus, fetchOrders } from './client';
import { sampleTicket } from '../tickets/ticket';
const order = {
  ticket: sampleTicket('id/with space', '2026-10-12T19:00:00.000Z'),
  submittedAt: '2026-10-12T19:00:00.000Z',
  status: 'done',
  doneAt: '2026-10-12T19:01:00.000Z',
};
const result = {
  order,
  instanceId: '00000000-0000-4000-8000-000000000001',
  revision: 1,
};
afterEach(() => vi.unstubAllGlobals());
it('validates versioned action responses and escapes IDs while preserving POST semantics', async () => {
  const fetch = vi.fn(async () => Response.json(result));
  vi.stubGlobal('fetch', fetch);
  expect(await changeOrderStatus(order.ticket.id, 'done')).toMatchObject(
    result,
  );
  expect(fetch).toHaveBeenCalledWith(
    '/api/orders/id%2Fwith%20space/done',
    expect.objectContaining({ method: 'POST', body: '{}', cache: 'no-store' }),
  );
});
it('rejects failed, mismatched and unversioned status changes without retrying', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const response of [
    Response.json({}, { status: 503 }),
    Response.json({ order }),
    Response.json({
      ...result,
      order: { ...order, ticket: { ...order.ticket, id: 'different' } },
    }),
    Response.json({
      ...result,
      order: { ...order, status: 'open', doneAt: undefined },
    }),
  ]) {
    fetch.mockResolvedValueOnce(response);
    await expect(changeOrderStatus(order.ticket.id, 'done')).rejects.toThrow();
  }
  expect(fetch).toHaveBeenCalledTimes(4);
});
it('retains the legacy list endpoint interface and validation for other callers', async () => {
  const fetch = vi.fn(async () => Response.json({ orders: [order] }));
  vi.stubGlobal('fetch', fetch);
  expect(await fetchOrders()).toHaveLength(1);
  expect(fetch).toHaveBeenCalledWith(
    '/api/orders',
    expect.objectContaining({ cache: 'no-store' }),
  );
});
