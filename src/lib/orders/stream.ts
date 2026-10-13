import { parseSnapshot, type OrderChange, type QueueVersion } from './live';
import type { QueueOrder } from './order';

export interface QueueFeedState {
  readonly orders: readonly QueueOrder[];
  readonly loaded: boolean;
  readonly connecting: boolean;
  readonly error: string;
  readonly updatedAt?: string;
}
const disconnected =
  'Live queue disconnected. Reconnecting to the Linux service…';

/** Versions protect both stream snapshots and slower HTTP action responses. */
export class QueueFeed {
  private state: QueueFeedState = {
    orders: [],
    loaded: false,
    connecting: false,
    error: '',
  };
  private version?: QueueVersion;
  private retired = new Set<string>();
  private source?: EventSource;
  private watchdog?: ReturnType<typeof setTimeout>;
  private stopped = true;
  constructor(
    private changed: (state: QueueFeedState) => void,
    private createSource: (url: string) => EventSource = (url) =>
      new EventSource(url),
  ) {}
  private publish(patch: Partial<QueueFeedState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private accept(version: QueueVersion): boolean {
    if (this.retired.has(version.instanceId)) return false;
    if (
      this.version?.instanceId === version.instanceId &&
      version.revision < this.version.revision
    )
      return false;
    if (this.version && this.version.instanceId !== version.instanceId)
      this.retired.add(this.version.instanceId);
    this.version = version;
    return true;
  }
  private alive(source: EventSource) {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      if (this.source !== source || this.stopped) return;
      this.publish({ error: disconnected, connecting: false });
      this.connect();
    }, 45000);
  }
  start() {
    this.stopped = false;
    this.connect();
  }
  refresh = () => {
    if (!this.stopped) this.connect();
  };
  private connect() {
    const previous = this.source;
    this.source = undefined;
    previous?.close();
    clearTimeout(this.watchdog);
    this.publish({ connecting: true });
    let source: EventSource;
    try {
      source = this.createSource('/api/orders/events');
    } catch {
      this.publish({ connecting: false, error: disconnected });
      this.watchdog = setTimeout(this.refresh, 3000);
      return;
    }
    this.source = source;
    this.alive(source);
    source.addEventListener('open', () => {
      if (this.source === source && !this.stopped) this.alive(source);
    });
    source.addEventListener('ping', () => {
      if (this.source === source && !this.stopped) this.alive(source);
    });
    source.addEventListener('orders', (event) => {
      if (this.source !== source || this.stopped) return;
      try {
        const snapshot = parseSnapshot(
          JSON.parse((event as MessageEvent).data),
        );
        this.alive(source);
        if (!this.accept(snapshot)) return;
        this.publish({
          orders: snapshot.orders,
          loaded: true,
          connecting: false,
          error: '',
          updatedAt: new Date().toISOString(),
        });
      } catch {
        this.publish({
          connecting: false,
          error: 'Invalid live queue data. Reconnecting…',
        });
        // Close the malformed stream and retry; do not turn this into a fetch loop.
        source.close();
        this.source = undefined;
        clearTimeout(this.watchdog);
        this.watchdog = setTimeout(this.refresh, 3000);
      }
    });
    source.addEventListener('error', () => {
      if (this.source !== source || this.stopped) return;
      this.publish({ connecting: false, error: disconnected });
      // Native EventSource retries automatically. The watchdog covers stalled links.
    });
  }
  applyChange(change: OrderChange) {
    if (this.stopped) return;
    const replacedInstance =
      this.version && this.version.instanceId !== change.instanceId;
    if (!this.accept(change)) return;
    this.publish({
      orders: Object.freeze([
        ...this.state.orders.filter(
          (order) => order.ticket.id !== change.order.ticket.id,
        ),
        change.order,
      ]),
    });
    if (replacedInstance) this.connect();
  }
  stop() {
    this.stopped = true;
    this.source?.close();
    this.source = undefined;
    clearTimeout(this.watchdog);
  }
}
