import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Orders, OrderNotFound } from './orders';
import { sampleTicket } from '../src/lib/tickets/ticket';

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function folder() {
  const path = await mkdtemp(join(tmpdir(), 'order-pad-orders-'));
  directories.push(path);
  return path;
}
const ticket = sampleTicket('ticket-43', '2026-10-11T20:00:00.000Z');

describe('durable build orders', () => {
  it('serializes overlapping creation, persists exactly once and does not replace the first ticket', async () => {
    const directory = await folder();
    const orders = new Orders(directory, () => '2026-10-12T19:00:00.000Z');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => orders.upsert(ticket)),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(
      (await readdir(directory)).filter((f) => f.endsWith('.json')),
    ).toHaveLength(1);
    const changed = await orders.upsert({
      ...ticket,
      customerName: 'Changed',
      displayName: 'Changed',
    });
    expect(changed.created).toBe(false);
    expect(changed.order.ticket).toEqual(ticket);
    expect(changed.order.submittedAt).toBe(ticket.createdAt);
    expect(Object.isFrozen(changed.order)).toBe(true);
    expect(await new Orders(directory).list()).toEqual(await orders.list());
  });
  it('persists done and undo across restarts, keeps the first time and never reopens on repeated upserts', async () => {
    const directory = await folder();
    let now = '2026-10-12T19:00:00.000Z';
    let orders = new Orders(directory, () => now);
    const first = (await orders.upsert(ticket)).order;
    now = '2026-10-12T19:05:00.000Z';
    const done = await orders.setStatus(ticket.id, 'done');
    now = '2026-10-12T19:06:00.000Z';
    expect(await orders.setStatus(ticket.id, 'done')).toEqual(done);
    orders = new Orders(directory, () => now);
    expect((await orders.upsert(ticket)).order).toEqual(done);
    expect(await orders.list('open')).toEqual([]);
    const reopened = await orders.setStatus(ticket.id, 'open');
    expect(reopened).toEqual(first);
    expect(await orders.setStatus(ticket.id, 'open')).toEqual(first);
    expect(await new Orders(directory).list('open')).toEqual([first]);
    expect(await orders.list('done')).toEqual([]);
    await expect(orders.setStatus('missing', 'done')).rejects.toBeInstanceOf(
      OrderNotFound,
    );
  });
  it('keeps the most recent eight done records visible without forgetting older identities', async () => {
    const directory = await folder();
    let minute = 0;
    const orders = new Orders(
      directory,
      () => `2026-10-12T19:${String(minute++).padStart(2, '0')}:00.000Z`,
    );
    for (let n = 0; n < 10; n++) {
      const value = { ...ticket, id: `ticket-${n}`, reference: String(n + 1) };
      await orders.upsert(value);
      await orders.setStatus(value.id, 'done');
    }
    const recent = await orders.list('done');
    expect(recent).toHaveLength(8);
    expect(recent[0].ticket.id).toBe('ticket-9');
    expect(recent.at(-1)!.ticket.id).toBe('ticket-2');
    const older = await new Orders(directory).upsert({
      ...ticket,
      id: 'ticket-0',
      reference: '0001',
    });
    expect(older.created).toBe(false);
    expect(older.order.status).toBe('done');
    expect(await orders.list('open')).toEqual([]);
  });
  it('orders by first submission and serializes simultaneous transitions', async () => {
    const directory = await folder();
    let now = '2026-10-12T19:05:00.000Z';
    const orders = new Orders(directory, () => now);
    await orders.upsert({ ...ticket, id: 'newer', createdAt: now });
    now = '2026-10-12T19:00:00.000Z';
    await orders.upsert({ ...ticket, id: 'older', createdAt: now });
    expect((await orders.list('open')).map((o) => o.ticket.id)).toEqual([
      'older',
      'newer',
    ]);
    await Promise.all([
      orders.setStatus('older', 'done'),
      orders.upsert({ ...ticket, id: 'older' }),
      orders.setStatus('older', 'open'),
    ]);
    expect(
      (await new Orders(directory).list('open')).map((o) => o.ticket.id),
    ).toEqual(['older', 'newer']);
  });
  it('uses hashed filenames for arbitrary validated IDs and ignores interrupted temporary writes', async () => {
    const directory = await folder();
    const orders = new Orders(directory);
    await orders.upsert({ ...ticket, id: '../path/with spaces' });
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    await writeFile(join(directory, 'interrupted.tmp'), '{');
    expect(await new Orders(directory).list()).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(directory, files[0]), 'utf8')).ticket.id,
    ).toBe('../path/with spaces');
  });
  it('rejects corruption or unwritable storage without losing existing records or treating it as empty', async () => {
    const directory = await folder();
    const orders = new Orders(directory);
    await orders.upsert(ticket);
    await writeFile(join(directory, 'broken.json'), '{');
    await expect(new Orders(directory).list()).rejects.toThrow();
    await rm(join(directory, 'broken.json'));
    expect(await new Orders(directory).list()).toHaveLength(1);
    const file = join(directory, 'not-a-directory');
    await writeFile(file, 'blocked');
    await expect(new Orders(file).upsert(ticket)).rejects.toThrow();
    expect(await new Orders(directory).list()).toHaveLength(1);
  });
});

