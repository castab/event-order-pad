import {
  StationConflict,
  type StationRepository,
} from '../../printer-service/station-database';
import {
  parseStationCommand,
  parseStationSnapshot,
  type StationCommand,
} from '../../src/lib/storage/ticket-store';
import { newDraft } from '../../src/lib/tickets/order';
import { MemoryTicketStore } from './ticket-store';
import type { MemoryOrderRepository } from './order-repository';
import type {
  PrintJournal,
  PrintRecord,
  Request,
} from '../../printer-service/printing';
import type { PrintAttemptResult } from '../../src/lib/printing/port';

export class MemoryStationRepository implements StationRepository {
  private high = 0;
  readonly store = new MemoryTicketStore(() => String(++this.high));
  private readonly workspaces = new Map<
    string,
    { store: MemoryTicketStore; revision: number }
  >();
  constructor(private orders?: MemoryOrderRepository) {}
  private workspace(id?: string) {
    if (!id && this.workspaces.size)
      return this.workspaces.values().next().value!;
    const key = id ?? 'test-workspace';
    let state = this.workspaces.get(key);
    if (!state) {
      state = {
        store: this.workspaces.size
          ? new MemoryTicketStore(() => String(++this.high))
          : this.store,
        revision: 0,
      };
      this.workspaces.set(key, state);
    }
    return state;
  }
  async check() {}
  async load(id?: string) {
    const state = this.workspace(id);
    return parseStationSnapshot({
      revision: state.revision,
      draft: (await state.store.loadDraft()) ?? newDraft(),
      saved: await state.store.load(),
    });
  }
  async mutate(value: StationCommand, id?: string) {
    const cmd = parseStationCommand(value);
    const state = this.workspace(id);
    const store = state.store;
    if (cmd.revision !== state.revision)
      throw new StationConflict(
        'The station changed in another tab. Reload before continuing.',
      );
    switch (cmd.operation) {
      case 'saveDraft':
        if (
          JSON.stringify((await this.load(id)).draft) ===
          JSON.stringify(cmd.draft)
        )
          return this.load(id);
        await store.saveDraft(cmd.draft);
        break;
      case 'saveTicket':
        await store.saveTicket(cmd.ticket);
        break;
      case 'startOrder': {
        const snapshot = await store.startOrder(cmd.attempt);
        await this.orders?.upsert(snapshot.saved!.ticket);
        break;
      }
      case 'startAttempt':
        await store.startAttempt(cmd.attempt);
        break;
      case 'finishAttempt':
        await store.finishAttempt(cmd.attempt, cmd.draft);
        break;
    }
    state.revision++;
    return this.load(id);
  }
  async authorizePrint(request: Request, id: string) {
    const store = this.workspace(id).store;
    if (
      !store.tickets.has(request.ticket.id) ||
      store.attempts.get(request.attemptId)?.ticketId !== request.ticket.id
    )
      throw new StationConflict('Print intent belongs to another workspace.');
  }
}
export class MemoryPrintJournal implements PrintJournal {
  readonly records = new Map<string, PrintRecord>();
  async get(id: string) {
    return this.records.get(id);
  }
  async begin(request: Request) {
    if (this.records.has(request.attemptId))
      throw new Error('Duplicate dispatch.');
    this.records.set(request.attemptId, { request });
  }
  async assertPending(request: Request) {
    const record = this.records.get(request.attemptId);
    if (!record || record.result) throw new Error('Final dispatch.');
  }
  async finish(request: Request, result: PrintAttemptResult) {
    const before = this.records.get(request.attemptId);
    if (!before || before.result) throw new Error('Final dispatch.');
    this.records.set(request.attemptId, { request, result });
  }
}
