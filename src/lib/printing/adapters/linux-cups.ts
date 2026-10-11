import type { OrderTicket } from '../../tickets/ticket';
import type { PrintAttemptResult, TicketPrinter } from '../port';

export interface LinuxPrinterStatus {
  readonly ready: boolean;
  readonly message: string;
}

export async function linuxPrinterStatus(): Promise<LinuxPrinterStatus> {
  try {
    const response = await fetch('/api/printer', {
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (
      response.ok &&
      typeof data.ready === 'boolean' &&
      typeof data.message === 'string'
    )
      return data;
  } catch {
    /* A static host has no Linux printing service. */
  }
  return {
    ready: false,
    message:
      'Linux printing service unavailable. Open Order Pad at the Mint machine’s HTTPS address and check that its service is running.',
  };
}

/** Same-origin service only; no CUPS or device commands enter the UI. */
export class LinuxCupsPrinter implements TicketPrinter {
  readonly mode = 'linux-cups' as const;
  readonly label = 'Star USB via Linux CUPS';
  constructor(private send: typeof fetch = fetch) {}

  async print(
    ticket: OrderTicket,
    options: { reprint: boolean; attemptId: string },
  ): Promise<PrintAttemptResult> {
    try {
      const response = await this.send('/api/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, ...options }),
        cache: 'no-store',
        signal: AbortSignal.timeout(60000),
      });
      const data = await response.json();
      if (
        data.attemptId === options.attemptId &&
        data.result?.simulated === false &&
        typeof data.result.message === 'string' &&
        (data.result.status === 'accepted' ||
          (['failed', 'outcome-unknown'].includes(data.result.status) &&
            [
              'unsupported',
              'permission-denied',
              'disconnected',
              'cover-open',
              'paper-out',
              'printer-busy',
              'printer-error',
              'transport',
              'timeout',
              'invalid-ticket',
            ].includes(data.result.code)))
      )
        return data.result;
    } catch {
      /* Lost responses are ambiguous; never resend automatically. */
    }
    return {
      status: 'outcome-unknown',
      simulated: false,
      code: 'transport',
      message:
        'The Linux service did not return a matching result. The job may be queued or printed. Inspect the printer and CUPS jobs before deliberately reprinting.',
    };
  }
}
