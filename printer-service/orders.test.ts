import { expect, it, vi } from 'vitest';
import { Orders, OrderNotFound } from './orders';
import {
  MemoryOrderRepository,
  testCaptureFrom,
} from '../tests/helpers/order-repository';
import { sampleTicket } from '../src/lib/tickets/ticket';
import type { QueueSnapshot } from '../src/lib/orders/live';

const ticket = sampleTicket('ticket-43', '2026-10-11T20:00:00.000Z');

it('serializes creation, preserves the first ticket, and never reopens duplicate submissions', async () => {
  const repository = new MemoryOrderRepository();
  const orders = new Orders(
    repository,
    testCaptureFrom,
    () => ticket.createdAt,
  );
  const results = await Promise.all(
    Array.from({ length: 10 }, () => orders.upsert(ticket)),
  );
  expect(results.filter((r) => 'created' in r && r.created)).toHaveLength(1);
  const done = await orders.setStatus(ticket.id, 'done');
  expect(
    await orders.upsert({
      ...ticket,
      displayName: 'Changed',
      customerName: 'Changed',
    }),
  ).toEqual({ created: false, order: done });
  expect(await orders.list('open')).toEqual([]);
  expect(await new Orders(repository, testCaptureFrom).list()).toEqual([done]);
  await expect(orders.setStatus('missing', 'done')).rejects.toBeInstanceOf(
    OrderNotFound,
  );
});

it('excludes older submissions without touching storage and includes the cutoff boundary', async () => {
  const repository = new MemoryOrderRepository();
  const upsert = vi.spyOn(repository, 'upsert');
  const orders = new Orders(repository, ticket.createdAt);
  const old = { ...ticket, id: 'old', createdAt: '2026-10-11T19:59:59.999Z' };
  expect(await orders.upsert(old)).toEqual({
    excluded: true,
    ticketId: old.id,
  });
  expect(upsert).not.toHaveBeenCalled();
  expect(await orders.upsert(ticket)).toMatchObject({ created: true });
  expect(() => new Orders(repository, 'invalid')).toThrow(
    'ORDER_PAD_CAPTURE_FROM',
  );
});

it('subscribes atomically, broadcasts ordered frozen snapshots, and ignores no-ops', async () => {
  const orders = new Orders(
    new MemoryOrderRepository(),
    testCaptureFrom,
    () => ticket.createdAt,
  );
  const seen: QueueSnapshot[] = [];
  const first = orders.upsert(ticket);
  const subscription = orders.subscribe((s) => seen.push(s));
  const done = orders.changeStatus(ticket.id, 'done');
  await first;
  const unsubscribe = await subscription;
  expect(await done).toMatchObject({ revision: 2, order: { status: 'done' } });
  await orders.upsert(ticket);
  await orders.setStatus(ticket.id, 'done');
  expect(seen.map((s) => s.revision)).toEqual([1, 2]);
  expect(Object.isFrozen(seen[0].orders[0].ticket.servings)).toBe(true);
  unsubscribe();
  await orders.setStatus(ticket.id, 'open');
  expect(seen).toHaveLength(2);
});

it('does not advance or broadcast failed writes, and broadcasts again after recovery', async () => {
  const repository = new MemoryOrderRepository();
  const orders = new Orders(repository, testCaptureFrom);
  const seen: QueueSnapshot[] = [];
  await orders.subscribe((s) => seen.push(s));
  vi.spyOn(repository, 'upsert').mockRejectedValueOnce(
    new Error('Database unavailable'),
  );
  await expect(orders.upsert(ticket)).rejects.toThrow();
  expect(seen.map((s) => s.revision)).toEqual([0]);
  await orders.subscribe((s) => seen.push(s));
  expect(seen[1].instanceId).not.toBe(seen[0].instanceId);
  await orders.upsert(ticket);
  expect(seen.map((s) => s.revision)).toEqual([0, 0, 1]);
});

