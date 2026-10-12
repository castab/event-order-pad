import { parseTicket, type OrderTicket } from '../tickets/ticket';
import type { PrintAttempt } from '../printing/port';
import { newDraft, parseDraft, type OrderDraft } from '../tickets/order';

export interface SavedSession {
  readonly ticket: OrderTicket;
  readonly attempts: readonly PrintAttempt[];
}
export interface TicketStore {
  load(): Promise<SavedSession | undefined>;
  saveTicket(ticket: OrderTicket): Promise<void>;
  startAttempt(attempt: PrintAttempt): Promise<void>;
  finishAttempt(attempt: PrintAttempt, nextDraft?: OrderDraft): Promise<void>;
  loadDraft(): Promise<OrderDraft | undefined>;
  saveDraft(draft: OrderDraft): Promise<void>;
  startOrder(
    ticket: OrderTicket,
    draft: OrderDraft,
    attempt: PrintAttempt,
  ): Promise<void>;
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
      const request = this.factory.open(this.name, 2);
      request.onupgradeneeded = (event) => {
        if (event.oldVersion === 0) {
          request.result.createObjectStore('tickets', { keyPath: 'id' });
          request.result.createObjectStore('attempts', { keyPath: 'id' });
          request.result.createObjectStore('settings');
        } else {
          // Authorized one-time reset: v1 items cannot describe structured servings.
          request.transaction!.objectStore('tickets').clear();
          request.transaction!.objectStore('attempts').clear();
          const settings = request.transaction!.objectStore('settings');
          settings.delete('latest');
          settings.delete('draft');
        }
        request.transaction!.objectStore('settings').put(0, 'referenceCounter');
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

  async loadDraft(): Promise<OrderDraft | undefined> {
    return this.transaction(['settings'], 'readonly', (tx, done) => {
      const request = tx.objectStore('settings').get('draft');
      request.onsuccess = () => {
        try {
          if (request.result) done(parseDraft(request.result));
          else {
            const counter = tx.objectStore('settings').get('referenceCounter');
            counter.onsuccess = () => {
              try {
                if (!Number.isSafeInteger(counter.result) || counter.result < 0)
                  throw new Error('Invalid reference counter.');
                done(
                  counter.result ? newDraft(String(counter.result)) : undefined,
                );
              } catch {
                tx.abort();
              }
            };
          }
        } catch {
          tx.abort();
        }
      };
    });
  }

  /** High-water counter commits in the same transaction as each draft/ticket. */
  private recordReference(tx: IDBTransaction, reference: string): void {
    const settings = tx.objectStore('settings');
    const counter = settings.get('referenceCounter');
    counter.onsuccess = () => {
      if (!Number.isSafeInteger(counter.result) || counter.result < 0) {
        tx.abort();
        return;
      }
      settings.put(
        Math.max(counter.result, Number(reference)),
        'referenceCounter',
      );
    };
  }

  async saveDraft(draft: OrderDraft): Promise<void> {
    const valid = parseDraft(draft);
    await this.transaction<void>(['settings'], 'readwrite', (tx, done) => {
      tx.objectStore('settings').put(valid, 'draft');
      this.recordReference(tx, valid.reference);
      done(undefined);
    });
  }

  /** Commit a new order, its locked draft and first intent together. */
  async startOrder(
    ticket: OrderTicket,
    draft: OrderDraft,
    attempt: PrintAttempt,
  ): Promise<void> {
    const valid = parseTicket(ticket);
    const locked = parseDraft(draft);
    if (
      attempt.ticketId !== valid.id ||
      locked.submittedTicketId !== valid.id ||
      attempt.reprint ||
      attempt.result
    )
      throw new Error('Invalid first order attempt.');
    await this.transaction<void>(
      ['tickets', 'settings', 'attempts'],
      'readwrite',
      (tx, done) => {
        tx.objectStore('tickets').add(valid);
        tx.objectStore('settings').put(valid.id, 'latest');
        tx.objectStore('settings').put(locked, 'draft');
        this.recordReference(tx, valid.reference);
        tx.objectStore('attempts').add(attempt);
        done(undefined);
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
          this.recordReference(tx, valid.reference);
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

  async finishAttempt(
    attempt: PrintAttempt,
    nextDraft?: OrderDraft,
  ): Promise<void> {
    const next = nextDraft ? parseDraft(nextDraft) : undefined;
    if (
      next &&
      (next.submittedTicketId || attempt.result?.status !== 'accepted')
    )
      throw new Error('Only an accepted attempt can advance to a new draft.');
    await this.transaction<void>(
      next ? ['attempts', 'settings'] : ['attempts'],
      'readwrite',
      (tx, done) => {
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
          if (next) {
            const settings = tx.objectStore('settings');
            const current = settings.get('draft');
            current.onsuccess = () => {
              if (current.result?.submittedTicketId !== attempt.ticketId) {
                tx.abort();
                return;
              }
              store.put(attempt);
              settings.put(next, 'draft');
              this.recordReference(tx, next.reference);
              done(undefined);
            };
          } else {
            store.put(attempt);
            done(undefined);
          }
        };
      },
    );
  }
}
