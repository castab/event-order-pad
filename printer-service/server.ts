import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Cups } from './cups';
import { Printing } from './printing';
import { PostgresStationRepository } from './station-database';
import { Orders } from './orders';
import { PostgresOrderRepository, createOrderDatabase } from './order-database';
import { createApp } from './http';
import {
  parseTrackingEnabled,
  parseDatabaseUrl,
  parseCaptureFrom,
} from './config';

if (process.platform !== 'linux')
  throw new Error(
    'The real CUPS service requires Linux. Use simulation on other systems.',
  );
const origin = new URL(process.env.ORDER_PAD_ORIGIN ?? '');
if (
  origin.protocol !== 'https:' ||
  origin.pathname !== '/' ||
  origin.username ||
  origin.password ||
  origin.search ||
  origin.hash
)
  throw new Error(
    'ORDER_PAD_ORIGIN must be your Mint machine’s root HTTPS origin.',
  );
const port = Number(process.env.ORDER_PAD_PORT ?? '4174');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid local port.');
const trackingEnabled = parseTrackingEnabled(
  process.env.ORDER_PAD_TRACKING_ENABLED,
);
const root = await realpath(resolve('build'));
const cups = new Cups(process.env.ORDER_PAD_QUEUE ?? 'OrderPad');
const database = createOrderDatabase(
  parseDatabaseUrl(process.env.DATABASE_URL),
);
const captureFrom = parseCaptureFrom(process.env.ORDER_PAD_CAPTURE_FROM);
const station = new PostgresStationRepository(database, captureFrom);
await station.check();
await station.load();
const printing = new Printing(
  cups,
  station,
  process.env.ORDER_PAD_FONT ??
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
);
const orders = new Orders(new PostgresOrderRepository(database), captureFrom);
const server = createApp({
  origin,
  port,
  root,
  cups,
  printing,
  orders,
  trackingEnabled,
  station,
}).listen(port, '127.0.0.1', () =>
  console.log(
    `Order Pad Linux service listening on 127.0.0.1:${port}; open ${origin.origin}`,
  ),
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      void database.$disconnect();
    });
  });
}
