import { describe, expect, it } from 'vitest';
import { parseTicket, sampleTicket } from '../../tickets/ticket';
import {
  PassPrntPrinter,
  passPrntSupport,
  passPrntUri,
  passPrntReturn,
  receiptHtml,
} from './passprnt';

const ticket = sampleTicket('ticket-1', '2026-10-10T20:00:00.000Z');
describe('TSP143IIIU PassPRNT integration', () => {
  it('requires Android 9+ and HTTPS without claiming installation or connection', () => {
    expect(
      passPrntSupport('Mozilla/5.0 Android 12 SM-G970U Chrome/140', 'https:'),
    ).toBeUndefined();
    expect(passPrntSupport('Android 8', 'https:')).toContain('Android 9');
    expect(passPrntSupport('Windows', 'https:')).toContain('Android 9');
    expect(passPrntSupport('Android 12', 'http:')).toContain('HTTPS');
  });
  it('encodes self-contained raster HTML, USB, partial cut, no retry pop-up or peripheral activation', () => {
    const uri = new URL(
      passPrntUri(
        ticket,
        true,
        'attempt-2',
        'https://pad.example/?old=1#preview',
      ),
    );
    expect(uri.protocol).toBe('starpassprnt:');
    expect(uri.host + uri.pathname).toBe('v1/print/nopreview');
    expect(Object.fromEntries(uri.searchParams)).toMatchObject({
      port: 'usb:',
      settings: '',
      size: '576',
      cut: 'partial',
      popup: 'disable',
      drawer: 'off',
      buzzer: 'off',
      sound: 'off',
      back: 'https://pad.example/?order_pad_attempt=attempt-2',
    });
    expect(uri.searchParams.get('html')).toContain('REPRINT');
    expect(uri.searchParams.get('html')).toContain('#0043');
    expect(uri.searchParams.get('html')).toContain('ticket-1');
    expect(uri.searchParams.has('url')).toBe(false);
    expect(uri.searchParams.has('pdf')).toBe(false);
  });
  it('escapes ticket content and preserves UTF-8 instead of interpreting HTML', () => {
    const html = receiptHtml(
      parseTicket({
        ...ticket,
        customerName: '<script>& "Crème"</script>',
        displayName: undefined,
      }),
      false,
    );
    expect(html).toContain('&lt;SCRIPT&gt;&amp;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/src=|https?:/);
  });
  it('rejects oversized receipts before any handoff', () => {
    const large = {
      ...ticket,
      servings: Array.from({ length: 30 }, () => ({
        flavors: [
          { flavor: 'Chocolate' as const, count: 1 },
          { flavor: 'Vanilla' as const, count: 1 },
          { flavor: 'Strawberry' as const, count: 1 },
          { flavor: 'Chocolate Chip' as const, count: 1 },
        ],
        container: 'Cup' as const,
        toppings: [
          'Whipped cream',
          'Gummy Bears',
          'Caramel Sauce',
          'Chocolate Sauce',
          'Sliced Almonds',
          'Maraschino Cherries',
        ] as const,
      })),
    };
    expect(() => receiptHtml(large, false)).toThrow('length limit');
    expect(() =>
      passPrntUri(ticket, false, '', 'https://pad.example/'),
    ).toThrow();
  });
  it('prepares a link without sending and blocks unsupported runtimes without simulation', async () => {
    const printer = new PassPrntPrinter(
      () => 'https://pad.example/',
      () => undefined,
    );
    expect(
      await printer.print(ticket, { reprint: false, attemptId: 'attempt-1' }),
    ).toMatchObject({ status: 'handoff' });
    const unsupported = new PassPrntPrinter(
      () => 'https://pad.example/',
      () => 'Unsupported runtime',
    );
    expect(
      await unsupported.print(ticket, {
        reprint: false,
        attemptId: 'attempt-1',
      }),
    ).toMatchObject({
      status: 'failed',
      simulated: false,
      code: 'unsupported',
    });
  });
  it.each([
    ['0', 'accepted'],
    ['4', 'failed'],
    ['5', 'failed'],
    ['3', 'failed'],
    ['7', 'outcome-unknown'],
    ['8', 'outcome-unknown'],
    ['10', 'outcome-unknown'],
    ['999', 'outcome-unknown'],
  ])('maps callback %s to %s', (code, status) => {
    expect(
      passPrntReturn(
        `https://pad.example/?order_pad_attempt=attempt-1&passprnt_code=${code}`,
      )?.result.status,
    ).toBe(status);
  });
  it('does not accept missing, duplicate or malformed callback codes as success', () => {
    expect(
      passPrntReturn('https://pad.example/?passprnt_code=0'),
    ).toBeUndefined();
    for (const suffix of [
      '',
      '&passprnt_code=0&passprnt_code=7',
      '&passprnt_code=0junk',
    ])
      expect(
        passPrntReturn(
          `https://pad.example/?order_pad_attempt=attempt-1${suffix}`,
        )?.result.status,
      ).toBe('outcome-unknown');
    expect(
      passPrntReturn(
        'https://pad.example/?order_pad_attempt=a&order_pad_attempt=b&passprnt_code=0',
      ),
    ).toBeUndefined();
  });
});
