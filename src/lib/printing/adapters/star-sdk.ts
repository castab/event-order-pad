// The only module that loads third-party scripts. API types follow the official
// Builder/Trader documentation; the vendor files remain unmodified.
import { base } from '$app/paths';

export interface StarBuilder {
  createInitializationElement(): string;
  createAlignmentElement(args: { position: 'left' | 'center' }): string;
  createTextElement(args: {
    data: string;
    codepage: string;
    font: string;
    emphasis: boolean;
    width: number;
    height: number;
  }): string;
  createCutPaperElement(args: { feed: boolean; type: 'partial' }): string;
}
export interface StarResponse {
  traderSuccess: boolean | string;
  traderCode: number | string;
  traderStatus: string;
}
export interface StarTrader {
  onReceive: ((response: StarResponse) => void) | null;
  onError:
    ((response: { status: number; responseText: string }) => void) | null;
  sendMessage(args: { request: string }): void;
  isCoverOpen(args: { traderStatus: string }): boolean;
  isPaperEnd(args: { traderStatus: string }): boolean;
  isOffLine(args: { traderStatus: string }): boolean;
  isAutoCutterError(args: { traderStatus: string }): boolean;
}
export interface StarSdk {
  builder(): StarBuilder;
  trader(): StarTrader;
}
type StarWindow = Window & {
  StarWebPrintBuilder?: new () => StarBuilder;
  StarWebPrintTrader?: new (args: {
    url: string;
    timeout: number;
    checkedblock: boolean;
  }) => StarTrader;
};
export const STAR_ENDPOINT = 'https://localhost:8001/StarWebPRNT/SendMessage';
let loading: Promise<StarSdk> | undefined;

async function script(src: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const element = document.createElement('script');
    const timer = setTimeout(() => {
      element.remove();
      reject(new Error('Star SDK loading timed out.'));
    }, 10000);
    element.src = `${base}/vendor/star-webprnt/${src}`;
    element.onload = () => {
      clearTimeout(timer);
      resolve();
    };
    element.onerror = () => {
      clearTimeout(timer);
      element.remove();
      reject(new Error('Star SDK could not be loaded.'));
    };
    document.head.append(element);
  });
}

export function loadStarSdk(): Promise<StarSdk> {
  loading ??= (async () => {
    const w = window as StarWindow;
    if (!w.StarWebPrintBuilder) await script('StarWebPrintBuilder.js');
    if (!w.StarWebPrintTrader) await script('StarWebPrintTrader.js');
    if (!w.StarWebPrintBuilder || !w.StarWebPrintTrader)
      throw new Error('Star SDK APIs unavailable.');
    return {
      builder: () => new w.StarWebPrintBuilder!(),
      trader: () =>
        new w.StarWebPrintTrader!({
          url: STAR_ENDPOINT,
          timeout: 15000,
          checkedblock: true,
        }),
    };
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
