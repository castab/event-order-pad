import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import type { PrintAttemptResult } from '../src/lib/printing/port';
import { Cups } from './cups';
import { receiptLayout, receiptPdf } from './receipt';

export interface Request {
  attemptId: string;
  reprint: boolean;
  ticket: OrderTicket;
}
export interface PrintRecord {
  request: Request;
  result?: PrintAttemptResult;
}
export interface PrintJournal {
  get(id: string): Promise<PrintRecord | undefined>;
  begin(request: Request): Promise<void>;
  finish(request: Request, result: PrintAttemptResult): Promise<void>;
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
  return Object.freeze({
    attemptId: input.attemptId,
    reprint: input.reprint,
    ticket: parseTicket(input.ticket),
  });
}

/** Database dispatch intent precedes lp. Pending intent is never replayed. */
export class Printing {
  private busy = false;
  private blocked = false;
  constructor(
    private cups: Cups,
    private journal: PrintJournal,
    private font: string,
    private render = receiptPdf,
  ) {}
  async print(request: Request): Promise<PrintAttemptResult> {
    request = parseRequest(request);
    try {
      const existing = await this.journal.get(request.attemptId);
      if (existing) {
        if (
          JSON.stringify(parseRequest(existing.request)) !==
          JSON.stringify(request)
        )
          return failed(
            'Attempt ID was already used for different ticket content.',
            'invalid-ticket',
          );
        return existing.result ?? unknown();
      }
    } catch {
      return failed(
        'Database unavailable. No new job was submitted. Restore Postgres and reload.',
      );
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
      try {
        await this.journal.begin(request);
      } catch {
        return failed(
          'Could not save exclusive print intent. No job was submitted; inspect existing attempt history before trying again.',
        );
      }
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
        const result = failed(
          `${(error as Error).message} No job was submitted.`,
        );
        try {
          await this.journal.finish(request, result);
        } catch {
          this.blocked = true;
          return unknown();
        }
        return result;
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
        await this.journal.finish(request, result);
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
