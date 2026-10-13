import { describe, expect, it, vi } from 'vitest';
import { MemoryTicketStore } from '../../../tests/helpers/ticket-store';
import { PrintSession } from './session';
import { sampleTicket } from '../tickets/ticket';
import { SimulatedPrinter } from './adapters/simulated';
import { passPrntReturn } from './adapters/passprnt';
import type { PrintAttemptResult, TicketPrinter } from './port';

async function fixture() {
  const store = new MemoryTicketStore();
  let id = 0;
  const session = new PrintSession(
    store,
    () => {},
    () => `id-${++id}`,
    () => new Date(1791576000000 + id).toISOString(),
  );
  await store.saveTicket(
    sampleTicket('fixture-ticket', '2026-10-09T20:00:00.000Z'),
  );
  return { store, session };
}

describe('durable print state', () => {
  it('keeps external launch pending until a matching callback and never prepares two launches', async () => {
    const { store, session } = await fixture();
    await session.initialize();
    const print = vi.fn(async (_ticket, options) => {
      expect((await store.load())?.attempts[0].id).toBe(options.attemptId);
      return { status: 'handoff' as const, url: 'starpassprnt://prepared' };
    });
    const printer: TicketPrinter = {
      mode: 'star-passprnt',
      label: 'stub',
      print,
    };
    await session.print(printer, false);
    expect(session.state.phase).toBe('handoff');
    expect(session.state.attempts[0].result).toBeUndefined();
    await session.print(printer, true);
    expect(print).toHaveBeenCalledTimes(1);
    const attemptId = session.state.attempts[0].id;
    const returned = passPrntReturn(
      `https://pad.example/?order_pad_attempt=${attemptId}&passprnt_code=0`,
    );
    const reload = new PrintSession(store, () => {});
    await reload.initialize(returned);
    expect(reload.state.attempts[0].result?.status).toBe('accepted');
    expect((await store.load())?.attempts[0].result?.status).toBe('accepted');
    // A repeated or contradictory callback cannot rewrite a final result.
    const repeated = new PrintSession(store, () => {});
    await repeated.initialize({
      ...returned!,
      result: {
        status: 'outcome-unknown',
        code: 'transport',
        simulated: false,
        message: 'late',
      },
    });
    expect(repeated.state.attempts[0].result?.status).toBe('accepted');
  });
  it.each(['mismatched-id', 'wrong-mode', 'no-return'] as const)(
    'recovers handoff as unknown on %s without treating it as success',
    async (reason) => {
      const { store, session } = await fixture();
      await session.initialize();
      const printer: TicketPrinter = {
        mode: 'star-passprnt',
        label: 'stub',
        print: async () => ({
          status: 'handoff',
          url: 'starpassprnt://prepared',
        }),
      };
      await session.print(printer, false);
      const returned = {
        attemptId:
          reason === 'mismatched-id' ? 'wrong' : session.state.attempts[0].id,
        mode:
          reason === 'wrong-mode'
            ? ('simulated' as const)
            : ('star-passprnt' as const),
        result: {
          status: 'accepted' as const,
          simulated: false,
          message: 'stub',
        },
      };
      const reload = new PrintSession(store, () => {});
      await reload.initialize(reason === 'no-return' ? undefined : returned);
      expect(reload.state.attempts[0].result?.status).toBe('outcome-unknown');
    },
  );
  it.each(['accepted', 'failed', 'outcome-unknown'] as const)(
    'records %s and recovers after reload without retry',
    async (scenario) => {
      const { store, session } = await fixture();
      await session.initialize();
      const printer = new SimulatedPrinter(scenario, 0);
      const send = vi.spyOn(printer, 'print');
      await session.print(printer, false);
      expect(session.state.phase).toBe('ready');
      expect(session.state.attempts[0].result?.status).toBe(scenario);
      expect(printer.preview).toContain('ORDER #0043');
      const reloaded = new PrintSession(store, () => {});
      await reloaded.initialize();
      expect(reloaded.state.ticket?.id).toBe(session.state.ticket?.id);
      expect(reloaded.state.attempts[0].result?.status).toBe(scenario);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it('saves ticket and pending attempt before entering the printer port', async () => {
    const { store, session } = await fixture();
    await session.initialize();
    const printer: TicketPrinter = {
      mode: 'simulated',
      label: 'stub',
      async print(ticket) {
        const saved = await store.load();
        expect(saved?.ticket.id).toBe(ticket.id);
        expect(saved?.attempts).toHaveLength(1);
        expect(saved?.attempts[0].result).toBeUndefined();
        return { status: 'accepted', simulated: true, message: 'stub only' };
      },
    };
    await session.print(printer, false);
  });
  it('prevents concurrent taps and requires explicit reprint after any attempt', async () => {
    const { session } = await fixture();
    await session.initialize();
    let release!: (result: PrintAttemptResult) => void;
    const print = vi.fn(
      () =>
        new Promise<PrintAttemptResult>((resolve) => {
          release = resolve;
        }),
    );
    const printer: TicketPrinter = { mode: 'simulated', label: 'stub', print };
    const first = session.print(printer, false);
    await session.print(printer, false);
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    release({
      status: 'outcome-unknown',
      code: 'timeout',
      simulated: true,
      message: 'stub only',
    });
    await first;
    await session.print(printer, false);
    expect(print).toHaveBeenCalledTimes(1);
    const originalId = session.state.ticket!.id;
    const simulator = new SimulatedPrinter('accepted', 0);
    await session.print(simulator, true, true);
    expect(simulator.preview).toMatch(/^REPRINT\n/);
    expect(session.state.ticket!.id).toBe(originalId);
    expect(session.state.attempts).toHaveLength(2);
    expect(session.state.attempts[0].result?.status).toBe('outcome-unknown');
    expect(session.state.attempts[1].reprint).toBe(true);
  });
  it('recovers pending intent as unknown, never sends during initialize', async () => {
    const { store, session } = await fixture();
    await session.initialize();
    await store.startAttempt({
      id: 'interrupted',
      ticketId: session.state.ticket!.id,
      mode: 'star-usb',
      startedAt: '2026-10-09T21:00:00Z',
      reprint: false,
    });
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.attempts[0].result?.status).toBe('outcome-unknown');
    expect((await store.load())?.attempts[0].result?.status).toBe(
      'outcome-unknown',
    );
  });
  it('blocks printing on storage failure before send', async () => {
    const { store, session } = await fixture();
    await session.initialize();
    vi.spyOn(store, 'startAttempt').mockRejectedValue(new Error('quota'));
    const printer = new SimulatedPrinter('accepted', 0);
    const send = vi.spyOn(printer, 'print');
    await session.print(printer, false);
    expect(send).not.toHaveBeenCalled();
    expect(session.state.phase).toBe('blocked');
  });
  it('keeps pending intent recoverable when saving the final result fails', async () => {
    const { store, session } = await fixture();
    await session.initialize();
    vi.spyOn(store, 'finishAttempt').mockRejectedValueOnce(new Error('quota'));
    await session.print(new SimulatedPrinter('accepted', 0), false);
    expect(session.state.phase).toBe('blocked');
    expect((await store.load())?.attempts[0].result).toBeUndefined();
    const reload = new PrintSession(store, () => {});
    await reload.initialize();
    expect(reload.state.attempts[0].result?.status).toBe('outcome-unknown');
  });
  it('conservatively records an adapter exception as unknown', async () => {
    const { session } = await fixture();
    await session.initialize();
    await session.print(
      {
        mode: 'star-passprnt',
        label: 'stub',
        print: async () => {
          throw new Error('interrupted');
        },
      },
      false,
    );
    expect(session.state.attempts[0].result?.status).toBe('outcome-unknown');
  });
  it('rejects replacing immutable ticket contents or a final outcome', async () => {
    const { store, session } = await fixture();
    await session.initialize();
    await expect(
      store.saveTicket({ ...session.state.ticket!, reference: '9999' }),
    ).rejects.toThrow();
    await session.print(new SimulatedPrinter('accepted', 0), false);
    await expect(
      store.finishAttempt(session.state.attempts[0]),
    ).rejects.toThrow();
  });
});
