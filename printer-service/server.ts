import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Cups } from './cups';
import { Printing } from './printing';
import { Orders } from './orders';
import { join } from 'node:path';
import { createApp } from './http';

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
const root = await realpath(resolve('build'));
const cups = new Cups(process.env.ORDER_PAD_QUEUE ?? 'OrderPad');
const printing = new Printing(
  cups,
  resolve(process.env.ORDER_PAD_DATA ?? '.print-data'),
  process.env.ORDER_PAD_FONT ??
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
);
const orders = new Orders(
  join(resolve(process.env.ORDER_PAD_DATA ?? '.print-data'), 'orders'),
);
createApp({ origin, port, root, cups, printing, orders }).listen(
  port,
  '127.0.0.1',
  () =>
    console.log(
      `Order Pad Linux service listening on 127.0.0.1:${port}; open ${origin.origin}`,
    ),
);
