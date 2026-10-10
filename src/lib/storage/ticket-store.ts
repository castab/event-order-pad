import { parseTicket, type OrderTicket } from '../tickets/ticket';
import type { PrintAttempt } from '../printing/port';

export interface SavedSession {
  readonly ticket: OrderTicket;
  readonly attempts: readonly PrintAttempt[];
}
export interface TicketStore {
  load(): Promise<SavedSession | undefined>;
  saveTicket(ticket: OrderTicket): Promise<void>;
  startAttempt(attempt: PrintAttempt): Promise<void>;
  finishAttempt(attempt: PrintAttempt): Promise<void>;
}

/** One latest ticket, with append-only attempt IDs and individual final outcomes. */
export class IndexedDbTicketStore implements TicketStore {
  private database?: Promise<IDBDatabase>;
  constructor(
    private factory: IDBFactory = indexedDB,
    private name = 'order-pad-v1',
  ) {}

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('tickets', { keyPath: 'id' });
        request.result.createObjectStore('attempts', { keyPath: 'id' });
        request.result.createObjectStore('settings');
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          this.database = undefined;
        };
        resolve(request.result);
      };
      request.onerror = () => {
        this.database = undefined;
        reject(request.error);
      };
      request.onblocked = () =>
        reject(
          new Error(
            'Local storage upgrade blocked. Close other Order Pad tabs.',
          ),
        );
    });
    return this.database;
  }

  private async transaction<T>(
    stores: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction, done: (value: T) => void) => void,
  ): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(tx.error ?? new Error('Local storage transaction aborted.'));
      tx.onerror = () =>
        reject(tx.error ?? new Error('Local storage transaction failed.'));
      try {
        work(tx, (value) => {
          result = value;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }

  async load(): Promise<SavedSession | undefined> {
    return this.transaction(
      ['tickets', 'attempts', 'settings'],
      'readonly',
      (tx, done) => {
        const latest = tx.objectStore('settings').get('latest');
        latest.onsuccess = () => {
          if (!latest.result) {
            done(undefined);
            return;
          }
          const ticket = tx.objectStore('tickets').get(latest.result);
          const attempts = tx.objectStore('attempts').getAll();
          attempts.onsuccess = () => {
            try {
              done({
                ticket: parseTicket(ticket.result),
                attempts: (attempts.result as PrintAttempt[])
                  .filter((attempt) => attempt.ticketId === latest.result)
                  .sort(
                    (a, b) =>
                      a.startedAt.localeCompare(b.startedAt) ||
                      a.id.localeCompare(b.id),
                  ),
              });
            } catch {
              tx.abort();
            }
          };
        };
      },
    );
  }

  async saveTicket(ticket: OrderTicket): Promise<void> {
    const valid = parseTicket(ticket);
    await this.transaction<void>(
      ['tickets', 'settings'],
      'readwrite',
      (tx, done) => {
        const store = tx.objectStore('tickets');
        const existing = store.get(valid.id);
        existing.onsuccess = () => {
          // Reprinting must never replace an immutable ticket with different contents.
          if (
            existing.result &&
            JSON.stringify(parseTicket(existing.result)) !==
              JSON.stringify(valid)
          ) {
            tx.abort();
            return;
          }
          store.put(valid);
          tx.objectStore('settings').put(valid.id, 'latest');
          done(undefined);
        };
      },
    );
  }

  async startAttempt(attempt: PrintAttempt): Promise<void> {
    await this.transaction<void>(
      ['attempts', 'tickets'],
      'readwrite',
      (tx, done) => {
        const ticket = tx.objectStore('tickets').get(attempt.ticketId);
        ticket.onsuccess = () => {
          if (!ticket.result) {
            tx.abort();
            return;
          }
          tx.objectStore('attempts').add(attempt);
          done(undefined);
        };
      },
    );
  }

  async finishAttempt(attempt: PrintAttempt): Promise<void> {
    await this.transaction<void>(['attempts'], 'readwrite', (tx, done) => {
      const store = tx.objectStore('attempts');
      const existing = store.get(attempt.id);
      existing.onsuccess = () => {
        const before = existing.result as PrintAttempt | undefined;
        if (
          !before ||
          before.result ||
          !attempt.result ||
          before.ticketId !== attempt.ticketId ||
          before.startedAt !== attempt.startedAt ||
          before.reprint !== attempt.reprint ||
          before.mode !== attempt.mode
        ) {
          tx.abort();
          return;
        }
        store.put(attempt);
        done(undefined);
      };
    });
  }
}
