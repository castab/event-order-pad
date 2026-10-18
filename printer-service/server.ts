import { realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Cups } from './cups';
import { Printing } from './printing';
import { PdfOutput } from './output';
import { PostgresStationRepository } from './station-database';
import { Orders } from './orders';
import { PostgresOrderRepository, createOrderDatabase } from './order-database';
import { createApp } from './http';
import { PostgresAuth, parseAuthConfig } from './auth';
import { manageAccess, printAccessSlip } from './access-admin';
import { createAdminApp, listenAdmin } from './admin-http';
import {
  parseTrackingEnabled,
  parseDatabaseUrl,
  parseCaptureFrom,
  parsePrintMode,
  parseServiceOrigin,
  assertPrintPlatform,
  parseFont,
  parseAdminConfig,
} from './config';

const printMode = parsePrintMode(process.env.ORDER_PAD_PRINT_MODE);
assertPrintPlatform(printMode);
const origin = parseServiceOrigin(process.env.ORDER_PAD_ORIGIN, printMode);
const port = Number(process.env.ORDER_PAD_PORT ?? '4174');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid local port.');
const adminConfig = parseAdminConfig(process.env, origin);
const trackingEnabled = parseTrackingEnabled(
  process.env.ORDER_PAD_TRACKING_ENABLED,
);
const root = await realpath(resolve('build'));
const font = parseFont(process.env.ORDER_PAD_FONT, printMode);
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
const authConfig = parseAuthConfig(process.env);
const auth = await new PostgresAuth(database, origin, authConfig).initialize();
const cleanup = setInterval(() => {
  void auth
    .cleanup()
    .catch(() => console.error('Authentication cleanup unavailable.'));
}, 60000);
cleanup.unref();
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
  auth,
  proxy: authConfig.proxy,

  pdfOutput,
});
await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
console.log(
  `Order Pad service (${printMode} output) listening on 127.0.0.1:${port}; open ${origin.origin}`,
);
// Started after the main port binds, so a second instance exits before touching the socket.
const admin = adminConfig
  ? createAdminApp({
      origin: adminConfig.origin,
      capability: adminConfig.capability,
      access: (command) => manageAccess(database, command),
      slip: (code, expiresAt) => printAccessSlip(output, code, expiresAt, font),
      slipMode: printMode,
      assets: root,
    })
  : undefined;
if (admin && adminConfig) {
  await listenAdmin(admin, adminConfig.socket);
  console.log(
    `Tailnet access-code admin listening on ${adminConfig.socket} for ${adminConfig.origin.origin}`,
  );
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(cleanup);
    admin?.close();
    server.close(() => {
      void database.$disconnect();
    });
  });
}
