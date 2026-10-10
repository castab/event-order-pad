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
  readonly mode: 'simulated' | 'star-usb';
  readonly label: string;
  print(
    ticket: OrderTicket,
    options: { readonly reprint: boolean },
  ): Promise<PrintAttemptResult>;
}

export interface PrintAttempt {
  readonly id: string;
  readonly ticketId: string;
  readonly startedAt: string;
  readonly mode: TicketPrinter['mode'];
  readonly reprint: boolean;
  readonly result?: PrintAttemptResult;
  readonly completedAt?: string;
}
