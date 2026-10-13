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

/** Reject malformed outcomes before using database or transport data. */
export function parseAttemptResult(value: unknown): PrintAttemptResult {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid print outcome.');
  const v = value as PrintAttemptResult;
  if (
    typeof v.simulated !== 'boolean' ||
    typeof v.message !== 'string' ||
    !v.message ||
    v.message.length > 2000
  )
    throw new Error('Invalid print outcome.');
  if (v.status === 'accepted')
    return Object.freeze({
      status: v.status,
      simulated: v.simulated,
      message: v.message,
    });
  if (
    !['failed', 'outcome-unknown'].includes(v.status) ||
    ![
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
    ].includes(v.code)
  )
    throw new Error('Invalid print outcome.');
  return Object.freeze({
    status: v.status,
    code: v.code,
    simulated: v.simulated,
    message: v.message,
  });
}
export function parseAttempt(value: unknown): PrintAttempt {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid print attempt.');
  const v = value as PrintAttempt;
  if (
    typeof v.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(v.id) ||
    typeof v.ticketId !== 'string' ||
    !v.ticketId ||
    Array.from(v.ticketId).length > 100 ||
    /[\p{Cc}\u2028\u2029]/u.test(v.ticketId) ||
    !['simulated', 'star-passprnt', 'star-usb', 'linux-cups'].includes(
      v.mode,
    ) ||
    typeof v.reprint !== 'boolean' ||
    typeof v.startedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.startedAt)) ||
    (v.completedAt !== undefined &&
      (typeof v.completedAt !== 'string' ||
        !Number.isFinite(Date.parse(v.completedAt)))) ||
    !!v.result !== !!v.completedAt
  )
    throw new Error('Invalid print attempt.');
  return Object.freeze({
    id: v.id,
    ticketId: v.ticketId,
    mode: v.mode,
    reprint: v.reprint,
    startedAt: v.startedAt,
    ...(v.result
      ? { result: parseAttemptResult(v.result), completedAt: v.completedAt }
      : {}),
  });
}
