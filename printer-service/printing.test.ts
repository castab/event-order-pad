import { describe, expect, it, vi } from 'vitest';
import { MemoryPrintJournal } from '../tests/helpers/station';
import { sampleTicket } from '../src/lib/tickets/ticket';
import { Cups, type Command } from './cups';
import { parseRequest, Printing } from './printing';
import { receiptLayout, receiptPdf } from './receipt';

const ticket = sampleTicket('ticket-1', '2026-10-11T20:00:00.000Z');
const request = { ticket, attemptId: 'attempt-1', reprint: false };
const options =
  'PageSize/Media Size: *X72MMY100MM X72MMY200MM X72MMY2000MM\nPageType/Page Type: *Variable0 Fixed1\nPageCutType/Page Cut Type: *NoCutPage0 PartialCutPage1\nDocCutType/Document Cut Type: *PartialCutDoc1 NoCutDoc0';
function runner() {
  return vi.fn<Command>(async (program, args) => {
    if (program === 'lpoptions') return options;
    if (program === 'lpstat')
      return args.includes('-o')
        ? ''
        : 'printer OrderPad is idle\nOrderPad accepting requests\ndevice for OrderPad: usb://Star/TSP143IIIU';
    return 'request id is OrderPad-42 (1 file(s))\n';
  });
}

