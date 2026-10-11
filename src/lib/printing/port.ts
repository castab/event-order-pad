import type { OrderTicket } from '../tickets/ticket';

export type PrintErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'disconnected'
  | 'cover-open'
  | 'paper-out'
  | 'printer-busy'
  | 'printer-error'
  | 'transport'
  | 'timeout'
  | 'invalid-ticket';
export type PrintAttemptResult =
  | {
      readonly status: 'accepted';
      readonly simulated: boolean;
      readonly message: string;
    }
  | {
      readonly status: 'failed' | 'outcome-unknown';
      readonly code: PrintErrorCode;
      readonly message: string;
      readonly simulated: boolean;
    };

export interface TicketPrinter {
  readonly mode: 'simulated' | 'star-passprnt' | 'linux-cups';
  readonly label: string;
  print(
    ticket: OrderTicket,
    options: { readonly reprint: boolean; readonly attemptId: string },
  ): Promise<PrintAttemptResult | PrintHandoff>;
}

/** External app launch is pending intent, never a successful print result. */
export interface PrintHandoff {
  readonly status: 'handoff';
  readonly url: string;
}

export interface PrintReturn {
  readonly attemptId: string;
  readonly mode: TicketPrinter['mode'];
  readonly result: PrintAttemptResult;
}

export interface PrintAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly startedAt: string;
  // Keep the original IV adapter identifier readable in existing histories.
  readonly mode: TicketPrinter['mode'] | 'star-usb';
  readonly reprint: boolean;
  readonly result?: PrintAttemptResult;
  readonly completedAt?: string;
}