it('subscribes atomically, broadcasts immutable ordered snapshots, and ignores no-ops', async () => {
  const orders = new Orders(await folder());
  const seen: import('../src/lib/orders/live').QueueSnapshot[] = [];
  const other: import('../src/lib/orders/live').QueueSnapshot[] = [];
  const unsubscribe = await orders.subscribe((s) => seen.push(s));
  expect(seen[0]).toMatchObject({ revision: 0, orders: [] });
  await orders.upsert(ticket);
  const unsubscribeOther = await orders.subscribe((s) => other.push(s));
  const done = await orders.changeStatus(ticket.id, 'done');
  expect(done).toMatchObject({
    instanceId: seen[0].instanceId,
    revision: 2,
    order: { status: 'done' },
  });
  await orders.upsert(ticket);
  await orders.setStatus(ticket.id, 'done');
  expect(seen.map((s) => s.revision)).toEqual([0, 1, 2]);
  expect(other.map((s) => s.revision)).toEqual([1, 2]);
  expect(Object.isFrozen(seen[1].orders[0].ticket.servings)).toBe(true);
  unsubscribe();
  await orders.setStatus(ticket.id, 'open');
  expect(seen).toHaveLength(3);
  expect(other.at(-1)!.revision).toBe(3);
  unsubscribeOther();
});
it('subscriptions queued amid mutations cannot miss commits and failed writes emit nothing', async () => {
  const directory = await folder();
  const orders = new Orders(directory);
  const seen: import('../src/lib/orders/live').QueueSnapshot[] = [];
  const first = orders.upsert(ticket);
  const subscription = orders.subscribe((s) => seen.push(s));
  const done = orders.setStatus(ticket.id, 'done');
  await first;
  const unsubscribe = await subscription;
  await done;
  expect(seen.map((s) => s.revision)).toEqual([1, 2]);
  await rm(directory, { recursive: true });
  await writeFile(directory, 'unwritable');
  await expect(orders.setStatus(ticket.id, 'open')).rejects.toThrow();
  expect(seen).toHaveLength(2);
  unsubscribe();
});
it('a restart supplies a fresh instance ID and a complete disk snapshot without historical replay', async () => {
  const directory = await folder();
  const orders = new Orders(directory);
  await orders.upsert(ticket);
  await orders.setStatus(ticket.id, 'done');
  let first!: import('../src/lib/orders/live').QueueSnapshot;
  const stop = await orders.subscribe((s) => {
    first = s;
  });
  stop();
  let reloaded!: import('../src/lib/orders/live').QueueSnapshot;
  const unsubscribe = await new Orders(directory).subscribe((s) => {
    reloaded = s;
  });
  unsubscribe();
  expect(reloaded.instanceId).not.toBe(first.instanceId);
  expect(reloaded.revision).toBe(0);
  expect(reloaded.orders).toEqual(first.orders);
});
