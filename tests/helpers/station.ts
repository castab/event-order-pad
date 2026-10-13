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
  readonly store = new MemoryTicketStore();
  revision = 0;
  constructor(private orders?: MemoryOrderRepository) {}
  async check() {}
  async load() {
    return parseStationSnapshot({
      revision: this.revision,
      draft: (await this.store.loadDraft()) ?? newDraft(),
      saved: await this.store.load(),
    });
  }
  async mutate(value: StationCommand) {
    const cmd = parseStationCommand(value);
    if (cmd.revision !== this.revision)
      throw new StationConflict('Stale station revision.');
    switch (cmd.operation) {
      case 'saveDraft':
        if (
          JSON.stringify((await this.load()).draft) ===
          JSON.stringify(cmd.draft)
        )
          return this.load();
        await this.store.saveDraft(cmd.draft);
        break;
      case 'saveTicket':
        await this.store.saveTicket(cmd.ticket);
        break;
      case 'startOrder':
        await this.store.startOrder(cmd.ticket, cmd.draft, cmd.attempt);
        await this.orders?.upsert(cmd.ticket);
        break;
      case 'startAttempt':
        await this.store.startAttempt(cmd.attempt);
        break;
      case 'finishAttempt':
        await this.store.finishAttempt(cmd.attempt, cmd.draft);
        break;
    }
    this.revision++;
    return this.load();
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
  async finish(request: Request, result: PrintAttemptResult) {
    const before = this.records.get(request.attemptId);
    if (!before || before.result) throw new Error('Final dispatch.');
    this.records.set(request.attemptId, { request, result });
  }
}
