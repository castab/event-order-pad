import { parseAuthSession, type AuthSession } from './model';
import { holdActivity } from './activity';
let expectedUser: string | undefined;

export function authenticationRequired() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event('order-pad-auth-required'));
}
/** Observe authentication rejection without retrying or navigating during a send. */
export const authFetch: typeof fetch = async (input, init) => {
  const release = holdActivity();
  try {
    const path =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;
    const unbound = [
      '/api/auth/config',
      '/api/auth/session',
      '/api/auth/login',
      '/api/auth/enroll',
      '/api/auth/recover',
      '/api/auth/passkey/login/options',
      '/api/auth/passkey/login/verify',
    ].includes(path);
    let requestInit = init;
    if (expectedUser && path.startsWith('/api/') && !unbound) {
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      headers.set('X-Order-Pad-User', expectedUser);
      requestInit = { ...init, headers };
    }
    const response = await fetch(input, requestInit);
    if (response.status === 401) {
      const data = await response
        .clone()
        .json()
        .catch(() => undefined);
      if (data?.code === 'authentication-required') authenticationRequired();
    }
    return response;
  } finally {
    release();
  }
};
export async function authRequest(
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await authFetch('/api/auth/' + path, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
    ...(body
      ? {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const result: unknown = await response.json();
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Invalid authentication response.');
  const data = result as Record<string, unknown>;
  if (!response.ok)
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : 'Authentication unavailable. Try again.',
    );
  return data;
}
export async function currentSession(): Promise<AuthSession> {
  const session = parseAuthSession(await authRequest('session'));
  if (expectedUser && expectedUser !== session.user.id) {
    authenticationRequired();
    throw new Error(
      'The signed-in account changed. Sign in again to reload your workspace.',
    );
  }
  expectedUser = session.user.id;
  return session;
}
export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}
export async function listPasskeys(): Promise<readonly PasskeySummary[]> {
  const data = await authRequest('passkeys');
  if (!Array.isArray(data.passkeys)) throw new Error('Invalid passkey list.');
  return Object.freeze(
    data.passkeys.map((value) => {
      if (
        !value ||
        typeof value.id !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(value.createdAt))
      )
        throw new Error('Invalid passkey.');
      return Object.freeze({
        id: value.id,
        name: value.name,
        createdAt: value.createdAt,
      });
    }),
  );
}
