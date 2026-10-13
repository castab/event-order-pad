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
  load(workspaceId?: string): Promise<StationSnapshot>;
  mutate(
    command: StationCommand,
    workspaceId?: string,
  ): Promise<StationSnapshot>;
  authorizePrint(request: Request, workspaceId: string): Promise<void>;
}
const json = (value: unknown) => value as Prisma.InputJsonValue;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** Independent durable workspaces share only a transactionally allocated order counter. */
export class PostgresStationRepository
  implements StationRepository, PrintJournal
{
  constructor(
    private database: PrismaClient,
    private captureFrom: string,
    private now = () => new Date().toISOString(),
  ) {}
  async check() {
    // Check the migrated schema too: a reachable but unprepared database is down.
    await this.database.$queryRaw`SELECT
      (SELECT reference_counter FROM station WHERE id = 1) AS reference_counter,
      (SELECT cookie_id FROM workspaces LIMIT 1) AS workspace_cookie,
      (SELECT id FROM tickets LIMIT 1) AS ticket_id,
      (SELECT id FROM print_attempts LIMIT 1) AS attempt_id,
      (SELECT attempt_id FROM print_dispatches LIMIT 1) AS dispatch_id,
      (SELECT event_id FROM order_events LIMIT 1) AS event_id`;
  }
  private async workspace(
    tx: Prisma.TransactionClient,
    cookieId: string,
    create = false,
  ) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(cookieId))
      throw new StationConflict('Invalid workspace.');
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'workspace:' + cookieId}, 0))::text`;
    const existing = await tx.workspace.findUnique({ where: { cookieId } });
    if (existing) return existing;
    if (!create)
      throw new StationConflict(
        'Workspace not found. Reload before continuing.',
      );
    // Only one browser can adopt the previous station's draft and recovery history.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(721403)::text`;
    const legacy = await tx.workspace.findFirst({ where: { cookieId: null } });
    if (legacy)
      return tx.workspace.update({
        where: { id: legacy.id },
        data: { cookieId },
      });
    return tx.workspace.create({
      data: { id: cookieId, cookieId, draft: json(newDraft()) },
    });
  }
  private async snapshot(
    tx: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<StationSnapshot> {
    const station = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
    });
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
  load(workspaceId = 'test-workspace') {
    return this.database.$transaction(async (tx) => {
      const workspace = await this.workspace(tx, workspaceId, true);
      return this.snapshot(tx, workspace.id);
    });
  }
  private async ticket(
    tx: Prisma.TransactionClient,
    ticket: OrderTicket,
    workspaceId: string,
  ) {
    const before = await tx.ticket.findUnique({ where: { id: ticket.id } });
    if (
      before &&
      (before.workspaceId !== workspaceId ||
        !equal(parseTicket(before.content), ticket))
    )
      throw new StationConflict('Immutable ticket content differs.');
    if (!before)
      await tx.ticket.create({
        data: { id: ticket.id, content: json(ticket), workspaceId },
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
  mutate(value: StationCommand, workspaceId = 'test-workspace') {
    const command = parseStationCommand(value);
    return this.database.$transaction(async (tx) => {
      const station = await this.workspace(tx, workspaceId);
      if (station.revision !== command.revision)
        throw new StationConflict(
          'The station changed in another tab. Reload before continuing.',
        );
      const current = parseDraft(station.draft);
      if (command.operation === 'saveDraft' && equal(current, command.draft))
        return this.snapshot(tx, station.id);
      let draft = current;
      let latest = station.latestTicketId;
      switch (command.operation) {
        case 'saveDraft':
          draft = command.draft;
          if (
            !current.submittedTicketId &&
            (draft.reference || draft.submittedTicketId)
          )
            throw new StationConflict(
              'Only the service can assign an order number.',
            );
          if (current.submittedTicketId) {
            const saved = (await this.snapshot(tx, station.id)).saved;
            const newest = saved?.attempts.at(-1);
            if (draft.submittedTicketId) {
              if (!equal(draft, current))
                throw new StationConflict('Submitted drafts are locked.');
            } else {
              if (!newest?.result)
                throw new StationConflict(
                  'Check the printer before starting a new order.',
                );
              if (!equal(draft, newDraft()) || !saved)
                throw new StationConflict(
                  'New orders must start with an empty draft.',
                );
            }
          }
          break;
        case 'saveTicket':
          if (command.ticket.id !== latest)
            throw new StationConflict(
              'Tickets must be created by first-order intent.',
            );
          await this.ticket(tx, command.ticket, station.id);
          break;
        case 'startOrder': {
          const { attempt } = command;
          if (current.submittedTicketId || attempt.reprint || attempt.result)
            throw new StationConflict('Invalid first order intent.');
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(721404)::text`;
          const counter = await tx.station.findUnique({ where: { id: 1 } });
          const high = counter?.referenceCounter ?? 0n;
          // Include explicit queue registrations and preserved centralized history.
          const refs = await tx.$queryRaw<
            { high: bigint }[]
          >`SELECT COALESCE(MAX((order_jsonb->>'reference')::bigint),0) AS high FROM order_events`;
          const next = (high > refs[0].high ? high : refs[0].high) + 1n;
          const reference = String(next);
          const prepared = prepareDraftForPrint(current);
          const ticket = draftTicket(
            prepared,
            attempt.ticketId,
            this.now(),
            reference,
          );
          draft = parseDraft({
            ...prepared,
            reference: ticket.reference,
            submittedTicketId: ticket.id,
          });
          await tx.station.upsert({
            where: { id: 1 },
            create: { id: 1, referenceCounter: next },
            update: { referenceCounter: next },
          });
          if (await tx.ticket.findUnique({ where: { id: ticket.id } }))
            throw new StationConflict('Order already exists.');
          await this.ticket(tx, ticket, station.id);
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
          if (!row || row.ticketId !== latest)
            throw new StationConflict(
              'Print attempt not found in this workspace.',
            );
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
            draft = newDraft();
          else if (command.draft)
            throw new StationConflict(
              'Only an accepted attempt can advance the draft.',
            );
          break;
        }
      }
      await tx.workspace.update({
        where: { id: station.id },
        data: {
          draft: json(draft),
          latestTicketId: latest,
          revision: { increment: 1 },
        },
      });
      return this.snapshot(tx, station.id);
    });
  }
  async authorizePrint(request: Request, workspaceId: string) {
    const row = await this.database.ticket.findUnique({
      where: { id: request.ticket.id },
      include: { workspace: true },
    });
    if (!row || row.workspace.cookieId !== workspaceId)
      throw new StationConflict('Print intent belongs to another workspace.');
    const attempt = await this.database.attempt.findUnique({
      where: { id: request.attemptId },
    });
    if (!attempt || attempt.ticketId !== row.id)
      throw new StationConflict('Print attempt not found in this workspace.');
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
      const owner = await tx.ticket.findUniqueOrThrow({
        where: { id: request.ticket.id },
        include: { workspace: true },
      });
      const workspace = await this.workspace(tx, owner.workspace.cookieId!);
      const row = await tx.attempt.findUniqueOrThrow({
        where: { id: request.attemptId },
        include: { ticket: true },
      });
      const attempt = parseAttempt(row.content);
      if (
        workspace.latestTicketId !== row.ticketId ||
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
  async assertPending(request: Request) {
    const row = await this.database.attempt.findUniqueOrThrow({
      where: { id: request.attemptId },
      include: { dispatch: true },
    });
    if (
      parseAttempt(row.content).result ||
      !row.dispatch ||
      row.dispatch.result ||
      !equal(parseRequest(row.dispatch.request), request)
    )
      throw new StationConflict('Print intent is no longer pending.');
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