describe('Linux CUPS printing', () => {
  it('validates untrusted input, attempt IDs and configured queue names', () => {
    expect(() =>
      parseRequest({ ...request, attemptId: '../escape' }),
    ).toThrow();
    expect(() => parseRequest({ ...request, attemptId: 1 })).toThrow();
    expect(() => parseRequest({ ...request, reprint: 'false' })).toThrow();
    expect(() =>
      parseRequest({ ...request, ticket: { ...ticket, servings: [] } }),
    ).toThrow();
    expect(() => new Cups('-h remote')).toThrow();
    expect(parseRequest(request).ticket).toEqual(ticket);
  });
  it('selects the smallest supported receipt size without scaling or truncation', async () => {
    const cups = new Cups('OrderPad', runner());
    expect(await cups.prepare(120)).toMatchObject({
      media: 'X72MMY200MM',
      heightMm: 200,
    });
    await expect(cups.prepare(2001)).rejects.toThrow('suitable');
    const run = runner();
    run.mockImplementation(async (program, args) =>
      program === 'lpoptions'
        ? options.replace('X72MMY100MM', 'Custom')
        : args.includes('-o')
          ? ''
          : 'device: usb://Star/TSP143IIIU',
    );
    expect(await new Cups('OrderPad', run).prepare(120)).toMatchObject({
      media: 'Custom.72x120mm',
      heightMm: 120,
    });
  });
  it('rejects wrong driver, network queue, disabled queue and pending jobs before sending', async () => {
    for (const replacement of [
      'device: socket://printer',
      'printer OrderPad disabled\ndevice: usb://Star/TSP',
      'device: usb://Star/TSP',
    ]) {
      const run = runner();
      run.mockImplementation(async (program, args) =>
        program === 'lpoptions'
          ? options
          : args.includes('-o')
            ? 'OrderPad-41 user pending'
            : replacement,
      );
      await expect(new Cups('OrderPad', run).prepare(100)).rejects.toThrow();
      expect(run.mock.calls.some(([program]) => program === 'lp')).toBe(false);
    }
    const run = runner();
    run.mockImplementation(async (program) =>
      program === 'lpoptions' ? 'PageSize/Size: A4' : 'device: usb://Star/TSP',
    );
    await expect(new Cups('OrderPad', run).check()).rejects.toThrow(
      'Star TSP100',
    );
  });
  it('uses the actual Mint Star driver keywords and supported 72 mm stock', async () => {
    const installed =
      'PageSize/Media Size: X50D8MMY200MM *X72MMY100MM X72MMY180MM X72MMY2000MM Custom.WIDTHxHEIGHT\nPageType/2. Page Type: *0Variable 1Fixed\nPageCutType/1. Page Cut Type: *0NoCutPage 1PartialCutPage\nDocCutType/2. Document Cut Type: 0NoCutDoc *1PartialCutDoc';
    const run = runner();
    const original = run.getMockImplementation()!;
    run.mockImplementation((program, args, input) =>
      program === 'lpoptions'
        ? Promise.resolve(installed)
        : original(program, args, input),
    );
    const cups = new Cups('OrderPad', run);
    const paper = await cups.prepare(171);
    expect(paper).toMatchObject({
      media: 'X72MMY180MM',
      heightMm: 180,
    });
    await cups.check(); // A concurrent readiness check cannot alter this prepared job.
    await cups.submit(
      Buffer.from('%PDF-test'),
      paper.media,
      'attempt-1',
      paper.jobOptions,
    );
    const args = run.mock.calls.find(([program]) => program === 'lp')![1];
    expect(args).toContain('PageType=0Variable');
    expect(args).toContain('PageCutType=0NoCutPage');
    expect(args).toContain('DocCutType=1PartialCutDoc');
    expect(args).not.toContain('PageType=Variable0');
    await expect(cups.prepare(2001)).rejects.toThrow('2000 mm');
    run.mockImplementation(async (program, args) =>
      program === 'lpoptions'
        ? installed.replace('1PartialCutDoc', '1Unsupported')
        : args.includes('-o')
          ? ''
          : 'device: usb://Star/TSP',
    );
    await expect(cups.prepare(171)).rejects.toThrow('Star TSP100');
  });
  it('persists intent before lp, passes PDF on stdin, submits one copy with documented cut options', async () => {
    const journal = new MemoryPrintJournal();
    const run = runner();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (program, args, input) => {
      if (program === 'lp') {
        expect(await journal.get('attempt-1')).toEqual({ request });
        expect(input?.toString()).toBe('%PDF-test');
        expect(args).toContain('DocCutType=PartialCutDoc1');
        expect(args).toContain('PageType=Variable0');
        expect(args.slice(args.indexOf('-n'), args.indexOf('-n') + 2)).toEqual([
          '-n',
          '1',
        ]);
      }
      return original(program, args, input);
    });
    const printing = new Printing(
      new Cups('OrderPad', run),
      journal,
      'Courier',
      async () => Buffer.from('%PDF-test'),
    );
    const result = await printing.print(request);
    expect(result.status).toBe('accepted');
    expect(result.message).toContain('queue submission only');
    expect(await printing.print(request)).toEqual(result);
    expect(run.mock.calls.filter(([program]) => program === 'lp')).toHaveLength(
      1,
    );
    expect((await printing.print({ ...request, reprint: true })).status).toBe(
      'failed',
    );
  });
  it('never replays pending intent after a restart or retries a missing lp result', async () => {
    const journal = new MemoryPrintJournal();
    await journal.begin(request);
    const run = runner();
    const printing = new Printing(
      new Cups('OrderPad', run),
      journal,
      'Courier',
      async () => Buffer.from('%PDF-test'),
    );
    expect((await printing.print(request)).status).toBe('outcome-unknown');
    expect(run).not.toHaveBeenCalled();
    run.mockImplementation(async (program, args) => {
      if (program === 'lp') throw new Error('Lost response');
      return program === 'lpoptions'
        ? options
        : args.includes('-o')
          ? ''
          : 'device: usb://Star/TSP';
    });
    const next = { ...request, attemptId: 'attempt-2', reprint: true };
    expect((await printing.print(next)).status).toBe('outcome-unknown');
    expect((await printing.print(next)).status).toBe('outcome-unknown');
    expect(run.mock.calls.filter(([program]) => program === 'lp')).toHaveLength(
      1,
    );
  });
  it('serializes overlapping jobs, coalesces duplicates and preserves deliberate reprints', async () => {
    const journal = new MemoryPrintJournal();
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = runner();
    const original = run.getMockImplementation()!;
    let count = 0;
    run.mockImplementation(async (program, args, input) => {
      if (program === 'lp' && ++count === 1) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return original(program, args, input);
    });
    const render = vi.fn<typeof receiptPdf>(async () =>
      Buffer.from('%PDF-test'),
    );
    const printing = new Printing(
      new Cups('OrderPad', run),
      journal,
      'Courier',
      render,
    );
    const first = printing.print(request);
    await reached;
    const duplicate = printing.print(request);
    expect(duplicate).toBe(first);
    expect((await printing.print({ ...request, reprint: true })).status).toBe(
      'failed',
    );
    const second = printing.print({
      ...request,
      attemptId: 'attempt-2',
      reprint: true,
    });
    expect(render).toHaveBeenCalledTimes(1);
    release();
    expect((await first).status).toBe('accepted');
    expect((await duplicate).status).toBe('accepted');
    expect((await second).status).toBe('accepted');
    expect(render.mock.calls[1][1]).toBe(true);
    expect(run.mock.calls.filter(([program]) => program === 'lp')).toHaveLength(
      2,
    );
    expect((await journal.get('attempt-2'))!.request.ticket.id).toBe(ticket.id);
  });
  it('admits waiting requests in arrival order and rejects a ninth waiter without submitting', async () => {
    const journal = new MemoryPrintJournal();
    let release!: () => void;
    let entered!: () => void;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const run = runner();
    const original = run.getMockImplementation()!;
    const submitted: string[] = [];
    run.mockImplementation(async (program, args, input) => {
      if (program === 'lp') {
        submitted.push(args[args.indexOf('-t') + 1]);
        if (submitted.length === 1) {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }
      return original(program, args, input);
    });
    const printing = new Printing(
      new Cups('OrderPad', run),
      journal,
      'Courier',
      async () => Buffer.from('%PDF-test'),
    );
    const at = (n: number) => ({ ...request, attemptId: `attempt-${n}` });
    const first = printing.print(at(1));
    await reached;
    const waiting = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => printing.print(at(n)));
    const overflow = await printing.print(at(10));
    expect(overflow).toMatchObject({ status: 'failed', code: 'printer-busy' });
    expect(overflow.message).toContain('No job was submitted');
    expect(await journal.get('attempt-10')).toBeUndefined();
    release();
    expect((await first).status).toBe('accepted');
    for (const result of await Promise.all(waiting))
      expect(result.status).toBe('accepted');
    expect(submitted).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `OrderPad-attempt-${n}`),
    );
  });
  it('fails a request that waits 30 seconds for the submission slot without saving intent', async () => {
    vi.useFakeTimers();
    try {
      const journal = new MemoryPrintJournal();
      let release!: () => void;
      const run = runner();
      const original = run.getMockImplementation()!;
      let lp = 0;
      run.mockImplementation(async (program, args, input) => {
        if (program === 'lp' && ++lp === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return original(program, args, input);
      });
      const printing = new Printing(
        new Cups('OrderPad', run),
        journal,
        'Courier',
        async () => Buffer.from('%PDF-test'),
      );
      const first = printing.print(request);
      await vi.waitFor(() => expect(lp).toBe(1));
      const second = printing.print({ ...request, attemptId: 'attempt-2' });
      await vi.advanceTimersByTimeAsync(30000);
      const result = await second;
      expect(result).toMatchObject({ status: 'failed', code: 'printer-busy' });
      expect(result.message).toContain('No job was submitted');
      expect(await journal.get('attempt-2')).toBeUndefined();
      release();
      expect((await first).status).toBe('accepted');
      expect(lp).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it('waits for pending CUPS jobs to clear, then submits once', async () => {
    vi.useFakeTimers();
    try {
      const journal = new MemoryPrintJournal();
      const run = runner();
      const original = run.getMockImplementation()!;
      let checks = 0;
      run.mockImplementation(async (program, args, input) => {
        if (program === 'lpstat' && args.includes('-o') && ++checks <= 3)
          return 'OrderPad-7 user 1024 Mon 13 Oct 2026';
        return original(program, args, input);
      });
      const printing = new Printing(
        new Cups('OrderPad', run),
        journal,
        'Courier',
        async () => Buffer.from('%PDF-test'),
      );
      const result = printing.print(request);
      await vi.advanceTimersByTimeAsync(3000);
      expect((await result).status).toBe('accepted');
      expect(
        run.mock.calls.filter(([program]) => program === 'lp'),
      ).toHaveLength(1);
      expect((await journal.get('attempt-1'))?.result?.status).toBe('accepted');
    } finally {
      vi.useRealTimers();
    }
  });
  it('persists a failed outcome when the CUPS queue does not clear within 30 seconds', async () => {
    vi.useFakeTimers();
    try {
      const journal = new MemoryPrintJournal();
      const run = runner();
      const original = run.getMockImplementation()!;
      run.mockImplementation(async (program, args, input) =>
        program === 'lpstat' && args.includes('-o')
          ? 'OrderPad-7 user 1024 Mon 13 Oct 2026'
          : original(program, args, input),
      );
      const printing = new Printing(
        new Cups('OrderPad', run),
        journal,
        'Courier',
        async () => Buffer.from('%PDF-test'),
      );
      const result = printing.print(request);
      await vi.advanceTimersByTimeAsync(31000);
      expect(await result).toMatchObject({ status: 'failed' });
      expect((await result).message).toContain('No job was submitted');
      expect((await journal.get('attempt-1'))?.result?.status).toBe('failed');
      expect(
        run.mock.calls.filter(([program]) => program === 'lp'),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('never submits an attempt that was finalized while it waited', async () => {
    const journal = new MemoryPrintJournal();
    const run = runner();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (program, args, input) => {
      if (program === 'lpstat' && args.includes('-o')) {
        const record = await journal.get('attempt-1');
        if (record && !record.result)
          await journal.finish(record.request, {
            status: 'outcome-unknown',
            simulated: false,
            code: 'transport',
            message: 'Recovered as unknown.',
          });
      }
      return original(program, args, input);
    });
    const printing = new Printing(
      new Cups('OrderPad', run),
      journal,
      'Courier',
      async () => Buffer.from('%PDF-test'),
    );
    expect((await printing.print(request)).status).toBe('outcome-unknown');
    expect(run.mock.calls.filter(([program]) => program === 'lp')).toHaveLength(
      0,
    );
    expect((await journal.get('attempt-1'))?.result?.message).toBe(
      'Recovered as unknown.',
    );
  });
  it('does not send when PDF preparation fails or the database is inaccessible', async () => {
    const journal = new MemoryPrintJournal();
    const run = runner();
    const printing = new Printing(
      new Cups('OrderPad', run),
      journal,
      'Courier',
      async () => {
        throw new Error('Missing font');
      },
    );
    expect((await printing.print(request)).status).toBe('failed');
    const brokenJournal = new MemoryPrintJournal();
    vi.spyOn(brokenJournal, 'get').mockRejectedValue(
      new Error('Database down'),
    );
    const broken = new Printing(
      new Cups('OrderPad', run),
      brokenJournal,
      'Courier',
    );
    expect((await broken.print(request)).status).toBe('failed');
    expect(run.mock.calls.filter(([program]) => program === 'lp')).toHaveLength(
      0,
    );
  });
  it('renders one receipt PDF including a reprint without changing the ticket', async () => {
    const layout = receiptLayout(ticket, true);
    expect(layout.lines[0].text).toBe('REPRINT');
    expect(layout.lines.some((line) => line.text === 'ORDER #0043')).toBe(true);
    expect(layout.heightMm).toBeLessThan(400);
    const pdf = await receiptPdf(ticket, true, 'Courier', layout.heightMm);
    expect(pdf.toString('ascii').startsWith('%PDF-')).toBe(true);
    expect(pdf.toString('ascii').match(/\/Type \/Page\b/g)).toHaveLength(1);
    await expect(receiptPdf(ticket, false, 'Courier', 30)).rejects.toThrow(
      'short',
    );
    expect(ticket.id).toBe('ticket-1');
  });
});

it('limits the FIFO to eight waiting requests and expires them without dispatch', async () => {
  vi.useFakeTimers();
  try {
    const journal = new MemoryPrintJournal();
    const cups = new Cups('OrderPad', runner());
    vi.spyOn(cups, 'waitUntilIdle').mockResolvedValue();
    vi.spyOn(cups, 'prepare').mockResolvedValue({
      media: 'test',
      heightMm: 200,
      jobOptions: [],
    });
    let release!: (job: string) => void;
    const submit = vi.spyOn(cups, 'submit').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const printing = new Printing(cups, journal, 'Courier', async () =>
      Buffer.from('%PDF-test'),
    );
    const active = printing.print(request);
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const waiting = Array.from({ length: 8 }, (_, i) =>
      printing.print({ ...request, attemptId: 'waiting-' + i }),
    );
    expect(
      (await printing.print({ ...request, attemptId: 'overflow' })).message,
    ).toContain('queue is full');
    await vi.advanceTimersByTimeAsync(30000);
    for (const pending of waiting) {
      expect((await pending).status).toBe('failed');
      expect((await pending).message).toContain('No job was submitted');
    }
    expect(journal.records.size).toBe(1);
    release('OrderPad-1');
    expect((await active).status).toBe('accepted');
    expect(submit).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it('waits for CUPS to clear and refuses submission after its 30-second deadline', async () => {
  let elapsed = 0;
  let checks = 0;
  const run = vi.fn<Command>(async () =>
    ++checks < 3 ? 'OrderPad-1 pending' : '',
  );
  const cups = new Cups('OrderPad', run);
  await cups.waitUntilIdle(
    () => elapsed,
    async (ms) => {
      elapsed += ms;
    },
  );
  expect(elapsed).toBe(2000);
  run.mockResolvedValue('OrderPad-1 pending');
  elapsed = 0;
  await expect(
    cups.waitUntilIdle(
      () => elapsed,
      async (ms) => {
        elapsed += ms;
      },
    ),
  ).rejects.toThrow('30 seconds');
  expect(elapsed).toBe(30000);
  const journal = new MemoryPrintJournal();
  vi.spyOn(cups, 'waitUntilIdle').mockRejectedValue(
    new Error('Still pending after 30 seconds.'),
  );
  const submit = vi.spyOn(cups, 'submit');
  const printing = new Printing(cups, journal, 'Courier');
  const result = await printing.print(request);
  expect(result.status).toBe('failed');
  expect(result.message).toContain('No job was submitted');
  expect((await journal.get(request.attemptId))?.result).toEqual(result);
  expect(submit).not.toHaveBeenCalled();
});

it('rechecks attempts finalized during CUPS waiting and never sends them', async () => {
  const journal = new MemoryPrintJournal();
  const cups = new Cups('OrderPad', runner());
  vi.spyOn(cups, 'waitUntilIdle').mockImplementation(async () => {
    await journal.finish(request, {
      status: 'outcome-unknown',
      simulated: false,
      code: 'transport',
      message: 'Recovered while waiting.',
    });
  });
  const submit = vi.spyOn(cups, 'submit');
  const printing = new Printing(cups, journal, 'Courier', async () =>
    Buffer.from('%PDF-test'),
  );
  expect((await printing.print(request)).status).toBe('outcome-unknown');
  expect(submit).not.toHaveBeenCalled();
  expect(
    (await new Printing(cups, journal, 'Courier').print(request)).message,
  ).toBe('Recovered while waiting.');
});

it('closes by refusing new prints and waiting for the job already sent to lp', async () => {
  const journal = new MemoryPrintJournal();
  const cups = new Cups('OrderPad', runner());
  vi.spyOn(cups, 'waitUntilIdle').mockResolvedValue();
  vi.spyOn(cups, 'prepare').mockResolvedValue({
    media: 'test',
    heightMm: 200,
    jobOptions: [],
  });
  let release!: (job: string) => void;
  const submit = vi.spyOn(cups, 'submit').mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const printing = new Printing(cups, journal, 'Courier', async () =>
    Buffer.from('%PDF-test'),
  );
  const active = printing.print(request);
  await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  const waiting = printing.print({ ...request, attemptId: 'waiting' });
  let closed = false;
  const closing = printing.close().then(() => {
    closed = true;
  });
  expect((await waiting).message).toBe(
    'The service is restarting. No job was submitted.',
  );
  expect((await printing.print({ ...request, attemptId: 'late' })).status).toBe(
    'failed',
  );
  expect(closed).toBe(false);
  release('OrderPad-7');
  await closing;
  expect((await active).status).toBe('accepted');
  expect((await journal.get('attempt-1'))?.result?.status).toBe('accepted');
  expect(await journal.get('waiting')).toBeUndefined();
  expect(submit).toHaveBeenCalledTimes(1);
});
