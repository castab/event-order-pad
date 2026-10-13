import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrderStream } from './order-stream';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function setup() {
  const response = Object.assign(new EventEmitter(), {
    write: vi.fn((_chunk: string) => true),
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    destroy: vi.fn(),
  });
  const unsubscribe = vi.fn();
  const removed = vi.fn();
  const stream = new OrderStream(
    response as unknown as ServerResponse,
    removed,
  );
  const snapshot = (revision: number) =>
    stream.snapshot({
      instanceId: '00000000-0000-4000-8000-000000000001',
      revision,
      orders: [],
    });
  return { stream, response, unsubscribe, removed, snapshot };
}
it('sets streaming headers, sends initial/latest data, retry and 15-second heartbeats', () => {
  const s = setup();
  s.snapshot(0);
  s.stream.start(s.unsubscribe);
  expect(s.response.writeHead).toHaveBeenCalledWith(
    200,
    expect.objectContaining({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    }),
  );
  expect(s.response.write.mock.calls.map(([c]) => c)).toEqual([
    'retry: 3000\n\n',
    expect.stringContaining('event: orders\n'),
  ]);
  vi.advanceTimersByTime(15000);
  expect(s.response.write).toHaveBeenLastCalledWith(
    'event: ping\ndata: {}\n\n',
  );
  s.stream.dispose();
  expect(s.unsubscribe).toHaveBeenCalledOnce();
  expect(s.removed).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('retains only the newest snapshot during backpressure and resumes on drain', () => {
  const s = setup();
  s.snapshot(0);
  s.stream.start(s.unsubscribe);
  s.response.write.mockReturnValueOnce(false);
  s.snapshot(1);
  s.snapshot(2);
  s.snapshot(3);
  expect(s.response.write).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(15000);
  expect(s.response.write).toHaveBeenCalledTimes(3);
  s.response.emit('drain');
  expect(s.response.write).toHaveBeenLastCalledWith(
    expect.stringContaining('"revision":3'),
  );
  expect(
    s.response.write.mock.calls.some(([c]) => c.includes('"revision":2')),
  ).toBe(false);
  s.stream.dispose();
});
it('disconnects after 30 seconds of backpressure and cleans up pending subscriptions', () => {
  const s = setup();
  s.snapshot(0);
  s.response.write.mockReturnValue(false);
  s.stream.start(s.unsubscribe);
  vi.advanceTimersByTime(29999);
  expect(s.response.destroy).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(s.response.destroy).toHaveBeenCalledOnce();
  expect(s.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
it('handles disconnect before registration completes and isolates write errors', () => {
  const s = setup();
  s.response.emit('close');
  s.stream.start(s.unsubscribe);
  expect(s.unsubscribe).toHaveBeenCalledOnce();
  expect(s.response.write).not.toHaveBeenCalled();
  const t = setup();
  t.response.write.mockImplementation(() => {
    throw new Error('closed socket');
  });
  t.snapshot(0);
  expect(() => t.stream.start(t.unsubscribe)).not.toThrow();
  expect(t.unsubscribe).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
