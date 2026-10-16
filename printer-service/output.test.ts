import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PdfOutput } from './output';
import { Printing } from './printing';
import { receiptLayout } from './receipt';
import { sampleTicket } from '../src/lib/tickets/ticket';
import { MemoryPrintJournal } from '../tests/helpers/station';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const font = resolve('static/fonts/poppins-400.ttf');
const ticket = sampleTicket('pdf-ticket', '2026-10-14T20:00:00.000Z');
const request = { ticket, attemptId: 'pdf-attempt', reprint: false };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'order-pad-pdf-'));
  directories.push(directory);
  return {
    directory,
    output: new PdfOutput(directory, font),
    journal: new MemoryPrintJournal(),
  };
}

it('saves real single-page PDFs through the journal, with separate reprints and no replay', async () => {
  const { directory, output, journal } = await fixture();
  const submit = vi.spyOn(output, 'submit');
  const begin = vi.spyOn(journal, 'begin');
  const printing = new Printing(output, journal, font);
  const result = await printing.print(request);
  expect(result).toMatchObject({ status: 'accepted', simulated: true });
  expect(begin.mock.invocationCallOrder[0]).toBeLessThan(
    submit.mock.invocationCallOrder[0],
  );
  const pdf = await output.read(request.attemptId);
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  const source = pdf.toString('latin1');
  expect(source.match(/\/Type \/Page\b/g)).toHaveLength(1);
  const box = source.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/)!;
  expect(Number(box[1])).toBeCloseTo((72 * 72) / 25.4, 4);
  expect(Number(box[2])).toBeCloseTo(
    (Math.max(30, receiptLayout(ticket, false).heightMm) * 72) / 25.4,
    4,
  );
  expect(await printing.print(request)).toEqual(result);
  expect(await new Printing(output, journal, font).print(request)).toEqual(
    result,
  );
  expect(submit).toHaveBeenCalledTimes(1);
  await printing.print({ ...request, attemptId: 'pdf-reprint', reprint: true });
  expect(
    receiptLayout(ticket, true).nodes.some(
      (node) => node.kind === 'text' && node.text.includes('REPRINT'),
    ),
  ).toBe(true);
  expect(await output.read('pdf-reprint')).not.toEqual(pdf);
  expect((await readdir(directory)).sort()).toEqual([
    'pdf-attempt.pdf',
    'pdf-reprint.pdf',
  ]);
});

it('checks fonts and directories, limits height, and rejects unsafe or existing filenames', async () => {
  const { directory, output } = await fixture();
  await output.check();
  expect((await output.prepare(1)).heightMm).toBe(30);
  for (const height of [0, NaN, 2001])
    await expect(output.prepare(height)).rejects.toThrow();
  await expect(new PdfOutput(directory, '').check()).rejects.toThrow(
    'ORDER_PAD_FONT',
  );
  await expect(
    new PdfOutput(directory, join(directory, 'missing.ttf')).check(),
  ).rejects.toThrow();
  const file = join(directory, 'file');
  await writeFile(file, 'blocked');
  await expect(new PdfOutput(file, font).check()).rejects.toThrow();
  await expect(output.read('../escape')).rejects.toThrow('Invalid attempt');
  await output.submit(Buffer.from('first'), '', 'existing');
  await expect(
    output.submit(Buffer.from('second'), '', 'existing'),
  ).rejects.toThrow('already exists');
  expect(await readFile(join(directory, 'existing.pdf'), 'utf8')).toBe('first');
});

it('does not submit when intent or rendering fails, and never replays interrupted saving', async () => {
  const { output, journal } = await fixture();
  const submit = vi.spyOn(output, 'submit');
  vi.spyOn(journal, 'begin').mockRejectedValueOnce(new Error('Database down'));
  expect(
    (await new Printing(output, journal, font).print(request)).status,
  ).toBe('failed');
  const brokenRender = vi.fn(async () => {
    throw new Error('Font invalid');
  });
  expect(
    (await new Printing(output, journal, font, brokenRender).print(request))
      .status,
  ).toBe('failed');
  expect(submit).not.toHaveBeenCalled();
  const next = { ...request, attemptId: 'write-failure' };
  submit.mockRejectedValueOnce(new Error('Disk full'));
  expect((await new Printing(output, journal, font).print(next)).status).toBe(
    'outcome-unknown',
  );
  expect((await new Printing(output, journal, font).print(next)).status).toBe(
    'outcome-unknown',
  );
  expect(submit).toHaveBeenCalledTimes(1);
});

it('keeps a saved PDF when outcome persistence fails and requires recovery without another save', async () => {
  const { output, journal } = await fixture();
  const submit = vi.spyOn(output, 'submit');
  vi.spyOn(journal, 'finish').mockRejectedValue(new Error('Database down'));
  expect(
    (await new Printing(output, journal, font).print(request)).status,
  ).toBe('outcome-unknown');
  expect((await output.read(request.attemptId)).subarray(0, 5).toString()).toBe(
    '%PDF-',
  );
  expect(
    (await new Printing(output, journal, font).print(request)).status,
  ).toBe('outcome-unknown');
  expect(submit).toHaveBeenCalledTimes(1);
});
