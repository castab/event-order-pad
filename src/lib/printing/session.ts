import { sampleTicket, type OrderTicket } from '../tickets/ticket';
import type { TicketStore } from '../storage/ticket-store';
import type { PrintAttempt, PrintAttemptResult, TicketPrinter } from './port';

export interface SessionState {
  readonly phase: 'loading' | 'ready' | 'saving' | 'printing' | 'blocked';
  readonly ticket?: OrderTicket;
  readonly attempts: readonly PrintAttempt[];
  readonly notice?: string;
}

/** Durable intent precedes every send. No implicit retries, including after reload. */
export class PrintSession {
  state: SessionState = { phase: 'loading', attempts: [] };
  private busy = false;
  constructor(
    private store: TicketStore,
    private changed: (state: SessionState) => void,
    private id: () => string = () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(''),
    private now = () => new Date().toISOString(),
  ) {}
  private update(state: SessionState) {
    this.state = state;
    this.changed(state);
  }

  async initialize(): Promise<void> {
    try {
      const saved = await this.store.load();
      const ticket = saved?.ticket ?? sampleTicket(this.id(), this.now());
      await this.store.saveTicket(ticket);
      const attempts: PrintAttempt[] = [];
      for (const attempt of saved?.attempts ?? []) {
        if (attempt.result) {
          attempts.push(attempt);
          continue;
        }
        const recovered: PrintAttempt = {
          ...attempt,
          completedAt: this.now(),
          result: {
            status: 'outcome-unknown',
            code: 'transport',
            simulated: attempt.mode === 'simulated',
            message:
              'Page closed before the outcome was saved. Inspect the printer before deliberately reprinting.',
          },
        };
        await this.store.finishAttempt(recovered);
        attempts.push(recovered);
      }
      this.update({ phase: 'ready', ticket, attempts });
    } catch {
      this.update({
        phase: 'blocked',
        attempts: [],
        notice:
          'Local storage is unavailable or damaged. Printing is blocked because the ticket and attempts cannot be saved. Reopen in a supported browser; do not clear storage if a ticket may need recovery.',
      });
    }
  }

  async print(printer: TicketPrinter, reprint: boolean): Promise<void> {
    if (this.busy || this.state.phase !== 'ready' || !this.state.ticket) return;
    if (!reprint && this.state.attempts.length > 0) return;
    if (reprint && this.state.attempts.length === 0) return;
    this.busy = true;
    const ticket = this.state.ticket;
    const previous = this.state.attempts;
    const attempt: PrintAttempt = {
      id: this.id(),
      ticketId: ticket.id,
      startedAt: this.now(),
      mode: printer.mode,
      reprint,
    };
    this.update({ phase: 'saving', ticket, attempts: previous });
    try {
      await this.store.saveTicket(ticket);
      await this.store.startAttempt(attempt);
    } catch {
      this.busy = false;
      this.update({
        phase: 'blocked',
        ticket,
        attempts: previous,
        notice:
          'Could not save print intent. No data was sent. Printing is blocked until storage is recovered.',
      });
      return;
    }
    this.update({
      phase: 'printing',
      ticket,
      attempts: [...previous, attempt],
    });
    let result: PrintAttemptResult;
    try {
      result = await printer.print(ticket, { reprint });
    } catch {
      result = {
        status: 'outcome-unknown',
        code: 'transport',
        simulated: printer.mode === 'simulated',
        message:
          'Printer adapter interrupted. Inspect the printer before deliberately reprinting.',
      };
    }
    const completed = { ...attempt, result, completedAt: this.now() };
    try {
      await this.store.finishAttempt(completed);
      this.update({
        phase: 'ready',
        ticket,
        attempts: [...previous, completed],
      });
    } catch {
      this.update({
        phase: 'blocked',
        ticket,
        attempts: [...previous, completed],
        notice:
          'The send finished but its outcome could not be saved. Printing is blocked. On reload this attempt will be recovered as unknown; check the physical ticket.',
      });
    } finally {
      this.busy = false;
    }
  }
}
