import type { OrderTicket } from '../tickets/ticket';
import { parseRegistration } from './registration';

interface Outbox {
  pendingOrders(): Promise<readonly OrderTicket[]>;
  acknowledgeOrder(id: string): Promise<void>;
}

/** Retries only idempotent order publication. Never invokes a printer or print endpoint. */
export class OrderPublisher {
  private running = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  constructor(
    private store: Outbox,
    private changed: (notice: string) => void,
    private send: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  start() {
    if (this.timer || this.stopped) return;
    void this.flush();
    this.timer = setInterval(() => void this.flush(), 5000);
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller?.abort();
  }
  async flush() {
    if (this.running || this.stopped) return;
    this.running = true;
    this.controller = new AbortController();
    try {
      const tickets = await this.store.pendingOrders();
      for (const ticket of tickets) {
        if (this.stopped) return;
        const response = await this.send('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ticket),
          cache: 'no-store',
          signal: AbortSignal.any([
            this.controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (this.stopped) return;
        if (!response.ok) throw new Error('Order publication failed.');
        parseRegistration(await response.json(), ticket.id);
        if (this.stopped) return;
        await this.store.acknowledgeOrder(ticket.id);
      }
      if (!this.stopped) this.changed('');
    } catch {
      if (!this.stopped)
        this.changed(
          'Order persistence pending. It will retry when the service is available; no print will be resent.',
        );
    } finally {
      this.running = false;
    }
  }
}
