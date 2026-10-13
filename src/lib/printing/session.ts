import type { OrderTicket } from '../tickets/ticket';
import {
  draftTicket,
  newDraft,
  parseDraft,
  prepareDraftForPrint,
  type OrderDraft,
} from '../tickets/order';
import { StationConflict, type TicketStore } from '../storage/ticket-store';
import type {
  PrintAttempt,
  PrintAttemptResult,
  PrintReturn,
  TicketPrinter,
} from './port';

export interface SessionState {
  readonly phase:
    'loading' | 'ready' | 'saving' | 'printing' | 'handoff' | 'blocked';
  readonly savingDraft?: boolean;
  readonly handoffUrl?: string;
  readonly ticket?: OrderTicket;
  readonly draft?: OrderDraft;
  readonly attempts: readonly PrintAttempt[];
  readonly notice?: string;
  /** The notice is a stale-revision conflict, not a database failure. */
  readonly conflict?: boolean;
}

function blockedNotice(error: unknown, failure: string) {
  return error instanceof StationConflict
    ? { notice: error.message, conflict: true }
    : { notice: failure, conflict: false };
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
        const persisted = await this.store.finishAttempt(recovered);
        attempts.push(persisted ?? recovered);
      }
      let draft = (await this.store.loadDraft()) ?? newDraft();
      // No attempt means no send occurred. A crash while saving the order can
      // safely restore its editable draft; pending attempts always stay locked.
      if (
        draft.submittedTicketId &&
        (draft.submittedTicketId !== ticket?.id || !attempts.length)
      ) {
        draft = parseDraft({
          ...draft,
          submittedTicketId: undefined,
          reference: undefined,
        });
      }
      if (
        draft.submittedTicketId === ticket?.id &&
        attempts.at(-1)?.result?.status === 'accepted'
      ) {
        draft = newDraft();
      }
      await this.store.saveDraft(draft);
      this.update({ phase: 'ready', ticket, attempts, draft });
    } catch (error) {
      this.update({
        phase: 'blocked',
        attempts: [],
        ...blockedNotice(
          error,
          'Database unavailable or station state changed. Order editing and printing are blocked. Restore Postgres on the app machine and reload to recover saved state.',
        ),
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
    this.update({ ...this.state, draft, savingDraft: true });
    this.draftWrites = this.draftWrites.then(async () => {
      if (this.state.phase === 'blocked') return;
      try {
        await this.store.saveDraft(draft);
        if (this.state.draft === draft)
          this.update({ ...this.state, savingDraft: false });
      } catch (error) {
        this.update({
          ...this.state,
          phase: 'blocked',
          ...blockedNotice(
            error,
            'Could not save the order draft. Printing is blocked. Reopen the page to recover the last saved draft.',
          ),
        });
      }
    });
  }

  block(): void {
    if (this.busy) return;
    this.update({
      ...this.state,
      phase: 'blocked',
      conflict: false,
      notice:
        'Database connection lost. Order editing and printing are blocked. Restore Postgres on this machine and reload. Nothing will be resent automatically.',
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
    const draft = newDraft();
    this.update({ ...this.state, phase: 'saving' });
    try {
      await this.store.saveDraft(draft);
      this.update({ ...this.state, phase: 'ready', draft });
    } catch (error) {
      this.update({
        ...this.state,
        phase: 'blocked',
        ...blockedNotice(
          error,
          'Could not save the new order. No data was sent. Restore Postgres and reload to recover saved state.',
        ),
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
    this.busy = true;
    await this.draftWrites;
    if (this.state.phase !== 'ready' || this.state.notice) {
      this.busy = false;
      return;
    }
    const draft = this.state.draft!;
    try {
      prepareDraftForPrint(draft);
    } catch (error) {
      this.busy = false;
      throw error;
    }
    const attempt: PrintAttempt = {
      id: this.id(),
      ticketId: this.id(),
      startedAt: this.now(),
      mode: printer.mode,
      reprint: false,
    };
    this.update({ ...this.state, phase: 'saving' });
    try {
      const snapshot = await this.store.startOrder(attempt);
      await this.dispatch(
        printer,
        snapshot.saved!.ticket,
        attempt,
        [],
        snapshot.draft,
      );
    } catch (error) {
      this.update({
        ...this.state,
        phase: 'blocked',
        ...blockedNotice(
          error,
          'Could not save print intent. No job was sent by this browser. Reload to recover committed state. Nothing will be resent automatically.',
        ),
      });
    } finally {
      this.busy = false;
    }
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
      await this.store.saveTicket(ticket);
      if (draft) await this.store.saveDraft(draft);
      await this.store.startAttempt(attempt);
    } catch (error) {
      this.busy = false;
      this.update({
        phase: 'blocked',
        ticket,
        draft,
        attempts: previous,
        ...blockedNotice(
          error,
          'Could not save print intent. No data was sent. Restore Postgres and reload to recover saved state.',
        ),
      });
      return;
    }
    await this.dispatch(printer, ticket, attempt, previous, draft);
  }

  private async dispatch(
    printer: TicketPrinter,
    ticket: OrderTicket,
    attempt: PrintAttempt,
    previous: readonly PrintAttempt[],
    draft?: OrderDraft,
  ): Promise<void> {
    const reprint = attempt.reprint;
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
        ? newDraft()
        : undefined;
    try {
      const persisted = await this.store.finishAttempt(completed, nextDraft);
      const savedDraft = await this.store.loadDraft();
      this.update({
        phase: 'ready',
        ticket,
        draft: savedDraft ?? nextDraft ?? draft,
        attempts: [...previous, persisted ?? completed],
      });
    } catch (error) {
      this.update({
        phase: 'blocked',
        ticket,
        draft,
        attempts: [...previous, completed],
        conflict: false,
        notice:
          'The send finished but its outcome could not be saved. Printing is blocked. Reload to recover the database outcome. If it is still unknown, check the physical ticket.',
      });
    } finally {
      this.busy = false;
    }
  }
}
