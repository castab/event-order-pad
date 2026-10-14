import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Cups } from './cups';
import { Printing } from './printing';
import { PdfOutput } from './output';
import { PostgresStationRepository } from './station-database';
import { Orders } from './orders';
import { PostgresOrderRepository, createOrderDatabase } from './order-database';
import { createApp } from './http';
import {
  parseTrackingEnabled,
  parseDatabaseUrl,
  parseCaptureFrom,
  parsePrintMode,
  parseServiceOrigin,
  assertPrintPlatform,
} from './config';

const printMode = parsePrintMode(process.env.ORDER_PAD_PRINT_MODE);
assertPrintPlatform(printMode);
const origin = parseServiceOrigin(process.env.ORDER_PAD_ORIGIN, printMode);
const port = Number(process.env.ORDER_PAD_PORT ?? '4174');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid local port.');
const trackingEnabled = parseTrackingEnabled(
  process.env.ORDER_PAD_TRACKING_ENABLED,
);
const root = await realpath(resolve('build'));
const font =
  process.env.ORDER_PAD_FONT ??
  (printMode === 'cups'
    ? '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
    : '');
const pdfOutput =
  printMode === 'pdf'
    ? new PdfOutput(process.env.ORDER_PAD_PDF_DIR ?? '.receipt-pdfs', font)
    : undefined;
if (pdfOutput) {
  await pdfOutput.check();
  const location = relative(root, await realpath(pdfOutput.directory));
  if (
    location === '' ||
    (location !== '..' &&
      !location.startsWith(`..${sep}`) &&
      !isAbsolute(location))
  )
    throw new Error(
      'ORDER_PAD_PDF_DIR must be outside the static build directory.',
    );
}
const output = pdfOutput ?? new Cups(process.env.ORDER_PAD_QUEUE ?? 'OrderPad');
const database = createOrderDatabase(
  parseDatabaseUrl(process.env.DATABASE_URL),
);
const captureFrom = parseCaptureFrom(process.env.ORDER_PAD_CAPTURE_FROM);
const station = new PostgresStationRepository(database, captureFrom);
await station.check();
const printing = new Printing(output, station, font);
const orders = new Orders(new PostgresOrderRepository(database), captureFrom);
const server = createApp({
  origin,
  port,
  root,
  cups: output,
  printing,
  orders,
  trackingEnabled,
  station,
  pdfOutput,
}).listen(port, '127.0.0.1', () =>
  console.log(
    `Order Pad service (${printMode} output) listening on 127.0.0.1:${port}; open ${origin.origin}`,
  ),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void database.$disconnect();
    });
  });
}
