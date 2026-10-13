import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from './generated/prisma/client';
import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import { parseOrder, type QueueOrder } from '../src/lib/orders/order';
import { OrderNotFound, type OrderRepository } from './orders';
import { parseDatabaseUrl } from './config';

export function createOrderDatabase(url: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: parseDatabaseUrl(url),
      max: 4,
      connectionTimeoutMillis: 1000,
      statement_timeout: 2000,
      query_timeout: 3000,
      idleTimeoutMillis: 10000,
    }),
    transactionOptions: { maxWait: 1000, timeout: 4000 },
  });
}

type Event = {
  orderId: string;
  eventType: string;
  occurredAt: Date;
  orderJsonb: unknown;
};
function project(event: Event): QueueOrder {
  const ticket = parseTicket(event.orderJsonb);
  if (
    ticket.id !== event.orderId ||
    !['submitted', 'completed', 'reopened'].includes(event.eventType)
  )
    throw new Error('Invalid stored order event.');
  return parseOrder({
    ticket,
    submittedAt: ticket.createdAt,
    status: event.eventType === 'completed' ? 'done' : 'open',
    ...(event.eventType === 'completed'
      ? { doneAt: event.occurredAt.toISOString() }
      : {}),
  });
}

/** Append-only history; the latest event supplies each order's complete current state. */
export class PostgresOrderRepository implements OrderRepository {
  constructor(private database: PrismaClient) {}
  private async lock(tx: Prisma.TransactionClient, id: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))::text`;
  }
  upsert(value: OrderTicket) {
    const ticket = parseTicket(value);
    return this.database.$transaction(async (tx) => {
      await this.lock(tx, ticket.id);
      const existing = await tx.orderEvent.findFirst({
        where: { orderId: ticket.id },
        orderBy: { eventId: 'desc' },
      });
      if (existing) return { order: project(existing), created: false };
      const event = await tx.orderEvent.create({
        data: {
          orderId: ticket.id,
          occurredAt: new Date(ticket.createdAt),
          eventType: 'submitted',
          orderJsonb: ticket as unknown as Prisma.InputJsonValue,
        },
      });
      return { order: project(event), created: true };
    });
  }
  changeStatus(id: string, status: 'open' | 'done', at: string) {
    return this.database.$transaction(async (tx) => {
      await this.lock(tx, id);
      const existing = await tx.orderEvent.findFirst({
        where: { orderId: id },
        orderBy: { eventId: 'desc' },
      });
      if (!existing) throw new OrderNotFound('Order not found.');
      const order = project(existing);
      if (order.status === status) return { order, changed: false };
      const next = parseOrder({
        ticket: order.ticket,
        submittedAt: order.submittedAt,
        status,
        ...(status === 'done' ? { doneAt: at } : {}),
      });
      const event = await tx.orderEvent.create({
        data: {
          orderId: id,
          occurredAt: new Date(at),
          eventType: status === 'done' ? 'completed' : 'reopened',
          orderJsonb: next.ticket as unknown as Prisma.InputJsonValue,
        },
      });
      return { order: project(event), changed: true };
    });
  }
  async list(status?: 'open' | 'done'): Promise<readonly QueueOrder[]> {
    // Filtering inside DISTINCT ON would resurrect an earlier completed/open state.
    const events = await this.database.$queryRaw<Event[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (order_id) order_id, event_type, occurred_at, order_jsonb
        FROM order_events ORDER BY order_id, event_id DESC
      ), visible AS (
        (SELECT *, 0 AS group_order FROM latest
         WHERE event_type <> 'completed' AND ${status ?? null}::text IS DISTINCT FROM 'done'
         ORDER BY (order_jsonb->>'createdAt')::timestamptz, order_id)
        UNION ALL
        (SELECT *, 1 AS group_order FROM latest
         WHERE event_type = 'completed' AND ${status ?? null}::text IS DISTINCT FROM 'open'
         ORDER BY occurred_at DESC, order_id LIMIT 8)
      )
      SELECT order_id AS "orderId", event_type AS "eventType", occurred_at AS "occurredAt", order_jsonb AS "orderJsonb"
      FROM visible ORDER BY group_order,
        CASE WHEN group_order = 0 THEN (order_jsonb->>'createdAt')::timestamptz END ASC,
        CASE WHEN group_order = 1 THEN occurred_at END DESC, order_id
    `);
    return Object.freeze(events.map(project));
  }
}
