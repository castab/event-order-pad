import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDbTicketStore } from './ticket-store';
import { newDraft } from '../tickets/order';
import { sampleTicket } from '../tickets/ticket';
import { PrintSession } from '../printing/session';
import { SimulatedPrinter } from '../printing/adapters/simulated';

function open(factory: IDBFactory, version?: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('history', version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('tickets', { keyPath: 'id' });
      request.result.createObjectStore('attempts', { keyPath: 'id' });
      request.result.createObjectStore('settings');
    };
  });
}
async function transaction(
  db: IDBDatabase,
  work: (tx: IDBTransaction) => void,
) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['tickets', 'attempts', 'settings'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    work(tx);
  });
}
async function counter(factory: IDBFactory) {
  const db = await open(factory);
  try {
    return await new Promise<number>((resolve, reject) => {
      const request = db
        .transaction('settings')
        .objectStore('settings')
        .get('referenceCounter');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
const serving = {
  flavors: [{ flavor: 'Vanilla' as const, count: 1 }],
  container: 'Cup' as const,
  toppings: [],
};

describe('v2 browser storage and numeric references', () => {
  it('automatically resets v1 tickets, attempts and drafts, preserving unrelated settings', async () => {
    const factory = new IDBFactory();
    const old = await open(factory, 1);
    await transaction(old, (tx) => {
      tx.objectStore('tickets').put({
        id: 'old',
        items: [{ name: 'Ice cream' }],
      });
      tx.objectStore('attempts').put({ id: 'unfinished', ticketId: 'old' });
      const settings = tx.objectStore('settings');
      settings.put('old', 'latest');
      settings.put({ reference: 'Sundae Sprinkle' }, 'draft');
      settings.put('preserve', 'unrelated');
    });
    old.close();
    const store = new IndexedDbTicketStore(factory, 'history');
    expect(await store.load()).toBeUndefined();
    expect(await store.loadDraft()).toBeUndefined();
    expect(await counter(factory)).toBe(0);
    const db = await open(factory);
    expect(db.version).toBe(2);
    await transaction(db, (tx) => {
      const tickets = tx.objectStore('tickets').count();
      tickets.onsuccess = () => expect(tickets.result).toBe(0);
      const attempts = tx.objectStore('attempts').count();
      attempts.onsuccess = () => expect(attempts.result).toBe(0);
      const unrelated = tx.objectStore('settings').get('unrelated');
      unrelated.onsuccess = () => expect(unrelated.result).toBe('preserve');
    });
    db.close();
    const ticket = sampleTicket('new', '2026-10-12T02:42:00.000Z');
    await store.saveTicket(ticket);
    await store.saveDraft({ ...newDraft('0043'), name: 'Recovered draft' });
    const reload = new IndexedDbTicketStore(factory, 'history');
    expect((await reload.load())?.ticket).toEqual(ticket);
    expect((await reload.loadDraft())?.name).toBe('Recovered draft');
    expect(await counter(factory)).toBe(44);
  });
  it('recovers the next reference from the counter when the draft is absent', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbTicketStore(factory, 'history');
    await store.saveDraft(newDraft('0099'));
    const db = await open(factory);
    await transaction(db, (tx) => {
      tx.objectStore('settings').delete('draft');
    });
    db.close();
    expect((await store.loadDraft())?.reference).toBe('0101');
    await store.saveDraft((await store.loadDraft())!);
    expect(await counter(factory)).toBe(101);
  });
  it('advances across acceptance and abandonment, survives reloads, and does not advance on reprint', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbTicketStore(factory, 'history');
    let id = 0;
    const session = new PrintSession(
      store,
      () => {},
      () => `id-${++id}`,
    );
    const accepted = new SimulatedPrinter('accepted', 0);
    await session.initialize();
    expect(session.state.draft?.reference).toBe('0001');
    await session.newOrder();
    expect(session.state.draft?.reference).toBe('0002');
    session.updateDraft({ ...session.state.draft!, servings: [serving] });
    await session.submit(accepted);
    expect(session.state.ticket?.reference).toBe('0002');
    expect(session.state.draft?.reference).toBe('0003');
    expect(await counter(factory)).toBe(3);
    const original = session.state.ticket;
    await session.print(accepted, true);
    expect(session.state.ticket).toEqual(original);
    expect(await counter(factory)).toBe(3);
    const reload = new PrintSession(
      new IndexedDbTicketStore(factory, 'history'),
      () => {},
    );
    await reload.initialize();
    expect(reload.state.draft?.reference).toBe('0003');
    expect(reload.state.ticket).toEqual(original);
    expect(reload.state.attempts).toHaveLength(2);
  });
  it('rolls back counter and first intent when a duplicate ticket cannot commit', async () => {
    const factory = new IDBFactory();
    const store = new IndexedDbTicketStore(factory, 'history');
    const ticket = sampleTicket('same-id', '2026-10-12T02:42:00.000Z');
    await store.saveTicket(ticket);
    await expect(
      store.startOrder(
        { ...ticket, reference: '0099' },
        { ...newDraft('0098'), submittedTicketId: ticket.id },
        {
          id: 'a',
          ticketId: ticket.id,
          mode: 'simulated',
          startedAt: ticket.createdAt,
          reprint: false,
        },
      ),
    ).rejects.toThrow();
    expect(await counter(factory)).toBe(43);
    expect((await store.load())?.attempts).toEqual([]);
    expect((await store.load())?.ticket).toEqual(ticket);
  });
});
