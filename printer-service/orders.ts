import { randomUUID } from 'node:crypto';
import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import type { QueueOrder } from '../src/lib/orders/order';
import type { OrderRegistration } from '../src/lib/orders/registration';
import type {
  OrderChange,
  QueueSnapshot,
  QueueVersion,
} from '../src/lib/orders/live';
import { parseCaptureFrom } from './config';

export class OrderNotFound extends Error {}

export interface OrderRepository {
  upsert(ticket: OrderTicket): Promise<{ order: QueueOrder; created: boolean }>;
  changeStatus(
    id: string,
    status: 'open' | 'done',
    at: string,
  ): Promise<{ order: QueueOrder; changed: boolean }>;
  list(status?: 'open' | 'done'): Promise<readonly QueueOrder[]>;
}

/** Single service process. Committed events precede live snapshots; no-ops never advance versions. */
export class Orders {
  private instanceId = randomUUID();
  private revision = 0;
  private listeners = new Map<(snapshot: QueueSnapshot) => void, () => void>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private repository: OrderRepository,
    private captureFrom: string,
    private now = () => new Date().toISOString(),
  ) {
    parseCaptureFrom(captureFrom);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = this.tail.then(() => {
      clearTimeout(timer);
      if (cancelled) throw new Error('Order operation waited too long.');
      return work();
    });
    this.tail = next.catch(() => undefined);
    const waiting = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelled = true;
        reject(new Error('Order operation waited too long.'));
      }, 1000);
    });
    return Promise.race([next, waiting]);
  }
  private version(): QueueVersion {
    return Object.freeze({
      instanceId: this.instanceId,
      revision: this.revision,
    });
  }
  private async snapshot(): Promise<QueueSnapshot> {
    return Object.freeze({
      ...this.version(),
      orders: await this.repository.list(),
    });
  }
  private disconnect() {
    const listeners = [...this.listeners.values()];
    this.listeners.clear();
    for (const unavailable of listeners) {
      try {
        unavailable();
      } catch {
        /* A closed stream needs no further delivery. */
      }
    }
  }
  private uncertain() {
    // A lost commit reply can hide a durable event; retire versions from before that uncertainty.
    this.instanceId = randomUUID();
    this.revision = 0;
    this.disconnect();
  }
  private async committed() {
    this.revision++;
    if (!this.listeners.size) return;
    try {
      const snapshot = await this.snapshot();
      for (const [listener, unavailable] of this.listeners) {
        try {
          listener(snapshot);
        } catch {
          this.listeners.delete(listener);
          unavailable();
        }
      }
    } catch {
      // A failed broadcast cannot turn an already committed event into a failed mutation.
      this.disconnect();
    }
  }
  upsert(value: OrderTicket): Promise<OrderRegistration> {
    const ticket = parseTicket(value);
    if (ticket.createdAt < this.captureFrom)
      return Promise.resolve(
        Object.freeze({ excluded: true, ticketId: ticket.id }),
      );
    return this.serialize(async () => {
      let saved;
      try {
        saved = await this.repository.upsert(ticket);
      } catch (error) {
        this.uncertain();
        throw error;
      }
      if (saved.created) await this.committed();
      return Object.freeze(saved);
    });
  }
  /** Registration and initial delivery share the mutation lock: no missed update. */
  subscribe(
    listener: (snapshot: QueueSnapshot) => void,
    unavailable = () => {},
  ): Promise<() => void> {
    return this.serialize(async () => {
      listener(await this.snapshot());
      this.listeners.set(listener, unavailable);
      return () => {
        this.listeners.delete(listener);
      };
    });
  }
  list(status?: 'open' | 'done'): Promise<readonly QueueOrder[]> {
    return this.serialize(() => this.repository.list(status));
  }
  async setStatus(id: string, status: 'open' | 'done'): Promise<QueueOrder> {
    return (await this.changeStatus(id, status)).order;
  }
  changeStatus(id: string, status: 'open' | 'done'): Promise<OrderChange> {
    return this.serialize(async () => {
      let saved;
      try {
        saved = await this.repository.changeStatus(id, status, this.now());
      } catch (error) {
        if (!(error instanceof OrderNotFound)) this.uncertain();
        throw error;
      }
      if (saved.changed) await this.committed();
      return Object.freeze({ order: saved.order, ...this.version() });
    });
  }
}
