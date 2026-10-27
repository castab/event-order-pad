import { authFetch } from '../auth/client';
import { parseMenu, type Menu } from '../tickets/menu';

/** Reads the current menu; the builder only presents what the station returns. */
export async function fetchMenu(
  send: typeof fetch = (input, init) => authFetch(input, init),
): Promise<Menu> {
  const response = await send('/api/menu', {
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new Error('Menu unavailable. Restore Postgres and reload.');
  return parseMenu(await response.json());
}
