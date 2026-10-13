import { parseTicket, type OrderTicket } from '../tickets/ticket';
import { parseDraft, type OrderDraft } from '../tickets/order';
import { parseAttempt, type PrintAttempt } from '../printing/port';

export interface SavedSession {
  readonly ticket: OrderTicket;
  readonly attempts: readonly PrintAttempt[];
}
export interface TicketStore {
  load(): Promise<SavedSession | undefined>;
  saveTicket(ticket: OrderTicket): Promise<void>;
  startAttempt(attempt: PrintAttempt): Promise<void>;
  finishAttempt(
    attempt: PrintAttempt,
    nextDraft?: OrderDraft,
  ): Promise<PrintAttempt | void>;
  loadDraft(): Promise<OrderDraft | undefined>;
  saveDraft(draft: OrderDraft): Promise<void>;
  startOrder(
    ticket: OrderTicket,
    draft: OrderDraft,
    attempt: PrintAttempt,
  ): Promise<void>;
}
export interface StationSnapshot {
  readonly revision: number;
  readonly draft: OrderDraft;
  readonly saved?: SavedSession;
}
export type StationCommand = { readonly revision: number } & (
  | { readonly operation: 'saveDraft'; readonly draft: OrderDraft }
  | { readonly operation: 'saveTicket'; readonly ticket: OrderTicket }
  | { readonly operation: 'startAttempt'; readonly attempt: PrintAttempt }
  | {
      readonly operation: 'finishAttempt';
      readonly attempt: PrintAttempt;
      readonly draft?: OrderDraft;
    }
  | {
      readonly operation: 'startOrder';
      readonly ticket: OrderTicket;
      readonly draft: OrderDraft;
      readonly attempt: PrintAttempt;
    }
);
type StationWrite = StationCommand extends infer C
  ? C extends StationCommand
    ? Omit<C, 'revision'>
    : never
  : never;
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error('Invalid station revision.');
  return value as number;
}
export function parseStationCommand(value: unknown): StationCommand {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid station operation.');
  const input = value as StationCommand;
  const base = { revision: revision(input.revision) };
  switch (input.operation) {
    case 'saveDraft':
      return Object.freeze({
        ...base,
        operation: input.operation,
        draft: parseDraft(input.draft),
      });
    case 'saveTicket':
      return Object.freeze({
        ...base,
        operation: input.operation,
        ticket: parseTicket(input.ticket),
      });
    case 'startAttempt':
      return Object.freeze({
        ...base,
        operation: input.operation,
        attempt: parseAttempt(input.attempt),
      });
    case 'finishAttempt':
      return Object.freeze({
        ...base,
        operation: input.operation,
        attempt: parseAttempt(input.attempt),
        ...(input.draft ? { draft: parseDraft(input.draft) } : {}),
      });
    case 'startOrder':
      return Object.freeze({
        ...base,
        operation: input.operation,
        ticket: parseTicket(input.ticket),
        draft: parseDraft(input.draft),
        attempt: parseAttempt(input.attempt),
      });
    default:
      throw new Error('Invalid station operation.');
  }
}
export function parseStationSnapshot(value: unknown): StationSnapshot {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid station state.');
  const input = value as StationSnapshot;
  let saved: SavedSession | undefined;
  if (input.saved) {
    const ticket = parseTicket(input.saved.ticket);
    if (!Array.isArray(input.saved.attempts))
      throw new Error('Invalid print history.');
    const attempts = input.saved.attempts.map(parseAttempt);
    if (
      attempts.some((a) => a.ticketId !== ticket.id) ||
      new Set(attempts.map((a) => a.id)).size !== attempts.length
    )
      throw new Error('Invalid print history identity.');
    saved = Object.freeze({ ticket, attempts: Object.freeze(attempts) });
  }
  return Object.freeze({
    revision: revision(input.revision),
    draft: parseDraft(input.draft),
    ...(saved ? { saved } : {}),
  });
}

/** Only transient view state lives in the browser; every durable write goes to Postgres. */
export class DatabaseTicketStore implements TicketStore {
  private snapshot?: StationSnapshot;
  constructor(
    private send: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  private async request(command?: StationCommand): Promise<StationSnapshot> {
    const response = await this.send('/api/station', {
      method: command ? 'POST' : 'GET',
      ...(command
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command),
          }
        : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 409
          ? 'The station changed in another tab. Reload before continuing.'
          : 'Database unavailable. Restore Postgres and reload.',
      );
    return (this.snapshot = parseStationSnapshot(await response.json()));
  }
  private async write(command: StationWrite): Promise<void> {
    if (!this.snapshot) await this.request();
    await this.request(
      parseStationCommand({ ...command, revision: this.snapshot!.revision }),
    );
  }
  async load() {
    return (await this.request()).saved;
  }
  async loadDraft() {
    return (this.snapshot ?? (await this.request())).draft;
  }
  async saveDraft(draft: OrderDraft) {
    await this.write({ operation: 'saveDraft', draft });
  }
  async saveTicket(ticket: OrderTicket) {
    await this.write({ operation: 'saveTicket', ticket });
  }
  async startAttempt(attempt: PrintAttempt) {
    await this.write({ operation: 'startAttempt', attempt });
  }
  async startOrder(
    ticket: OrderTicket,
    draft: OrderDraft,
    attempt: PrintAttempt,
  ) {
    await this.write({ operation: 'startOrder', ticket, draft, attempt });
  }
  async finishAttempt(
    attempt: PrintAttempt,
    draft?: OrderDraft,
  ): Promise<PrintAttempt> {
    await this.write({ operation: 'finishAttempt', attempt, draft });
    const saved = this.snapshot?.saved?.attempts.find(
      (a) => a.id === attempt.id,
    );
    if (!saved?.result) throw new Error('Missing saved print outcome.');
    return saved;
  }
  async check(): Promise<void> {
    const response = await this.send('/api/database', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.json()).ready !== true)
      throw new Error('Database unavailable.');
  }
}
