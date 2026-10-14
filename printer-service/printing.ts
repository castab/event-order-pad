import { parseTicket, type OrderTicket } from '../src/lib/tickets/ticket';
import type { PrintAttemptResult } from '../src/lib/printing/port';
import type { PrintOutput } from './output';
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
  assertPending(request: Request): Promise<void>;
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
  private readonly inflight = new Map<
    string,
    { request: Request; promise: Promise<PrintAttemptResult> }
  >();
  private readonly waiting: { run: () => void; expire: () => void }[] = [];
  constructor(
    private output: PrintOutput,
    private journal: PrintJournal,
    private font: string,
    private render = receiptPdf,
  ) {}
  private unknown(): PrintAttemptResult {
    return this.output.mode === 'pdf'
      ? {
          ...unknown(),
          simulated: true,
          message:
            'PDF saving was interrupted or its outcome could not be saved. Inspect saved PDFs before deliberately reprinting. Nothing was sent to a physical printer.',
        }
      : unknown();
  }
  private failed(
    message: string,
    code: 'transport' | 'invalid-ticket' | 'printer-busy' = 'transport',
  ): PrintAttemptResult {
    return this.output.mode === 'pdf'
      ? { ...failed(message, code), simulated: true }
      : failed(message, code);
  }
  async receipt(attemptId: string): Promise<PrintRecord | undefined> {
    return this.journal.get(attemptId);
  }
  print(value: Request): Promise<PrintAttemptResult> {
    const request = parseRequest(value);
    const existing = this.inflight.get(request.attemptId);
    if (existing)
      return JSON.stringify(existing.request) === JSON.stringify(request)
        ? existing.promise
        : Promise.resolve(
            this.failed(
              'Attempt ID was already used for different ticket content.',
              'invalid-ticket',
            ),
          );
    if (this.busy && this.waiting.length >= 8)
      return this.notSubmitted(
        request,
        'The submission queue is full. No job was submitted.',
      );
    let resolve!: (result: PrintAttemptResult) => void;
    const promise = new Promise<PrintAttemptResult>((done) => {
      resolve = done;
    });
    this.inflight.set(request.attemptId, { request, promise });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = {
      run: () => {
        clearTimeout(timer);
        this.busy = true;
        void this.execute(request)
          .catch(() => this.unknown())
          .then((result) => {
            this.inflight.delete(request.attemptId);
            resolve(result);
            this.busy = false;
            this.waiting.shift()?.run();
          });
      },
      expire: () => {
        const index = this.waiting.indexOf(entry);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        void this.notSubmitted(
          request,
          'The submission queue did not clear within 30 seconds. No job was submitted.',
        ).then((result) => {
          this.inflight.delete(request.attemptId);
          resolve(result);
        });
      },
    };
    if (this.busy) {
      this.waiting.push(entry);
      timer = setTimeout(entry.expire, 30000);
    } else entry.run();
    return promise;
  }

  private async notSubmitted(
    request: Request,
    message: string,
  ): Promise<PrintAttemptResult> {
    try {
      const record = await this.journal.get(request.attemptId);
      if (record) {
        if (
          JSON.stringify(parseRequest(record.request)) !==
          JSON.stringify(request)
        )
          return this.failed(
            'Attempt ID was already used for different ticket content.',
            'invalid-ticket',
          );
        return record.result ?? this.unknown();
      }
      return this.failed(message, 'printer-busy');
    } catch {
      return this.unknown();
    }
  }

  private async execute(request: Request): Promise<PrintAttemptResult> {
    request = parseRequest(request);
    try {
      const existing = await this.journal.get(request.attemptId);
      if (existing) {
        if (
          JSON.stringify(parseRequest(existing.request)) !==
          JSON.stringify(request)
        )
          return this.failed(
            'Attempt ID was already used for different ticket content.',
            'invalid-ticket',
          );
        return existing.result ?? this.unknown();
      }
    } catch {
      return this.failed(
        'Database unavailable. No new job was submitted. Restore Postgres and reload.',
      );
    }
    if (this.blocked)
      return this.failed(
        this.output.mode === 'pdf'
          ? 'Print history needs recovery. Restart the service and inspect saved PDFs before reprinting. Nothing was sent to a physical printer.'
          : 'Print history needs recovery. Restart the service and inspect CUPS jobs before printing.',
      );
    try {
      await this.journal.begin(request);
    } catch {
      return this.failed(
        'Could not save exclusive print intent. No job was submitted; inspect existing attempt history before trying again.',
      );
    }
    let pdf: Buffer;
    let media: string;
    let jobOptions: string[];
    try {
      await this.output.waitUntilIdle();
      const paper = await this.output.prepare(
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
      const result = this.failed(
        `${(error as Error).message} No job was submitted.`,
      );
      try {
        await this.journal.finish(request, result);
      } catch {
        this.blocked = true;
        return this.unknown();
      }
      return result;
    }
    try {
      await this.journal.assertPending(request);
    } catch {
      // Recovery may finalize a waiting attempt. It must never reach lp afterward.
      return this.unknown();
    }
    let result: PrintAttemptResult;
    try {
      const job = await this.output.submit(
        pdf,
        media,
        request.attemptId,
        jobOptions,
      );
      result =
        this.output.mode === 'pdf'
          ? {
              status: 'accepted',
              simulated: true,
              message:
                'Receipt PDF saved. Nothing was sent to a physical printer.',
            }
          : {
              status: 'accepted',
              simulated: false,
              message: `CUPS accepted job ${job}. This confirms queue submission only. Check the physical ticket and cut; a pending job may print later.`,
            };
    } catch {
      result = this.unknown();
    }
    try {
      await this.journal.finish(request, result);
    } catch {
      this.blocked = true;
      return this.unknown();
    }
    return result;
  }
}
