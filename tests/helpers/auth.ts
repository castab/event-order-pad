import type { Authentication, Identity } from '../../printer-service/auth';

/** Explicit authentication fixture for existing order/printing tests. */
export function testAuth(
  overrides: Partial<Authentication> = {},
): Authentication {
  const identity: Identity = Object.freeze({
    user: Object.freeze({ id: 'test-user', username: 'staff' }),
    expiresAt: new Date(Date.now() + 16 * 3600000).toISOString(),
    authenticatedAt: '2026-10-16T00:00:00.000Z',
    sessionHash: 'test',
    version: 0,
  });
  return {
    check: async () => {},
    session: async () => identity,
    workspace: async (_identity, browser) => browser,
    ratePage: async () => {},
    handle: async (path) => ({
      body:
        path === '/api/auth/session' ? identity : { sitekey: 'test-sitekey' },
    }),
    ...overrides,
  };
}
