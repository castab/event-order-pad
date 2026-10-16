import { test, expect } from '@playwright/test';
import { realpath } from 'node:fs/promises';
import { createApp } from '../printer-service/http';
import { Orders } from '../printer-service/orders';
import { testAuth } from './helpers/auth';
import {
  MemoryOrderRepository,
  testCaptureFrom,
} from './helpers/order-repository';
import { MemoryStationRepository } from './helpers/station';

test('the production service serves the built sign-in page and no account pages', async ({
  request,
}) => {
  const auth = testAuth({ session: async () => undefined });
  const origin = new URL('http://127.0.0.1:0');
  const repository = new MemoryOrderRepository();
  const server = createApp({
    auth,
    origin,
    port: 0,
    root: await realpath('build'),
    cups: { queue: 'TestQueue', check: async () => 'Ready' },
    orders: new Orders(repository, testCaptureFrom),
    station: new MemoryStationRepository(repository),
    printing: {
      print: async () => {
        throw new Error('No printing in authentication page checks');
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin.port = String((server.address() as { port: number }).port);
  try {
    const redirect = await request.get(origin.origin, { maxRedirects: 0 });
    expect(redirect.status()).toBe(303);
    expect(redirect.headers().location).toBe('/login/');
    for (const suffix of ['', '/']) {
      const response = await request.get(`${origin.origin}/login${suffix}`);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('text/html');
      expect(response.headers()['cache-control']).toBe('no-store');
      expect(await response.text()).toContain('Access code');
    }
    for (const path of ['enroll', 'recover', 'account']) {
      const hidden = await request.get(`${origin.origin}/${path}/`, {
        maxRedirects: 0,
      });
      expect(hidden.status()).toBe(303);
    }
    auth.session = testAuth().session;
    for (const path of ['enroll', 'recover', 'account'])
      expect((await request.get(`${origin.origin}/${path}/`)).status()).toBe(
        404,
      );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
