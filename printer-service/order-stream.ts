import type { ServerResponse } from 'node:http';
import type { QueueSnapshot } from '../src/lib/orders/live';

/** One latest snapshot behind Node's write buffer; never blocks journal writes. */
export class OrderStream {
  private pending?: string;
  private blocked = false;
  private started = false;
  private closed = false;
  private unsubscribe?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private stalled?: ReturnType<typeof setTimeout>;
  constructor(
    private response: ServerResponse,
    private removed: () => void,
  ) {
    response.on('close', this.dispose);
    response.on('error', this.dispose);
    response.on('drain', this.drain);
  }
  snapshot = (snapshot: QueueSnapshot) => {
    if (this.closed) return;
    this.pending = `event: orders\ndata: ${JSON.stringify(snapshot)}\n\n`;
    this.flush();
  };
  start(unsubscribe: () => void) {
    if (this.closed) {
      unsubscribe();
      return;
    }
    this.unsubscribe = unsubscribe;
    this.response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    this.response.flushHeaders();
    this.started = true;
    this.write('retry: 3000\n\n');
    this.flush();
    if (this.closed) return;
    this.heartbeat = setInterval(() => {
      if (!this.blocked && !this.closed)
        this.write('event: ping\ndata: {}\n\n');
    }, 15000);
    this.heartbeat.unref();
  }
  private write(chunk: string) {
    let writable: boolean;
    try {
      writable = this.response.write(chunk);
    } catch {
      this.dispose();
      return;
    }
    if (!writable) {
      this.blocked = true;
      this.stalled = setTimeout(this.dispose, 30000);
      this.stalled.unref();
    }
  }
  private flush() {
    if (!this.started || this.closed || this.blocked || !this.pending) return;
    const chunk = this.pending;
    this.pending = undefined;
    this.write(chunk);
  }
  private drain = () => {
    clearTimeout(this.stalled);
    this.blocked = false;
    this.flush();
  };
  dispose = () => {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.stalled);
    this.unsubscribe?.();
    this.pending = undefined;
    this.response.off('drain', this.drain);
    this.response.off('close', this.dispose);
    this.response.off('error', this.dispose);
    this.removed();
    this.response.destroy();
  };
}
