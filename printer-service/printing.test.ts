import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleTicket } from '../src/lib/tickets/ticket';
import { Cups, type Command } from './cups';
import { parseRequest, Printing } from './printing';
import { receiptLayout, receiptPdf } from './receipt';

const ticket = sampleTicket('ticket-1', '2026-10-11T20:00:00.000Z');
const request = { ticket, attemptId: 'attempt-1', reprint: false };
const options =
  'PageSize/Media Size: *X72MMY100MM X72MMY200MM X72MMY2000MM\nPageType/Page Type: *Variable0 Fixed1\nPageCutType/Page Cut Type: *NoCutPage0 PartialCutPage1\nDocCutType/Document Cut Type: *PartialCutDoc1 NoCutDoc0';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
const directory = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'order-pad-test-'));
  dirs.push(dir);
  return dir;
};
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
      parseRequest({ ...request, ticket: { ...ticket, items: [] } }),
    ).toThrow();
    expect(() => new Cups('-h remote')).toThrow();
    expect(parseRequest(request).ticket).toEqual(ticket);
  });
  it('selects the smallest supported receipt size without scaling or truncation', async () => {
    const cups = new Cups('OrderPad', runner());
    expect(await cups.prepare(120)).toEqual({
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
    expect(await new Cups('OrderPad', run).prepare(120)).toEqual({
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
  it('persists intent before lp, passes PDF on stdin, submits one copy with documented cut options', async () => {
    const dir = await directory();
    const run = runner();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (program, args, input) => {
      if (program === 'lp') {
        expect(
          JSON.parse(await readFile(join(dir, 'attempt-1.json'), 'utf8')),
        ).toEqual({ request });
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
      dir,
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
    const dir = await directory();
    await writeFile(join(dir, 'attempt-1.json'), JSON.stringify({ request }));
    const run = runner();
    const printing = new Printing(
      new Cups('OrderPad', run),
      dir,
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
  it('blocks overlapping jobs and saves a deliberate reprint as a separate attempt', async () => {
    const dir = await directory();
    let finish!: (value: string) => void;
    let submitted!: () => void;
    const reached = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    const run = runner();
    const original = run.getMockImplementation()!;
    run.mockImplementation((program, args, input) =>
      program === 'lp'
        ? new Promise((resolve) => {
            finish = resolve;
            submitted();
          })
        : original(program, args, input),
    );
    const render = vi.fn<typeof receiptPdf>(async () =>
      Buffer.from('%PDF-test'),
    );
    const printing = new Printing(
      new Cups('OrderPad', run),
      dir,
      'Courier',
      render,
    );
    const first = printing.print(request);
    await reached;
    expect(
      (await printing.print({ ...request, attemptId: 'attempt-2' })).status,
    ).toBe('failed');
    expect((await printing.print(request)).status).toBe('outcome-unknown');
    finish('request id is OrderPad-42 (1 file(s))');
    await first;
    run.mockImplementation(original);
    expect(
      (
        await printing.print({
          ...request,
          attemptId: 'attempt-2',
          reprint: true,
        })
      ).status,
    ).toBe('accepted');
    expect(render.mock.calls[1][1]).toBe(true);
    expect(
      JSON.parse(await readFile(join(dir, 'attempt-2.json'), 'utf8')).request
        .ticket.id,
    ).toBe(ticket.id);
  });
  it('does not send when PDF preparation fails or the attempt journal is inaccessible', async () => {
    const dir = await directory();
    const run = runner();
    const printing = new Printing(
      new Cups('OrderPad', run),
      dir,
      'Courier',
      async () => {
        throw new Error('Missing font');
      },
    );
    expect((await printing.print(request)).status).toBe('failed');
    const corrupt = join(dir, 'broken');
    await writeFile(corrupt, 'not a directory');
    const broken = new Printing(new Cups('OrderPad', run), corrupt, 'Courier');
    expect((await broken.print(request)).status).toBe('failed');
    expect(run.mock.calls.filter(([program]) => program === 'lp')).toHaveLength(
      0,
    );
  });
  it('renders one receipt PDF including a reprint without changing the ticket', async () => {
    const layout = receiptLayout(ticket, true);
    expect(layout.lines[0].text).toBe('REPRINT');
    expect(layout.lines.some((line) => line.text === 'ORDER #0042')).toBe(true);
    expect(layout.heightMm).toBeLessThan(200);
    const pdf = await receiptPdf(ticket, true, 'Courier', 200);
    expect(pdf.toString('ascii').startsWith('%PDF-')).toBe(true);
    expect(pdf.toString('ascii').match(/\/Type \/Page\b/g)).toHaveLength(1);
    await expect(receiptPdf(ticket, false, 'Courier', 30)).rejects.toThrow(
      'short',
    );
    expect(ticket.id).toBe('ticket-1');
  });
});
