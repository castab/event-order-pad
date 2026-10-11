import { describe, expect, it, vi } from 'vitest';
import { sampleTicket } from '../../tickets/ticket';
import { LinuxCupsPrinter } from './linux-cups';

const ticket = sampleTicket('ticket-1', '2026-10-11T20:00:00.000Z');
const options = { attemptId: 'attempt-1', reprint: false };
describe('Linux browser adapter', () => {
  it('sends the immutable domain ticket and correlates accepted queue submission', async () => {
    const result = {
      status: 'accepted',
      simulated: false,
      message: 'CUPS accepted the queue submission.',
    };
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({ attemptId: options.attemptId, result }),
    );
    expect(await new LinuxCupsPrinter(send).print(ticket, options)).toEqual(
      result,
    );
    expect(send.mock.calls[0][0]).toBe('/api/print');
    expect(JSON.parse(send.mock.calls[0][1]!.body as string)).toEqual({
      ticket,
      ...options,
    });
  });
  it('preserves known pre-submit failure without falling back to simulation', async () => {
    const result = {
      status: 'failed',
      code: 'printer-busy',
      simulated: false,
      message: 'A CUPS job is pending.',
    };
    expect(
      await new LinuxCupsPrinter(async () =>
        Response.json({ attemptId: options.attemptId, result }),
      ).print(ticket, options),
    ).toEqual(result);
  });
  it('treats timeouts, malformed replies, wrong attempt IDs and simulated replies as unknown without retry', async () => {
    for (const value of [
      undefined,
      {},
      {
        attemptId: 'wrong',
        result: { status: 'accepted', simulated: false, message: 'Done' },
      },
      {
        attemptId: options.attemptId,
        result: { status: 'accepted', simulated: true, message: 'Mock' },
      },
    ]) {
      const send = vi.fn<typeof fetch>(async () => {
        if (!value) throw new Error('Timeout');
        return Response.json(value);
      });
      expect(
        (await new LinuxCupsPrinter(send).print(ticket, options)).status,
      ).toBe('outcome-unknown');
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
