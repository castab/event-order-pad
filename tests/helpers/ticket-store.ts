import type {
  TicketStore,
  SavedSession,
} from '../../src/lib/storage/ticket-store';
import { parseTicket, type OrderTicket } from '../../src/lib/tickets/ticket';
import {
  newDraft,
  parseDraft,
  type OrderDraft,
} from '../../src/lib/tickets/order';
import { parseAttempt, type PrintAttempt } from '../../src/lib/printing/port';

/** Test double; real transaction and durability guarantees are covered with Postgres. */
export class MemoryTicketStore implements TicketStore {
  readonly tickets = new Map<string, OrderTicket>();
  readonly attempts = new Map<string, PrintAttempt>();
  private latest?: string;
  private draft?: OrderDraft;
  private high = 0;
  async load(): Promise<SavedSession | undefined> {
    if (!this.latest) return undefined;
    return {
      ticket: this.tickets.get(this.latest)!,
      attempts: [...this.attempts.values()]
        .filter((a) => a.ticketId === this.latest)
        .sort(
          (a, b) =>
            a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
        ),
    };
  }
  async loadDraft() {
    return this.draft ?? (this.high ? newDraft(String(this.high)) : undefined);
  }
  async saveDraft(value: OrderDraft) {
    this.draft = parseDraft(value);
    this.high = Math.max(this.high, Number(value.reference));
  }
  async saveTicket(value: OrderTicket) {
    const ticket = parseTicket(value);
    const before = this.tickets.get(ticket.id);
    if (before && JSON.stringify(before) !== JSON.stringify(ticket))
      throw new Error('Immutable ticket.');
    this.tickets.set(ticket.id, ticket);
    this.latest = ticket.id;
    this.high = Math.max(this.high, Number(ticket.reference));
  }
  async startAttempt(value: PrintAttempt) {
    const attempt = parseAttempt(value);
    if (
      !this.tickets.has(attempt.ticketId) ||
      this.attempts.has(attempt.id) ||
      attempt.result
    )
      throw new Error('Invalid pending attempt.');
    this.attempts.set(attempt.id, attempt);
  }
  async startOrder(
    ticket: OrderTicket,
    draft: OrderDraft,
    attempt: PrintAttempt,
  ) {
    parseTicket(ticket);
    parseDraft(draft);
    parseAttempt(attempt);
    if (
      this.tickets.has(ticket.id) ||
      this.attempts.has(attempt.id) ||
      attempt.ticketId !== ticket.id ||
      draft.submittedTicketId !== ticket.id ||
      attempt.reprint ||
      attempt.result
    )
      throw new Error('Invalid first intent.');
    await this.saveTicket(ticket);
    await this.saveDraft(draft);
    await this.startAttempt(attempt);
  }
  async finishAttempt(value: PrintAttempt, next?: OrderDraft) {
    const attempt = parseAttempt(value);
    const before = this.attempts.get(attempt.id);
    if (
      !before ||
      before.result ||
      !attempt.result ||
      JSON.stringify({
        ...attempt,
        result: undefined,
        completedAt: undefined,
      }) !== JSON.stringify(before) ||
      (next &&
        (next.submittedTicketId ||
          attempt.result.status !== 'accepted' ||
          this.draft?.submittedTicketId !== attempt.ticketId))
    )
      throw new Error('Invalid final outcome.');
    this.attempts.set(attempt.id, attempt);
    if (next) await this.saveDraft(next);
    return attempt;
  }
}
