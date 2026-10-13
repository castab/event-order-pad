import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueueFeed, type QueueFeedState } from './stream';
import { parseSnapshot, parseChange, parseVersion } from './live';
import { parseOrder } from './order';
import { sampleTicket } from '../tickets/ticket';

const instanceId = '00000000-0000-4000-8000-000000000001';
const secondInstance = '00000000-0000-4000-8000-000000000002';
const open = parseOrder({
  ticket: sampleTicket('t', '2026-10-12T19:00:00.000Z'),
  status: 'open',
  submittedAt: '2026-10-12T19:00:00.000Z',
});
const done = parseOrder({
  ...open,
  status: 'done',
  doneAt: '2026-10-12T19:01:00.000Z',
});
class Source extends EventTarget {
  close = vi.fn();
  emit(type: string, data?: unknown) {
    this.dispatchEvent(
      data === undefined
        ? new Event(type)
        : new MessageEvent(type, { data: JSON.stringify(data) }),
    );
  }
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const sources: Source[] = [];
  let state!: QueueFeedState;
  const factory = vi.fn(() => {
    const source = new Source();
    sources.push(source);
    return source as unknown as EventSource;
  });
  const feed = new QueueFeed((s) => {
    state = s;
  }, factory);
  feed.start();
  const snapshot = (
    revision: number,
    orders = [open],
    id = instanceId,
    source = sources.at(-1)!,
  ) => source.emit('orders', { instanceId: id, revision, orders });
  return { feed, sources, factory, snapshot, state: () => state };
}
it('validates versions, snapshots, unique IDs and deep immutability', () => {
  for (const revision of [
    -1,
    1.2,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    undefined,
  ])
    expect(() => parseVersion({ instanceId, revision })).toThrow();
  expect(() => parseVersion({ instanceId: 'wrong', revision: 0 })).toThrow();
  for (const orders of [
    undefined,
    {},
    [open, open],
    [{ ...open, status: 'wrong' }],
  ])
    expect(() => parseSnapshot({ instanceId, revision: 1, orders })).toThrow();
  const snapshot = parseSnapshot({ instanceId, revision: 1, orders: [open] });
  expect(Object.isFrozen(snapshot.orders[0].ticket.servings[0].flavors)).toBe(
    true,
  );
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(
    Object.isFrozen(parseChange({ instanceId, revision: 1, order: done })),
  ).toBe(true);
});
it('receives snapshots without fetching and clears connection errors only on valid data', () => {
  const s = setup();
  expect(s.factory).toHaveBeenCalledWith('/api/orders/events');
  s.sources[0].emit('error');
  expect(s.state().loaded).toBe(false);
  s.sources[0].emit('open');
  s.sources[0].emit('ping', {});
  expect(s.state().error).toContain('disconnected');
  s.snapshot(0, []);
  expect(s.state()).toMatchObject({
    orders: [],
    loaded: true,
    connecting: false,
    error: '',
  });
  s.snapshot(1);
  expect(s.state().orders).toEqual([open]);
  s.feed.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it('keeps confirmed changes through stale snapshots, but equal-version snapshots still replace the full view', () => {
  const s = setup();
  s.snapshot(1);
  s.feed.applyChange({ instanceId, revision: 3, order: done });
  s.snapshot(2);
  expect(s.state().orders).toEqual([done]);
  const other = parseOrder({
    ...open,
    ticket: { ...open.ticket, id: 'other' },
  });
  s.snapshot(3, [other, done]);
  expect(s.state().orders).toEqual([other, done]);
  s.feed.applyChange({ instanceId, revision: 2, order: open });
  expect(s.state().orders).toEqual([other, done]);
  s.feed.stop();
});
it('resynchronizes after a restart and ignores responses/events from retired instances or connections', () => {
  const s = setup();
  s.snapshot(10);
  s.sources[0].emit('error');
  s.snapshot(0, [done], secondInstance);
  s.feed.applyChange({ instanceId, revision: 11, order: open });
  s.snapshot(12);
  expect(s.state().orders).toEqual([done]);
  s.feed.refresh();
  expect(s.sources[0].close).toHaveBeenCalledOnce();
  s.snapshot(99, [], secondInstance, s.sources[0]);
  expect(s.state().orders).toEqual([done]);
  s.snapshot(1, [], secondInstance);
  expect(s.state().orders).toEqual([]);
  s.feed.stop();
});
it('allows confirmed actions during disconnect and reconnects when an action reveals a new service instance', () => {
  const s = setup();
  s.snapshot(1);
  s.sources[0].emit('error');
  s.feed.applyChange({ instanceId, revision: 2, order: done });
  expect(s.state().orders).toEqual([done]);
  expect(s.state().error).toContain('disconnected');
  s.feed.applyChange({ instanceId: secondInstance, revision: 0, order: open });
  expect(s.factory).toHaveBeenCalledTimes(2);
  s.snapshot(0, [open], secondInstance);
  expect(s.state().error).toBe('');
  s.feed.stop();
});
it('retains last valid data on malformed messages and retries after three seconds', () => {
  const s = setup();
  s.snapshot(1);
  s.sources[0].emit('orders', { orders: [] });
  expect(s.state().orders).toEqual([open]);
  expect(s.state().error).toContain('Invalid');
  expect(s.sources[0].close).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(3000);
  s.snapshot(2, [done]);
  expect(s.state().orders).toEqual([done]);
  s.feed.stop();
});
it('heartbeats prevent false stalls; silent links reconnect after 45 seconds and stop cleans everything up', () => {
  const s = setup();
  s.snapshot(0);
  vi.advanceTimersByTime(44000);
  s.sources[0].emit('ping', {});
  vi.advanceTimersByTime(44000);
  expect(s.factory).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(1000);
  expect(s.factory).toHaveBeenCalledTimes(2);
  expect(s.state().orders).toEqual([open]);
  expect(s.state().error).toContain('disconnected');
  s.feed.stop();
  s.snapshot(20, []);
  s.feed.applyChange({ instanceId, revision: 20, order: done });
  vi.advanceTimersByTime(90000);
  expect(s.state().orders).toEqual([open]);
  expect(s.factory).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
it('retries source construction failure and cancellation prevents retry', () => {
  const create = vi.fn(() => {
    throw new Error('Unavailable');
  });
  const feed = new QueueFeed(() => {}, create);
  feed.start();
  vi.advanceTimersByTime(3000);
  expect(create).toHaveBeenCalledTimes(2);
  feed.stop();
  expect(vi.getTimerCount()).toBe(0);
});
