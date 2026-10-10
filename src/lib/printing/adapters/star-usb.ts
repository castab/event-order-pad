import { formatTicket } from '../../tickets/format';
import { parseTicket, type OrderTicket } from '../../tickets/ticket';
import type {
  PrintAttemptResult,
  PrintErrorCode,
  TicketPrinter,
} from '../port';
import { loadStarSdk, type StarSdk, type StarTrader } from './star-sdk';

export function starSupport(
  userAgent: string,
  protocol: string,
): string | undefined {
  if (!/Android/i.test(userAgent) || !/StarWebPRNTBrowser\//.test(userAgent))
    return 'Use Star webPRNT Browser on Android for USB-A/AOA. Chrome cannot use this adapter.';
  if (protocol !== 'https:')
    return 'Real printer mode requires an HTTPS-hosted app.';
  return undefined;
}

export class StarUsbPrinter implements TicketPrinter {
  readonly mode = 'star-usb';
  readonly label = 'Star TSP143IV-UE · USB-A/AOA';
  private busy = false;
  constructor(
    private sdk: () => Promise<StarSdk> = loadStarSdk,
    private support: () => string | undefined = () =>
      starSupport(navigator.userAgent, location.protocol),
    private timeoutMs = 17000,
  ) {}

  async print(
    ticket: OrderTicket,
    options: { reprint: boolean },
  ): Promise<PrintAttemptResult> {
    const failed = (
      code: PrintErrorCode,
      message: string,
    ): PrintAttemptResult => ({
      status: 'failed',
      code,
      message,
      simulated: false,
    });
    const unsupported = this.support();
    if (unsupported) return failed('unsupported', unsupported);
    if (this.busy)
      return failed('printer-busy', 'Another print attempt is in progress.');
    this.busy = true;
    let trader: StarTrader;
    let request: string;
    try {
      const valid = parseTicket(ticket);
      const sdk = await this.sdk();
      const builder = sdk.builder();
      trader = sdk.trader();
      request = builder.createInitializationElement();
      // 80mm paper, 42 columns; Font A body and double-height order reference.
      for (const line of formatTicket(valid, options.reprint, 42)) {
        const prominent = line.role === 'reference' || line.role === 'reprint';
        request += builder.createAlignmentElement({
          position: line.role === 'body' ? 'left' : 'center',
        });
        request += builder.createTextElement({
          data: line.text + '\n',
          codepage: 'utf8',
          font: 'font_a',
          emphasis: prominent || line.role === 'heading',
          width: 1,
          height: prominent ? 2 : 1,
        });
      }
      request += builder.createCutPaperElement({ feed: true, type: 'partial' });
    } catch (error) {
      this.busy = false;
      return failed(
        'printer-error',
        `No data sent: ${error instanceof Error ? error.message : 'SDK or ticket preparation failed.'}`,
      );
    }
    // Once sending begins, communication errors cannot prove that nothing printed.
    return new Promise<PrintAttemptResult>((resolve) => {
      let settled = false;
      const finish = (result: PrintAttemptResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.busy = false;
        trader.onReceive = null;
        trader.onError = null;
        resolve(result);
      };
      const unknown = (code: PrintErrorCode, message: string) =>
        finish({ status: 'outcome-unknown', code, message, simulated: false });
      const timer = setTimeout(
        () =>
          unknown(
            'timeout',
            'No final response. Inspect the printer before deliberately reprinting; a duplicate is possible.',
          ),
        this.timeoutMs,
      );
      trader.onReceive = (response) => {
        try {
          const code = Number(response.traderCode);
          const success =
            response.traderSuccess === true ||
            response.traderSuccess === 'true';
          const status = { traderStatus: response.traderStatus };
          if (success && code === 0) {
            finish({
              status: 'accepted',
              simulated: false,
              message:
                'Star reports success. Check the physical ticket for readability and the cut.',
            });
            return;
          }
          if (code === 2001) {
            finish(
              failed(
                'printer-busy',
                'Star reports printer busy. Inspect before deliberately reprinting.',
              ),
            );
            return;
          }
          if (code === 1100) {
            const reason = trader.isCoverOpen(status)
              ? 'cover-open'
              : trader.isPaperEnd(status)
                ? 'paper-out'
                : trader.isOffLine(status)
                  ? 'disconnected'
                  : trader.isAutoCutterError(status)
                    ? 'printer-error'
                    : 'printer-error';
            // An error status after send may follow partial printing; preserve ambiguity.
            unknown(
              reason,
              `Star reports ${reason}. Some data may have printed. Check the printer before reprinting.`,
            );
            return;
          }
          unknown(
            'printer-error',
            `Unrecognized Star response (${String(response.traderCode)}). Check the printer before reprinting.`,
          );
        } catch {
          unknown(
            'transport',
            'Unreadable printer response. Check the physical ticket before reprinting.',
          );
        }
      };
      trader.onError = (response) => {
        if (response.status === 10001 || response.status === 10002) {
          finish(
            failed(
              'unsupported',
              'Star could not initialize the transport; no data sent. Check browser setup.',
            ),
          );
        } else {
          unknown(
            'transport',
            `Communication failed (status ${response.status}). Check USB permission, cable, printer power and browser settings. Printing may have started.`,
          );
        }
      };
      try {
        trader.sendMessage({ request });
      } catch {
        unknown(
          'transport',
          'Send interrupted. Check the physical ticket before deliberately reprinting.',
        );
      }
    });
  }
}
