import { afterEach, expect, it, vi } from 'vitest';
import { OrderPublisher } from './publisher';
import { sampleTicket } from '../tickets/ticket';
const ticket = sampleTicket('ticket-43', '2026-10-11T20:00:00.000Z');
const response = () =>
  Response.json({
    order: {
      ticket,
      submittedAt: ticket.createdAt,
      status: 'done',
      doneAt: ticket.createdAt,
    },
  });
afterEach(() => vi.useRealTimers());

it('retries only the order outbox, acknowledges an existing done order and retains original ticket identity', async () => {
  const pending = [ticket];
  const store = {
    pendingOrders: vi.fn(async () => pending),
    acknowledgeOrder: vi.fn(async () => {
      pending.splice(0);
    }),
  };
  const send = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(response());
  const notice = vi.fn();
  const publisher = new OrderPublisher(store, notice, send);
  await publisher.flush();
  expect(store.acknowledgeOrder).not.toHaveBeenCalled();
  expect(notice).toHaveBeenLastCalledWith(
    expect.stringContaining('no print will be resent'),
  );
  await publisher.flush();
  expect(store.acknowledgeOrder).toHaveBeenCalledWith(ticket.id);
  expect(notice).toHaveBeenLastCalledWith('');
  for (const [path, init] of send.mock.calls) {
    expect(path).toBe('/api/orders');
    expect(JSON.parse(init!.body as string)).toEqual(ticket);
  }
  publisher.stop();
});
it('does not clear unacknowledged updates on failed or mismatched responses', async () => {
  const store = {
    pendingOrders: vi.fn(async () => [ticket]),
    acknowledgeOrder: vi.fn(),
  };
  for (const response of [
    Response.json({}, { status: 503 }),
    Response.json({
      order: {
        ticket: { ...ticket, id: 'other' },
        submittedAt: ticket.createdAt,
        status: 'open',
      },
    }),
    Response.json({ order: {} }),
  ]) {
    const publisher = new OrderPublisher(
      store,
      vi.fn(),
      vi.fn<typeof fetch>().mockResolvedValue(response),
    );
    await publisher.flush();
    publisher.stop();
  }
  expect(store.acknowledgeOrder).not.toHaveBeenCalled();
});
it('serializes publication, retries in the background and stops timers after unmount', async () => {
  vi.useFakeTimers();
  const store = {
    pendingOrders: vi.fn(async () => [ticket]),
    acknowledgeOrder: vi.fn(),
  };
  const send = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
  const publisher = new OrderPublisher(store, vi.fn(), send);
  await Promise.all([publisher.flush(), publisher.flush()]);
  expect(send).toHaveBeenCalledTimes(1);
  publisher.start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(send).toHaveBeenCalledTimes(3);
  publisher.stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(send).toHaveBeenCalledTimes(3);
});
