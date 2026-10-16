import type { BrowserContext, Page } from '@playwright/test';
import { StationConflict } from '../../printer-service/station-database';
import { MemoryStationRepository } from './station';
import type { OrderTicket } from '../../src/lib/tickets/ticket';

/** Mock centralized station state, shared across reloads and tabs. */
export async function mockStationApi(
  surface: Page | BrowserContext,
  onOrder?: (ticket: OrderTicket) => void,
  beforeOrder?: () => void,
) {
  await surface.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: {
        expiresAt: '2099-01-01T00:00:00.000Z',
        authenticatedAt: '2026-10-16T00:00:00.000Z',
      },
    }),
  );
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
        // Throwing here models a rolled-back intent transaction.
        if (command.operation === 'startOrder') beforeOrder?.();
        const snapshot = await station.mutate(command);
        if (command.operation === 'startOrder')
          onOrder?.(snapshot.saved!.ticket);
        return route.fulfill({ json: snapshot });
      }
      return route.fulfill({ json: await station.load() });
    } catch (error) {
      return route.fulfill({
        status: error instanceof StationConflict ? 409 : 503,
        json: {},
      });
    }
  });
  return {
    station,
    fail: (value: boolean) => {
      unavailable = value;
    },
  };
}
