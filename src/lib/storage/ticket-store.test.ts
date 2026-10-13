import { expect, it, vi } from 'vitest';
import {
  DatabaseTicketStore,
  parseStationSnapshot,
  parseStationCommand,
} from './ticket-store';
import { newDraft } from '../tickets/order';
import { sampleTicket } from '../tickets/ticket';

it('loads server state and sends ordered revisions without browser storage or retries', async () => {
  const draft = newDraft();
  let revision = 7;
  const send = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'POST') {
      const command = JSON.parse(init.body as string);
      expect(command.revision).toBe(revision);
      revision++;
    }
    expect(init?.cache).toBe('no-store');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ revision, draft });
  });
  const store = new DatabaseTicketStore(send);
  expect(await store.load()).toBeUndefined();
  expect(await store.loadDraft()).toEqual(draft);
  await store.saveDraft(draft);
  await store.saveDraft(draft);
  expect(send).toHaveBeenCalledTimes(3);
});
it.each([409, 503])(
  'blocks failed writes (%s) and never retries them',
  async (status) => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ revision: 0, draft: newDraft() }))
      .mockResolvedValueOnce(Response.json({}, { status }));
    const store = new DatabaseTicketStore(send);
    await store.load();
    await expect(store.saveDraft(newDraft())).rejects.toThrow(
      status === 409 ? 'another tab' : 'Database unavailable',
    );
    expect(send).toHaveBeenCalledTimes(2);
  },
);
it('rejects malformed or mismatched database state and operations', () => {
  const ticket = sampleTicket('ticket', '2026-10-11T20:00:00.000Z');
  expect(() =>
    parseStationSnapshot({ revision: -1, draft: newDraft() }),
  ).toThrow();
  expect(() =>
    parseStationSnapshot({
      revision: 0,
      draft: newDraft(),
      saved: {
        ticket,
        attempts: [
          {
            id: 'a',
            ticketId: 'different',
            mode: 'linux-cups',
            reprint: false,
            startedAt: ticket.createdAt,
          },
        ],
      },
    }),
  ).toThrow();
  expect(() =>
    parseStationCommand({ revision: 0, operation: 'erase' }),
  ).toThrow();
  const snapshot = parseStationSnapshot({
    revision: 0,
    draft: newDraft(),
    saved: { ticket, attempts: [] },
  });
  expect(Object.isFrozen(snapshot.saved?.ticket.servings)).toBe(true);
});
it('requires an affirmative database health response', async () => {
  const store = new DatabaseTicketStore(async () =>
    Response.json({ ready: false }),
  );
  await expect(store.check()).rejects.toThrow();
});
