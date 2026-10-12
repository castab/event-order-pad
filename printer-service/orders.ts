import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import {
  parseOrder,
  sortOrders,
  type QueueOrder,
} from '../src/lib/orders/order';

export class OrderNotFound extends Error {}

/** Single service process. Order IDs survive completion; repeat submissions never reopen them. */
export class Orders {
  private records = new Map<string, QueueOrder>();
  private loaded = false;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private now = () => new Date().toISOString(),
  ) {}

  private filename(id: string) {
    return `${createHash('sha256').update(id).digest('hex')}.json`;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }
  private async load() {
    if (this.loaded) return;
    const records = new Map<string, QueueOrder>();
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      files = [];
    }
    for (const filename of files.filter((f) => f.endsWith('.json'))) {
      const record = parseOrder(
        JSON.parse(await readFile(join(this.directory, filename), 'utf8')),
      );
      if (
        this.filename(record.ticket.id) !== filename ||
        records.has(record.ticket.id)
      )
        throw new Error('Invalid order journal identity.');
      records.set(record.ticket.id, record);
    }
    this.records = records;
    this.loaded = true;
  }
  private async save(record: QueueOrder) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(
      this.directory,
      `${this.filename(record.ticket.id)}.${randomUUID()}.tmp`,
    );
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(
        temporary,
        join(this.directory, this.filename(record.ticket.id)),
      );
      if (process.platform === 'linux') {
        const directory = await open(this.directory, 'r');
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
      this.records.set(record.ticket.id, record);
    } catch (error) {
      this.loaded = false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  upsert(value: OrderTicket): Promise<{ order: QueueOrder; created: boolean }> {
    const ticket = parseTicket(value);
    return this.serialize(async () => {
      await this.load();
      const existing = this.records.get(ticket.id);
      if (existing) return { order: existing, created: false };
      const order = parseOrder({
        ticket,
        submittedAt: ticket.createdAt,
        status: 'open',
      });
      await this.save(order);
      return { order, created: true };
    });
  }
  list(status?: 'open' | 'done'): Promise<readonly QueueOrder[]> {
    return this.serialize(async () => {
      await this.load();
      const records = [...this.records.values()];
      return Object.freeze(
        status === 'open'
          ? sortOrders(records, 'open')
          : status === 'done'
            ? sortOrders(records, 'done').slice(0, 8)
            : [
                ...sortOrders(records, 'open'),
                ...sortOrders(records, 'done').slice(0, 8),
              ],
      );
    });
  }
  setStatus(id: string, status: 'open' | 'done'): Promise<QueueOrder> {
    return this.serialize(async () => {
      await this.load();
      const existing = this.records.get(id);
      if (!existing) throw new OrderNotFound('Order not found.');
      if (existing.status === status) return existing;
      const record = parseOrder({
        ticket: existing.ticket,
        submittedAt: existing.submittedAt,
        status,
        ...(status === 'done' ? { doneAt: this.now() } : {}),
      });
      await this.save(record);
      return record;
    });
  }
}
