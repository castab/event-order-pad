import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import type { PrintAttemptResult } from '../src/lib/printing/port';
import { Cups } from './cups';
import { receiptLayout, receiptPdf } from './receipt';

export interface Request {
  attemptId: string;
  reprint: boolean;
  ticket: OrderTicket;
}
interface Record {
  request: Request;
  result?: PrintAttemptResult;
}
const failed = (
  message: string,
  code: 'transport' | 'invalid-ticket' | 'printer-busy' = 'transport',
): PrintAttemptResult => ({
  status: 'failed',
  simulated: false,
  code,
  message,
});
const unknown = (): PrintAttemptResult => ({
  status: 'outcome-unknown',
  simulated: false,
  code: 'transport',
  message:
    'CUPS submission was interrupted or its outcome could not be saved. Inspect paper and CUPS jobs before deliberately reprinting; this attempt will not be submitted again.',
});

export function parseRequest(value: unknown): Request {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid print request.');
  const input = value as Request;
  if (
    typeof input.attemptId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(input.attemptId) ||
    typeof input.reprint !== 'boolean'
  )
    throw new Error('Invalid attempt ID or reprint flag.');
  return {
    attemptId: input.attemptId,
    reprint: input.reprint,
    ticket: parseTicket(input.ticket),
  };
}

async function syncDirectory(directory: string) {
  if (process.platform !== 'linux') return;
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function save(path: string, value: Record, directory: string) {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(directory);
}

/** Small durable attempt journal, not a background queue. Pending intent is never replayed. */
export class Printing {
  private busy = false;
  private blocked = false;
  constructor(
    private cups: Cups,
    private directory: string,
    private font: string,
    private render = receiptPdf,
  ) {}
  async print(request: Request): Promise<PrintAttemptResult> {
    const path = join(this.directory, `${request.attemptId}.json`);
    try {
      const existing = JSON.parse(await readFile(path, 'utf8')) as Record;
      if (JSON.stringify(existing.request) !== JSON.stringify(request))
        return failed(
          'Attempt ID was already used for different ticket content.',
          'invalid-ticket',
        );
      return existing.result ?? unknown();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return failed('Print history cannot be read. No new job was sent.');
    }
    if (this.blocked)
      return failed(
        'Print history needs recovery. Restart the service and inspect CUPS jobs before printing.',
      );
    if (this.busy)
      return failed(
        'Another submission is in progress. No job was sent for this attempt.',
        'printer-busy',
      );
    this.busy = true;
    try {
      let pdf: Buffer;
      let media: string;
      let jobOptions: string[];
      try {
        const paper = await this.cups.prepare(
          receiptLayout(request.ticket, request.reprint).heightMm,
        );
        media = paper.media;
        jobOptions = paper.jobOptions;
        pdf = await this.render(
          request.ticket,
          request.reprint,
          this.font,
          paper.heightMm,
        );
      } catch (error) {
        return failed(`${(error as Error).message} No job was submitted.`);
      }
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        await save(path, { request }, this.directory);
      } catch {
        return failed(
          'Could not save exclusive print intent. No job was submitted; inspect existing attempt history before trying again.',
        );
      }
      let result: PrintAttemptResult;
      try {
        const job = await this.cups.submit(
          pdf,
          media,
          request.attemptId,
          jobOptions,
        );
        result = {
          status: 'accepted',
          simulated: false,
          message: `CUPS accepted job ${job}. This confirms queue submission only. Check the physical ticket and cut; a pending job may print later.`,
        };
      } catch {
        result = unknown();
      }
      try {
        const temporary = `${path}.complete`;
        await save(temporary, { request, result }, this.directory);
        await rename(temporary, path);
        await syncDirectory(this.directory);
      } catch {
        this.blocked = true;
        return unknown();
      }
      return result;
    } finally {
      this.busy = false;
    }
  }
}
