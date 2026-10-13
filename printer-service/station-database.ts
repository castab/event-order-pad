import { Prisma, type PrismaClient } from './generated/prisma/client';
import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import {
  draftTicket,
  newDraft,
  parseDraft,
  prepareDraftForPrint,
} from '../src/lib/tickets/order';
import {
  parseAttempt,
  parseAttemptResult,
  type PrintAttempt,
} from '../src/lib/printing/port';
import {
  parseStationCommand,
  parseStationSnapshot,
  type StationCommand,
  type StationSnapshot,
} from '../src/lib/storage/ticket-store';
import { parseRequest, type PrintJournal, type Request } from './printing';

export class StationConflict extends Error {}
export interface StationRepository {
  check(): Promise<void>;
  load(): Promise<StationSnapshot>;
  mutate(command: StationCommand): Promise<StationSnapshot>;
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** One shared station; revision checks and transactions prevent stale tabs from losing orders. */
export class PostgresStationRepository
  implements StationRepository, PrintJournal
{
  constructor(
    private database: PrismaClient,
    private captureFrom: string,
  ) {}
  async check() {
    // Check the migrated schema too: a reachable but unprepared database is down.
    await this.database.$queryRaw`SELECT
      (SELECT revision FROM station WHERE id = 1) AS station_revision,
      (SELECT id FROM tickets LIMIT 1) AS ticket_id,
      (SELECT id FROM print_attempts LIMIT 1) AS attempt_id,
      (SELECT attempt_id FROM print_dispatches LIMIT 1) AS dispatch_id,
      (SELECT event_id FROM order_events LIMIT 1) AS event_id`;
  }
  private async station(tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721403)::text`;
    const existing = await tx.station.findUnique({ where: { id: 1 } });
    if (existing) return existing;
    // Existing queue history must not cause order numbers to be reused on upgrade.
    const history = await tx.orderEvent.findMany({
      select: { orderJsonb: true },
    });
    const high = history.reduce(
      (n, event) =>
        Math.max(n, Number(parseTicket(event.orderJsonb).reference)),
      0,
    );
    const draft = high ? newDraft(String(high)) : newDraft();
    return tx.station.create({
      data: {
        id: 1,
        draft: json(draft),
        referenceCounter: BigInt(draft.reference),
      },
    });
  }
  private async snapshot(
    tx: Prisma.TransactionClient,
  ): Promise<StationSnapshot> {
    const station = await tx.station.findUniqueOrThrow({ where: { id: 1 } });
    let saved;
    if (station.latestTicketId) {
      const ticket = await tx.ticket.findUniqueOrThrow({
        where: { id: station.latestTicketId },
      });
      const rows = await tx.attempt.findMany({
        where: { ticketId: ticket.id },
        include: { dispatch: true },
      });
      const attempts = rows
        .map((row) => {
          const attempt = parseAttempt(row.content);
          if (attempt.id !== row.id || attempt.ticketId !== row.ticketId)
            throw new Error('Invalid stored attempt identity.');
          return !attempt.result && row.dispatch?.result
            ? parseAttempt({
                ...attempt,
                result: parseAttemptResult(row.dispatch.result),
                completedAt: row.dispatch.completedAt?.toISOString(),
              })
            : attempt;
        })
        .sort(
          (a, b) =>
            a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id),
        );
      saved = { ticket: parseTicket(ticket.content), attempts };
      if (saved.ticket.id !== ticket.id)
        throw new Error('Invalid stored ticket identity.');
    }
    return parseStationSnapshot({
      revision: station.revision,
      draft: station.draft,
      saved,
    });
  }
  load() {
    return this.database.$transaction(async (tx) => {
      await this.station(tx);
      return this.snapshot(tx);
    });
  }
  private async ticket(tx: Prisma.TransactionClient, ticket: OrderTicket) {
    const before = await tx.ticket.findUnique({ where: { id: ticket.id } });
    if (before && !equal(parseTicket(before.content), ticket))
      throw new StationConflict('Immutable ticket content differs.');
    if (!before)
      await tx.ticket.create({
        data: { id: ticket.id, content: json(ticket) },
      });
  }
  private async start(tx: Prisma.TransactionClient, attempt: PrintAttempt) {
    if (attempt.result || attempt.mode !== 'linux-cups')
      throw new StationConflict('Invalid pending attempt.');
    if (await tx.attempt.findUnique({ where: { id: attempt.id } }))
      throw new StationConflict('Attempt already exists.');
    await tx.attempt.create({
      data: {
        id: attempt.id,
        ticketId: attempt.ticketId,
        content: json(attempt),
      },
    });
  }
  mutate(value: StationCommand) {
    const command = parseStationCommand(value);
    return this.database.$transaction(async (tx) => {
      const station = await this.station(tx);
      if (station.revision !== command.revision)
        throw new StationConflict(
          'The station changed in another tab. Reload before continuing.',
        );
      const current = parseDraft(station.draft);
      if (command.operation === 'saveDraft' && equal(current, command.draft))
        return this.snapshot(tx);
      let draft = current;
      let latest = station.latestTicketId;
      switch (command.operation) {
        case 'saveDraft':
          draft = command.draft;
          if (
            BigInt(draft.reference) < station.referenceCounter ||
            BigInt(draft.reference) > station.referenceCounter + 1n
          )
            throw new StationConflict('Invalid order number.');
          if (draft.submittedTicketId && draft.submittedTicketId !== latest)
            throw new StationConflict('Invalid locked draft.');
          break;
        case 'saveTicket':
          await this.ticket(tx, command.ticket);
          latest = command.ticket.id;
          break;
        case 'startOrder': {
          const { ticket, attempt } = command;
          draft = command.draft;
          if (
            current.submittedTicketId ||
            ticket.reference !== current.reference ||
            draft.submittedTicketId !== ticket.id ||
            attempt.ticketId !== ticket.id ||
            attempt.reprint ||
            !equal(
              draftTicket(
                prepareDraftForPrint(current),
                ticket.id,
                ticket.createdAt,
              ),
              ticket,
            ) ||
            !equal(
              draftTicket(
                { ...draft, submittedTicketId: undefined },
                ticket.id,
                ticket.createdAt,
              ),
              ticket,
            )
          )
            throw new StationConflict('Invalid first order intent.');
          if (await tx.ticket.findUnique({ where: { id: ticket.id } }))
            throw new StationConflict('Order already exists.');
          await this.ticket(tx, ticket);
          await this.start(tx, attempt);
          latest = ticket.id;
          if (ticket.createdAt < this.captureFrom)
            throw new StationConflict(
              'New orders must be after the capture cutoff. Check the station clock.',
            );
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ticket.id}, 0))::text`;
          const existing = await tx.orderEvent.findFirst({
            where: { orderId: ticket.id },
          });
          if (existing) throw new StationConflict('Order already exists.');
          await tx.orderEvent.create({
            data: {
              orderId: ticket.id,
              eventType: 'submitted',
              occurredAt: new Date(ticket.createdAt),
              orderJsonb: json(ticket),
            },
          });
          break;
        }
        case 'startAttempt':
          if (command.attempt.ticketId !== latest || !command.attempt.reprint)
            throw new StationConflict('Reprints must use the latest ticket.');
          await this.start(tx, command.attempt);
          break;
        case 'finishAttempt': {
          const row = await tx.attempt.findUnique({
            where: { id: command.attempt.id },
            include: { dispatch: true },
          });
          if (!row) throw new StationConflict('Print attempt not found.');
          const before = parseAttempt(row.content);
          if (
            before.result ||
            !command.attempt.result ||
            !equal(
              { ...command.attempt, result: undefined, completedAt: undefined },
              before,
            )
          )
            throw new StationConflict('Print outcomes are final.');
          const result = row.dispatch?.result
            ? parseAttemptResult(row.dispatch.result)
            : command.attempt.result;
          if (!row.dispatch?.result && result.status === 'accepted')
            throw new StationConflict('No durable service outcome.');
          const completed = parseAttempt({
            ...command.attempt,
            result,
            ...(row.dispatch?.completedAt
              ? { completedAt: row.dispatch.completedAt.toISOString() }
              : {}),
          });
          await tx.attempt.update({
            where: { id: completed.id },
            data: { content: json(completed) },
          });
          if (
            current.submittedTicketId === completed.ticketId &&
            result.status === 'accepted'
          )
            draft = newDraft(current.reference);
          else if (command.draft)
            throw new StationConflict(
              'Only an accepted attempt can advance the draft.',
            );
          break;
        }
      }
      await tx.station.update({
        where: { id: 1 },
        data: {
          draft: json(draft),
          latestTicketId: latest,
          referenceCounter:
            station.referenceCounter > BigInt(draft.reference)
              ? station.referenceCounter
              : BigInt(draft.reference),
          revision: { increment: 1 },
        },
      });
      return this.snapshot(tx);
    });
  }
  async get(id: string) {
    const record = await this.database.printDispatch.findUnique({
      where: { attemptId: id },
    });
    if (!record) return undefined;
    return {
      request: parseRequest(record.request),
      ...(record.result ? { result: parseAttemptResult(record.result) } : {}),
    };
  }
  async begin(request: Request) {
    await this.database.$transaction(async (tx) => {
      await this.station(tx);
      const row = await tx.attempt.findUniqueOrThrow({
        where: { id: request.attemptId },
        include: { ticket: true },
      });
      const attempt = parseAttempt(row.content);
      if (
        attempt.result ||
        attempt.ticketId !== request.ticket.id ||
        attempt.reprint !== request.reprint ||
        !equal(parseTicket(row.ticket.content), request.ticket)
      )
        throw new StationConflict('No matching pending print intent.');
      await tx.printDispatch.create({
        data: { attemptId: request.attemptId, request: json(request) },
      });
    });
  }
  async finish(request: Request, result: unknown) {
    const valid = parseAttemptResult(result);
    const saved = await this.database.printDispatch.updateMany({
      where: {
        attemptId: request.attemptId,
        result: { equals: Prisma.DbNull },
      },
      data: { result: json(valid), completedAt: new Date() },
    });
    if (saved.count !== 1)
      throw new StationConflict('Print dispatch outcomes are final.');
  }
}
