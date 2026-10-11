import { formatTicket } from '../../tickets/format';
import { parseTicket, type OrderTicket } from '../../tickets/ticket';
import type {
  PrintAttemptResult,
  PrintHandoff,
  PrintReturn,
  TicketPrinter,
} from '../port';

const attemptKey = 'order_pad_attempt';
// Conservative app limits below Android's documented 1 MB intent ceiling.
const maxUriBytes = 128 * 1024;
const maxLines = 240;

export function passPrntSupport(
  userAgent: string,
  protocol: string,
): string | undefined {
  const android = /Android\s+(\d+)/i.exec(userAgent);
  if (!android || Number(android[1]) < 9)
    return 'Use Android 9 or later with Star PassPRNT installed. Our test device is a Galaxy S10e running Android 12.';
  if (protocol !== 'https:')
    return 'Open the production app at its HTTPS URL on Android. USB is handled by Star PassPRNT.';
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  );
}

/** Self-contained HTML is rasterized by PassPRNT for the IIIU's StarGraphic emulation. */
export function receiptHtml(ticket: OrderTicket, reprint: boolean): string {
  const lines = formatTicket(parseTicket(ticket), reprint);
  if (lines.length > maxLines)
    throw new Error('Receipt exceeds the application length limit');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="format-detection" content="telephone=no"><style>html,body{margin:0;padding:0;width:576px;background:white;color:black}body{box-sizing:border-box;padding:8px;font:22px/30px monospace}.line{white-space:pre-wrap;overflow-wrap:anywhere}.heading,.reference,.reprint,.end{text-align:center;font-weight:bold}.reference,.reprint{font-size:36px;line-height:44px}.heading{font-size:26px;line-height:34px}.end{font-size:18px}</style></head><body>${lines.map((line) => `<div class="line ${line.role}">${escapeHtml(line.text) || '&#160;'}</div>`).join('')}</body></html>`;
}

function encode(value: string): string {
  // RFC3986 encoding required by Star's URL scheme specification.
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function passPrntUri(
  ticket: OrderTicket,
  reprint: boolean,
  attemptId: string,
  appUrl: string,
): string {
  if (!attemptId) throw new Error('Missing durable attempt ID');
  const back = new URL(appUrl);
  if (back.protocol !== 'https:') throw new Error('HTTPS return URL required');
  back.search = '';
  back.hash = '';
  back.searchParams.set(attemptKey, attemptId);
  const params: Record<string, string> = {
    back: back.href,
    port: 'usb:',
    settings: '',
    size: '576',
    cut: 'partial',
    popup: 'disable',
    drawer: 'off',
    buzzer: 'off',
    sound: 'off',
    html: receiptHtml(ticket, reprint),
  };
  const uri = `starpassprnt://v1/print/nopreview?${Object.entries(params)
    .map(([key, value]) => `${key}=${encode(value)}`)
    .join('&')}`;
  if (uri.length > maxUriBytes)
    throw new Error('Receipt exceeds the application intent size limit');
  return uri;
}

function resultForCode(code: string): PrintAttemptResult {
  if (code === '0')
    return {
      status: 'accepted',
      simulated: false,
      message:
        'Star PassPRNT reported success. Check the physical ticket and partial cut.',
    };
  if (code === '4' || code === '5')
    return {
      status: 'failed',
      simulated: false,
      code: code === '4' ? 'disconnected' : 'printer-error',
      message: `Star PassPRNT rejected the request before sending (code ${code}). Check USB permission, cable, printer power, cover and paper. No automatic retry.`,
    };
  if (['1', '3', '9', '11', '12', '14', '15', '16'].includes(code))
    return {
      status: 'failed',
      simulated: false,
      code: 'invalid-ticket',
      message: `Star PassPRNT could not prepare the print data (code ${code}). No automatic retry.`,
    };
  return {
    status: 'outcome-unknown',
    simulated: false,
    code: 'transport',
    message: `Star PassPRNT returned an interrupted or unrecognized outcome (code ${code || 'missing'}). Output may be partial. Close PassPRNT and inspect the printer before deliberately reprinting.`,
  };
}

/** Caller correlates this unverified external report with one unfinished saved attempt. */
export function passPrntReturn(appUrl: string): PrintReturn | undefined {
  const query = new URL(appUrl).searchParams;
  const ids = query.getAll(attemptKey);
  if (ids.length !== 1 || !ids[0]) return;
  const codes = query.getAll('passprnt_code');
  const code = codes.length === 1 && /^\d{1,4}$/.test(codes[0]) ? codes[0] : '';
  return {
    attemptId: ids[0],
    mode: 'star-passprnt',
    result: resultForCode(code),
  };
}

export function cleanPassPrntReturn(appUrl: string): string {
  const url = new URL(appUrl);
  for (const key of [attemptKey, 'passprnt_code', 'passprnt_message'])
    url.searchParams.delete(key);
  return url.href;
}

export class PassPrntPrinter implements TicketPrinter {
  readonly mode = 'star-passprnt';
  readonly label = 'TSP143IIIU · Android USB-B · Star PassPRNT';
  constructor(
    private appUrl: () => string,
    private unsupported: () => string | undefined,
  ) {}
  async print(
    ticket: OrderTicket,
    options: { reprint: boolean; attemptId: string },
  ): Promise<PrintHandoff | PrintAttemptResult> {
    const unsupported = this.unsupported();
    if (unsupported)
      return {
        status: 'failed',
        simulated: false,
        code: 'unsupported',
        message: unsupported,
      };
    try {
      // Creating a link is not a send. The UI supplies a fresh user-gesture launch.
      return {
        status: 'handoff',
        url: passPrntUri(
          ticket,
          options.reprint,
          options.attemptId,
          this.appUrl(),
        ),
      };
    } catch {
      return {
        status: 'failed',
        simulated: false,
        code: 'invalid-ticket',
        message:
          'Could not prepare the PassPRNT request. Check the ticket length and HTTPS app URL. Nothing was sent.',
      };
    }
  }
}
