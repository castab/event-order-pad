import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { sampleTicket } from '../../tickets/ticket';
import { StarUsbPrinter, starSupport } from './star-usb';
import type {
  StarBuilder,
  StarResponse,
  StarSdk,
  StarTrader,
} from './star-sdk';

const ticket = sampleTicket('ticket-1', '2026-10-09T20:00:00.000Z');
function sdkFixture() {
  const context: Record<string, unknown> = {};
  // Use the actual unmodified vendor builder, not guessed command generation.
  runInNewContext(
    readFileSync('static/vendor/star-webprnt/StarWebPrintBuilder.js', 'utf8'),
    context,
  );
  const Builder = context.StarWebPrintBuilder as new () => StarBuilder;
  const trader: StarTrader = {
    onReceive: null,
    onError: null,
    sendMessage: vi.fn(),
    isCoverOpen: () => false,
    isPaperEnd: () => false,
    isOffLine: () => false,
    isAutoCutterError: () => false,
  };
  const sdk: StarSdk = { builder: () => new Builder(), trader: () => trader };
  return {
    trader,
    sdk,
    printer: new StarUsbPrinter(
      async () => sdk,
      () => undefined,
      1000,
    ),
  };
}
async function sent(
  fixture: ReturnType<typeof sdkFixture>,
  response: Partial<StarResponse>,
) {
  const promise = fixture.printer.print(ticket, { reprint: false });
  await vi.waitFor(() => expect(fixture.trader.sendMessage).toHaveBeenCalled());
  fixture.trader.onReceive!({
    traderSuccess: 'false',
    traderCode: '1100',
    traderStatus: '0000000000000000',
    ...response,
  });
  return promise;
}

describe('documented Star USB boundary (no physical hardware)', () => {
  it('checks browser, OS and HTTPS without silently simulating', async () => {
    expect(starSupport('Android Chrome/144', 'https:')).toContain(
      'webPRNT Browser',
    );
    expect(
      starSupport('StarWebPRNTBrowser/3.8.0 Windows', 'https:'),
    ).toBeTruthy();
    expect(starSupport('Android StarWebPRNTBrowser/3.8.0', 'http:')).toContain(
      'HTTPS',
    );
    expect(
      starSupport('Android StarWebPRNTBrowser/3.8.0', 'https:'),
    ).toBeUndefined();
    const load = vi.fn();
    const printer = new StarUsbPrinter(load, () => 'Unsupported runtime');
    expect(await printer.print(ticket, { reprint: false })).toMatchObject({
      status: 'failed',
      code: 'unsupported',
      simulated: false,
    });
    expect(load).not.toHaveBeenCalled();
  });
  it('uses vendor text, escaping, emphasis and a final partial cut', async () => {
    const f = sdkFixture();
    const promise = f.printer.print(
      { ...ticket, notes: '<unsafe> & notes' },
      { reprint: true },
    );
    await vi.waitFor(() => expect(f.trader.sendMessage).toHaveBeenCalled());
    const request = vi.mocked(f.trader.sendMessage).mock.calls[0][0].request;
    expect(request).toContain('REPRINT');
    expect(request).toContain('ORDER\\x20#0042');
    expect(request).toContain('Waffle\\x20cone');
    expect(request).toContain('\\x3cunsafe\\x3e\\x20\\x26\\x20notes');
    expect(request).toContain('height="2"');
    expect(request).toMatch(/<cutpaper[^>]*type="partial"[^>]*\/>$/);
    f.trader.onReceive!({
      traderSuccess: 'true',
      traderCode: '0',
      traderStatus: '0000000000000000',
    });
    expect(await promise).toMatchObject({
      status: 'accepted',
      simulated: false,
    });
  });
  it.each([
    'isCoverOpen',
    'isPaperEnd',
    'isOffLine',
    'isAutoCutterError',
  ] as const)('preserves partial-print ambiguity for %s', async (method) => {
    const f = sdkFixture();
    f.trader[method] = () => true;
    expect(await sent(f, {})).toMatchObject({
      status: 'outcome-unknown',
      simulated: false,
    });
  });
  it('reports an explicit busy rejection as failed and never retries', async () => {
    const f = sdkFixture();
    expect(await sent(f, { traderCode: '2001' })).toMatchObject({
      status: 'failed',
      code: 'printer-busy',
    });
    expect(f.trader.sendMessage).toHaveBeenCalledTimes(1);
  });
  it('reports communication/permission interruption as unknown', async () => {
    const f = sdkFixture();
    const promise = f.printer.print(ticket, { reprint: false });
    await vi.waitFor(() => expect(f.trader.sendMessage).toHaveBeenCalled());
    f.trader.onError!({ status: 0, responseText: '' });
    expect(await promise).toMatchObject({
      status: 'outcome-unknown',
      code: 'transport',
    });
  });
  it('times out missing callbacks and rejects overlapping adapter calls', async () => {
    const f = sdkFixture();
    f.printer = new StarUsbPrinter(
      async () => f.sdk,
      () => undefined,
      30,
    );
    const promise = f.printer.print(ticket, { reprint: false });
    expect(await f.printer.print(ticket, { reprint: false })).toMatchObject({
      status: 'failed',
      code: 'printer-busy',
    });
    expect(await promise).toMatchObject({
      status: 'outcome-unknown',
      code: 'timeout',
    });
    expect(f.trader.sendMessage).toHaveBeenCalledTimes(1);
  });
});
