import type { BrowserContext, Page } from '@playwright/test';
import { MemoryStationRepository } from './station';
import type { OrderTicket } from '../../src/lib/tickets/ticket';

/** Mock centralized station state, shared across reloads and tabs. */
export async function mockStationApi(
  surface: Page | BrowserContext,
  onOrder?: (ticket: OrderTicket) => void,
) {
  const station = new MemoryStationRepository();
  let unavailable = false;
  await surface.route('**/api/database', (route) =>
    route.fulfill({
      status: unavailable ? 503 : 200,
      json: { ready: !unavailable },
    }),
  );
  await surface.route('**/api/station', async (route) => {
    if (unavailable) return route.fulfill({ status: 503, json: {} });
    try {
      if (route.request().method() === 'POST') {
        const command = route.request().postDataJSON();
        if (command.operation === 'startOrder') onOrder?.(command.ticket);
        return route.fulfill({ json: await station.mutate(command) });
      }
      return route.fulfill({ json: await station.load() });
    } catch {
      return route.fulfill({ status: 409, json: {} });
    }
  });
  return {
    station,
    fail: (value: boolean) => {
      unavailable = value;
    },
  };
}