it('keeps committed mutations successful and disconnects subscriptions if snapshot loading fails', async () => {
  const repository = new MemoryOrderRepository();
  const orders = new Orders(repository, testCaptureFrom);
  const unavailable = vi.fn();
  await orders.subscribe(vi.fn(), unavailable);
  vi.spyOn(repository, 'list').mockRejectedValueOnce(
    new Error('Connection lost after commit'),
  );
  expect(await orders.upsert(ticket)).toMatchObject({ created: true });
  expect(unavailable).toHaveBeenCalledTimes(1);
  expect(await orders.list('open')).toHaveLength(1);
  let snapshot!: QueueSnapshot;
  await orders.subscribe((s) => {
    snapshot = s;
  });
  expect(snapshot.revision).toBe(1);
});

it('a restart supplies a fresh instance ID and the complete current database state', async () => {
  const repository = new MemoryOrderRepository();
  const orders = new Orders(
    repository,
    testCaptureFrom,
    () => ticket.createdAt,
  );
  await orders.upsert(ticket);
  await orders.setStatus(ticket.id, 'done');
  let first!: QueueSnapshot;
  let reloaded!: QueueSnapshot;
  (
    await orders.subscribe((s) => {
      first = s;
    })
  )();
  (
    await new Orders(repository, testCaptureFrom).subscribe((s) => {
      reloaded = s;
    })
  )();
  expect(reloaded.instanceId).not.toBe(first.instanceId);
  expect(reloaded.revision).toBe(0);
  expect(reloaded.orders).toEqual(first.orders);
});

it('bounds waiting behind a slow database operation and never executes an expired queued write', async () => {
  vi.useFakeTimers();
  try {
    const repository = new MemoryOrderRepository();
    const save = repository.upsert.bind(repository);
    let release!: () => void;
    const upsert = vi
      .spyOn(repository, 'upsert')
      .mockImplementationOnce(async (value) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return save(value);
      });
    const orders = new Orders(repository, testCaptureFrom);
    const first = orders.upsert(ticket);
    await Promise.resolve();
    const expired = orders.upsert({ ...ticket, id: 'expired' });
    const rejected = expect(expired).rejects.toThrow('waited too long');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    release();
    await first;
    expect(await orders.list('open')).toHaveLength(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('recovers a committed write with a lost reply through a fresh snapshot and an idempotent retry', async () => {
  const repository = new MemoryOrderRepository();
  const save = repository.upsert.bind(repository);
  vi.spyOn(repository, 'upsert').mockImplementationOnce(async (value) => {
    await save(value);
    throw new Error('Commit reply lost');
  });
  const orders = new Orders(repository, testCaptureFrom);
  let before!: QueueSnapshot;
  let recovered!: QueueSnapshot;
  const disconnected = vi.fn();
  await orders.subscribe((s) => {
    before = s;
  }, disconnected);
  await expect(orders.upsert(ticket)).rejects.toThrow('Commit reply lost');
  expect(disconnected).toHaveBeenCalledTimes(1);
  expect(await orders.upsert(ticket)).toMatchObject({ created: false });
  await orders.subscribe((s) => {
    recovered = s;
  });
  expect(recovered.instanceId).not.toBe(before.instanceId);
  expect(recovered.orders).toMatchObject([{ ticket, status: 'open' }]);
  expect(repository.records.size).toBe(1);
});

it('retires old versions after an uncertain completion so delayed action replies cannot restore old state', async () => {
  const repository = new MemoryOrderRepository();
  const orders = new Orders(
    repository,
    testCaptureFrom,
    () => ticket.createdAt,
  );
  await orders.upsert(ticket);
  const before = await orders.changeStatus(ticket.id, 'open');
  const change = repository.changeStatus.bind(repository);
  vi.spyOn(repository, 'changeStatus').mockImplementationOnce(
    async (...args) => {
      await change(...args);
      throw new Error('Commit reply lost');
    },
  );
  await expect(orders.changeStatus(ticket.id, 'done')).rejects.toThrow(
    'Commit reply lost',
  );
  let recovered!: QueueSnapshot;
  await orders.subscribe((s) => {
    recovered = s;
  });
  expect(recovered.instanceId).not.toBe(before.instanceId);
  expect(recovered.orders).toMatchObject([{ ticket, status: 'done' }]);
});
