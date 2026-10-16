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

it.each([
  [400, 'Invalid ticket or attempt metadata. No data sent.', 'invalid-ticket'],
  [400, 'Invalid JSON request.', 'invalid-ticket'],
  [403, 'Use the configured same-origin application.', 'permission-denied'],
  [403, 'Unrecognized host.', 'permission-denied'],
  [413, 'Request too large.', 'invalid-ticket'],
])(
  'recognizes the service’s pre-submit rejection %s without retrying',
  async (status, error, code) => {
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({ error }, { status }),
    );
    expect(
      await new LinuxCupsPrinter(send).print(ticket, options),
    ).toMatchObject({
      status: 'failed',
      simulated: false,
      code,
      message: expect.stringContaining('No job was submitted'),
    });
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [
    500,
    { error: 'Service request failed. Inspect CUPS before retrying a print.' },
  ],
  [502, { error: 'Invalid ticket or attempt metadata. No data sent.' }],
  [403, { error: 'Unexpected proxy rejection' }],
  [400, { error: 'Unexpected error' }],
  [
    400,
    {
      error: 'Invalid ticket or attempt metadata. No data sent.',
      attemptId: 'wrong',
    },
  ],
  [
    500,
    {
      attemptId: options.attemptId,
      result: { status: 'accepted', simulated: false, message: 'Done' },
    },
  ],
])(
  'keeps ambiguous HTTP %s replies unknown without retrying',
  async (status, body) => {
    const send = vi.fn<typeof fetch>(async () =>
      Response.json(body, { status }),
    );
    expect(
      (await new LinuxCupsPrinter(send).print(ticket, options)).status,
    ).toBe('outcome-unknown');
    expect(send).toHaveBeenCalledTimes(1);
  },
);

it('recognizes the database gate as a failed submission but treats other 503 replies as unknown', async () => {
  for (const databaseGate of [true, false]) {
    const send = vi.fn<typeof fetch>(async () =>
      Response.json(
        {
          error: 'Database unavailable',
          ...(databaseGate ? { code: 'database-unavailable' } : {}),
        },
        { status: 503 },
      ),
    );
    const result = await new LinuxCupsPrinter(send).print(ticket, options);
    expect(result.status).toBe(databaseGate ? 'failed' : 'outcome-unknown');
    if (databaseGate)
      expect(result.message).toContain('No new job was submitted');
    expect(send).toHaveBeenCalledTimes(1);
  }
});

it('recognizes only structured authentication rejections as definitely unsent and never retries', async () => {
  for (const code of ['authentication-required', undefined]) {
    const send = vi.fn<typeof fetch>(async () =>
      Response.json({ error: 'Sign in to continue.', code }, { status: 401 }),
    );
    const result = await new LinuxCupsPrinter(send).print(ticket, options);
    expect(result.status).toBe(code ? 'failed' : 'outcome-unknown');
    if (code) expect(result.message).toContain('No job was submitted');
    expect(send).toHaveBeenCalledOnce();
  }
});
