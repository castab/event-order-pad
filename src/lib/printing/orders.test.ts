import { describe, expect, it, vi } from 'vitest';
import { MemoryTicketStore } from '../../../tests/helpers/ticket-store';
import { sampleTicket } from '../tickets/ticket';
import { emptyEditor, newDraft, type OrderDraft } from '../tickets/order';
import { PrintSession } from './session';
import { SimulatedPrinter } from './adapters/simulated';
import type { TicketPrinter } from './port';

function fixture() {
  const store = new MemoryTicketStore();
  let id = 0;
  const session = new PrintSession(
    store,
    () => {},
    () => `id-${++id}`,
    () => '2026-10-11T20:00:00.000Z',
  );
  return { store, session };
}
const serving = {
  flavors: [{ flavor: 'Vanilla' as const, count: 1 }],
  container: 'Cup' as const,
  toppings: [],
};
function configure(session: PrintSession, extra: Partial<OrderDraft> = {}) {
  session.updateDraft({
    ...session.state.draft!,
    servings: [serving],
    ...extra,
  });
}
const accepted = () => new SimulatedPrinter('accepted', 0);

describe('successive orders and draft recovery', () => {
  it('restores incomplete editor/name and serializes quick changes', async () => {
    const { store, session } = fixture();
    await session.initialize();
    expect(session.state.ticket).toBeUndefined();
    expect(session.state.draft?.editor).toEqual(emptyEditor());
    session.updateDraft({ ...session.state.draft!, name: 'P' });
    session.updateDraft({
      ...session.state.draft!,
      name: 'Pat',
      editor: {
        ...emptyEditor(),
        flavors: [
          { flavor: 'Chocolate Chip', count: 2 },
          { flavor: 'Strawberry', count: 1 },
        ],
        toppings: ['Gummy Bears'],
      },
    });
    await vi.waitFor(async () =>
      expect((await store.loadDraft())?.name).toBe('Pat'),
    );
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.draft).toEqual(session.state.draft);
    expect(reload.state.draft?.editor.container).toBe('');
    expect(reload.state.draft?.editor.flavors).toEqual([
      { flavor: 'Strawberry', count: 1 },
      { flavor: 'Chocolate Chip', count: 2 },
    ]);
  });

  it('commits the pending serving and intent before sending, rejects overlap and atomically advances after acceptance', async () => {
    const { store, session } = fixture();
    await session.initialize();
    configure(session, { name: 'Pat', servings: [], editor: serving });
    const finish = vi.spyOn(store, 'finishAttempt');
    const print = vi.fn<TicketPrinter['print']>(async (ticket, options) => {
      expect((await store.load())?.ticket).toEqual(ticket);
      expect((await store.load())?.attempts.at(-1)?.id).toBe(options.attemptId);
      expect((await store.load())?.attempts.at(-1)?.result).toBeUndefined();
      expect((await store.loadDraft())?.submittedTicketId).toBe(ticket.id);
      expect((await store.loadDraft())?.editor).toEqual(emptyEditor());
      expect(ticket.servings).toHaveLength(1);
      return { status: 'accepted', simulated: false, message: 'Test only' };
    });
    const printer: TicketPrinter = { mode: 'linux-cups', label: 'Test', print };
    const first = session.submit(printer);
    await session.submit(printer);
    await first;
    expect(print).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(
      session.state.attempts[0],
      session.state.draft,
    );
    expect(session.state.ticket?.displayName).toBe('Pat');
    expect(session.state.draft?.name).toBe('');
    expect(session.state.draft?.servings).toEqual([]);
    expect(session.state.draft?.editor).toEqual(emptyEditor());
    expect(session.state.draft?.submittedTicketId).toBeUndefined();
    expect(await store.loadDraft()).toEqual(session.state.draft);
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.draft).toEqual(session.state.draft);
    expect(reload.state.ticket).toEqual(session.state.ticket);
  });

  it('includes edits exactly once and reprints the immutable previous ticket without touching a new incomplete draft', async () => {
    const { session, store } = fixture();
    await session.initialize();
    configure(session, {
      name: 'Pat',
      editingIndex: 0,
      editor: {
        ...serving,
        flavors: [
          { flavor: 'Chocolate Chip', count: 2 },
          { flavor: 'Strawberry', count: 1 },
        ],
        toppings: ['Gummy Bears'],
      },
    });
    await session.submit(accepted());
    const original = session.state.ticket!;
    expect(original.servings).toEqual([
      {
        container: 'Cup',
        flavors: [
          { flavor: 'Strawberry', count: 1 },
          { flavor: 'Chocolate Chip', count: 2 },
        ],
        toppings: ['Gummy Bears'],
      },
    ]);
    configure(session, {
      name: 'Next',
      editor: { ...emptyEditor(), container: 'Sugar Cone' },
    });
    const draft = session.state.draft;
    await session.print(accepted(), true);
    expect(session.state.ticket).toEqual(original);
    expect(session.state.draft).toEqual(draft);
    expect(await store.loadDraft()).toEqual(draft);
    expect(session.state.attempts).toHaveLength(2);
    configure(session, { name: 'Next', editor: emptyEditor() });
    await session.submit(accepted());
    expect(session.state.ticket?.id).not.toBe(original.id);
    expect(session.state.ticket?.displayName).toBe('Next');
    expect(session.state.attempts).toHaveLength(1);
  });

  it('rejects incomplete selections without sending or changing the draft', async () => {
    const { session } = fixture();
    await session.initialize();
    configure(session, {
      editor: {
        ...emptyEditor(),
        flavors: [{ flavor: 'Chocolate', count: 1 }],
      },
    });
    const draft = session.state.draft;
    const printer = accepted();
    const send = vi.spyOn(printer, 'print');
    await expect(session.submit(printer)).rejects.toThrow('choose a container');
    expect(send).not.toHaveBeenCalled();
    expect(session.state.draft).toEqual(draft);
  });

  it.each(['failed', 'outcome-unknown'] as const)(
    'keeps %s submissions locked, with unknown acknowledgment before deliberate recovery',
    async (status) => {
      const { session } = fixture();
      await session.initialize();
      configure(session);
      await session.submit(new SimulatedPrinter(status, 0));
      const locked = session.state.draft;
      expect(locked?.submittedTicketId).toBe(session.state.ticket?.id);
      if (status === 'outcome-unknown') {
        await session.newOrder();
        await session.print(accepted(), true);
        expect(session.state.draft).toBe(locked);
        expect(session.state.attempts).toHaveLength(1);
      }
      await session.print(accepted(), true, true);
      expect(session.state.draft?.servings).toEqual([]);
      expect(session.state.attempts).toHaveLength(2);
    },
  );

  it('recovers an older accepted locked draft as a fresh order, without resubmitting', async () => {
    const { session, store } = fixture();
    await session.initialize();
    configure(session);
    const locked = { ...session.state.draft! };
    await session.submit(accepted());
    await store.saveDraft({
      ...locked,
      reference: session.state.ticket!.reference,
      submittedTicketId: session.state.ticket!.id,
    });
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.draft?.servings).toEqual([]);
    expect(reload.state.draft?.submittedTicketId).toBeUndefined();
    expect(reload.state.ticket).toEqual(session.state.ticket);
    expect(reload.state.attempts).toHaveLength(1);
  });

  it('rolls back both outcome and next draft when the atomic finish cannot commit', async () => {
    const { session, store } = fixture();
    await session.initialize();
    configure(session);
    const finish = store.finishAttempt.bind(store);
    vi.spyOn(store, 'finishAttempt').mockImplementationOnce((attempt, next) =>
      finish({ ...attempt, ticketId: 'wrong-ticket' }, next),
    );
    await session.submit(accepted());
    expect(session.state.phase).toBe('blocked');
    expect((await store.load())?.attempts[0].result).toBeUndefined();
    expect((await store.loadDraft())?.submittedTicketId).toBe(
      session.state.ticket?.id,
    );
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.attempts[0].result?.status).toBe('outcome-unknown');
    expect(reload.state.draft?.submittedTicketId).toBe(reload.state.ticket?.id);
  });

  it('blocks sends on draft failure and preserves the previous receipt on failed first-intent commit', async () => {
    const { store, session } = fixture();
    await session.initialize();
    configure(session);
    await session.submit(accepted());
    const original = session.state.ticket;
    configure(session);
    vi.spyOn(store, 'startOrder').mockRejectedValue(new Error('quota'));
    const printer = accepted();
    const send = vi.spyOn(printer, 'print');
    await session.submit(printer);
    expect(send).not.toHaveBeenCalled();
    expect(session.state.phase).toBe('blocked');
    expect((await store.load())?.ticket).toEqual(original);
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.draft?.submittedTicketId).toBeUndefined();
    vi.spyOn(store, 'saveDraft').mockRejectedValue(new Error('quota'));
    configure(reload);
    await reload.submit(printer);
    expect(send).not.toHaveBeenCalled();
    expect(reload.state.phase).toBe('blocked');
  });

  it('preserves existing structured tickets and recovers interrupted new orders without advancing', async () => {
    const { store, session } = fixture();
    const legacy = sampleTicket('old', '2026-10-09T20:00:00.000Z');
    await store.saveTicket(legacy);
    await session.initialize();
    expect(session.state.ticket).toEqual(legacy);
    configure(session);
    await session.submit({
      mode: 'star-passprnt',
      label: 'Test',
      print: async () => ({ status: 'handoff', url: 'starpassprnt://test' }),
    });
    const draft = session.state.draft;
    await session.newOrder();
    expect(session.state.draft).toBe(draft);
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.attempts[0].result?.status).toBe('outcome-unknown');
    expect(reload.state.draft?.submittedTicketId).toBe(reload.state.ticket?.id);
  });

  it('rejects invalid advancement and duplicate IDs without changing saved records', async () => {
    const { store, session } = fixture();
    await session.initialize();
    configure(session);
    await session.submit(accepted());
    const saved = await store.load();
    const draft = await store.loadDraft();
    await expect(
      store.finishAttempt(
        {
          ...saved!.attempts[0],
          result: {
            status: 'failed',
            simulated: true,
            code: 'transport',
            message: 'Test',
          },
        },
        newDraft(),
      ),
    ).rejects.toThrow();
    await expect(
      store.startOrder({
        id: 'new-attempt',
        ticketId: saved!.ticket.id,
        mode: 'simulated',
        reprint: false,
        startedAt: saved!.ticket.createdAt,
      }),
    ).rejects.toThrow();
    expect(await store.load()).toEqual(saved);
    expect(await store.loadDraft()).toEqual(draft);
  });
});
