import type { OrderTicket } from '../tickets/ticket';
import {
  draftTicket,
  newDraft,
  parseDraft,
  prepareDraftForPrint,
  type OrderDraft,
} from '../tickets/order';
import type { TicketStore } from '../storage/ticket-store';
import type {
  PrintAttempt,
  PrintAttemptResult,
  PrintReturn,
  TicketPrinter,
} from './port';

export interface SessionState {
  readonly phase:
    'loading' | 'ready' | 'saving' | 'printing' | 'handoff' | 'blocked';
  readonly handoffUrl?: string;
  readonly ticket?: OrderTicket;
  readonly draft?: OrderDraft;
  readonly attempts: readonly PrintAttempt[];
  readonly notice?: string;
}

/** Durable intent precedes every send. No implicit retries, including after reload. */
export class PrintSession {
  state: SessionState = { phase: 'loading', attempts: [] };
  private busy = false;
  private draftWrites: Promise<void> = Promise.resolve();
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

  async initialize(returned?: PrintReturn): Promise<void> {
    try {
      const saved = await this.store.load();
      const ticket = saved?.ticket;
      const attempts: PrintAttempt[] = [];
      for (const attempt of saved?.attempts ?? []) {
        if (attempt.result) {
          attempts.push(attempt);
          continue;
        }
        const recovered: PrintAttempt = {
          ...attempt,
          completedAt: this.now(),
          result:
            returned?.attemptId === attempt.id && returned.mode === attempt.mode
              ? returned.result
              : {
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
      let draft = (await this.store.loadDraft()) ?? newDraft(ticket?.reference);
      // No attempt means no send occurred. A crash while saving the order can
      // safely restore its editable draft; pending attempts always stay locked.
      if (
        draft.submittedTicketId &&
        (draft.submittedTicketId !== ticket?.id || !attempts.length)
      ) {
        draft = parseDraft({ ...draft, submittedTicketId: undefined });
      }
      if (
        draft.submittedTicketId === ticket?.id &&
        attempts.at(-1)?.result?.status === 'accepted'
      ) {
        draft = newDraft(draft.reference);
      }
      await this.store.saveDraft(draft);
      this.update({ phase: 'ready', ticket, attempts, draft });
    } catch {
      this.update({
        phase: 'blocked',
        attempts: [],
        notice:
          'Local storage is unavailable or damaged. Printing is blocked because the ticket and attempts cannot be saved. Reopen in a supported browser; do not clear storage if a ticket may need recovery.',
      });
    }
  }

  /** Serialize draft writes so fast input cannot restore an older snapshot. */
  updateDraft(value: OrderDraft): void {
    if (
      this.busy ||
      this.state.phase !== 'ready' ||
      this.state.draft?.submittedTicketId
    )
      return;
    const draft = parseDraft(value);
    this.update({ ...this.state, draft });
    this.draftWrites = this.draftWrites.then(async () => {
      if (this.state.phase === 'blocked') return;
      try {
        await this.store.saveDraft(draft);
      } catch {
        this.update({
          ...this.state,
          phase: 'blocked',
          notice:
            'Could not save the order draft. Printing is blocked. Reopen the page to recover the last saved draft.',
        });
      }
    });
  }

  private requiresConfirmation(): boolean {
    return this.state.attempts.at(-1)?.result?.status === 'outcome-unknown';
  }

  async newOrder(confirmed = false): Promise<void> {
    if (
      this.busy ||
      this.state.phase !== 'ready' ||
      (this.requiresConfirmation() && !confirmed)
    )
      return;
    this.busy = true;
    await this.draftWrites;
    if (this.state.notice) {
      this.busy = false;
      return;
    }
    const draft = newDraft(
      this.state.draft?.reference ?? this.state.ticket?.reference,
    );
    this.update({ ...this.state, phase: 'saving' });
    try {
      await this.store.saveDraft(draft);
      this.update({ ...this.state, phase: 'ready', draft });
    } catch {
      this.update({
        ...this.state,
        phase: 'blocked',
        notice:
          'Could not save the new order. No data was sent. Reopen the page to recover local storage.',
      });
    } finally {
      this.busy = false;
    }
  }

  async submit(printer: TicketPrinter, confirmed = false): Promise<void> {
    if (
      this.busy ||
      this.state.phase !== 'ready' ||
      !this.state.draft ||
      this.state.draft.submittedTicketId ||
      (this.requiresConfirmation() && !confirmed)
    )
      return;
    const prepared = prepareDraftForPrint(this.state.draft);
    const ticket = draftTicket(prepared, this.id(), this.now());
    await this.send(
      printer,
      ticket,
      false,
      parseDraft({ ...prepared, submittedTicketId: ticket.id }),
    );
  }

  async print(
    printer: TicketPrinter,
    reprint: boolean,
    confirmed = false,
  ): Promise<void> {
    if (this.busy || this.state.phase !== 'ready' || !this.state.ticket) return;
    if (!reprint && this.state.attempts.length > 0) return;
    if (
      reprint &&
      (!this.state.attempts.length ||
        (this.requiresConfirmation() && !confirmed))
    )
      return;
    await this.send(printer, this.state.ticket, reprint, this.state.draft);
  }

  private async send(
    printer: TicketPrinter,
    ticket: OrderTicket,
    reprint: boolean,
    draft?: OrderDraft,
  ): Promise<void> {
    this.busy = true;
    await this.draftWrites;
    if (this.state.notice) {
      this.busy = false;
      return;
    }
    const previous =
      ticket.id === this.state.ticket?.id ? this.state.attempts : [];
    const attempt: PrintAttempt = {
      id: this.id(),
      ticketId: ticket.id,
      startedAt: this.now(),
      mode: printer.mode,
      reprint,
    };
    this.update({ phase: 'saving', ticket, attempts: previous, draft });
    try {
      if (
        !reprint &&
        draft?.submittedTicketId === ticket.id &&
        !previous.length
      ) {
        await this.store.startOrder(ticket, draft, attempt);
      } else {
        await this.store.saveTicket(ticket);
        if (draft) await this.store.saveDraft(draft);
        await this.store.startAttempt(attempt);
      }
    } catch {
      this.busy = false;
      this.update({
        phase: 'blocked',
        ticket,
        draft,
        attempts: previous,
        notice:
          'Could not save print intent. No data was sent. Printing is blocked until storage is recovered.',
      });
      return;
    }
    this.update({
      phase: 'printing',
      ticket,
      draft,
      attempts: [...previous, attempt],
    });
    let result: PrintAttemptResult;
    try {
      const response = await printer.print(ticket, {
        reprint,
        attemptId: attempt.id,
      });
      if (response.status === 'handoff') {
        this.update({
          phase: 'handoff',
          ticket,
          draft,
          attempts: [...previous, attempt],
          handoffUrl: response.url,
        });
        this.busy = false;
        return;
      }
      result = response;
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
    const nextDraft =
      result.status === 'accepted' && draft?.submittedTicketId === ticket.id
        ? newDraft(draft.reference)
        : undefined;
    try {
      await this.store.finishAttempt(completed, nextDraft);
      this.update({
        phase: 'ready',
        ticket,
        draft: nextDraft ?? draft,
        attempts: [...previous, completed],
      });
    } catch {
      this.update({
        phase: 'blocked',
        ticket,
        draft,
        attempts: [...previous, completed],
        notice:
          'The send finished but its outcome could not be saved. Printing is blocked. On reload this attempt will be recovered as unknown; check the physical ticket.',
      });
    } finally {
      this.busy = false;
    }
  }
}
