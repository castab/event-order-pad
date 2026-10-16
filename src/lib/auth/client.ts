import { parseAuthSession, type AuthSession } from './model';
import { holdActivity } from './activity';

export function authenticationRequired() {
  if (typeof window !== 'undefined')
    window.dispatchEvent(new Event('order-pad-auth-required'));
}
/** Observe authentication rejection without retrying or navigating during a send. */
export const authFetch: typeof fetch = async (input, init) => {
  const release = holdActivity();
  try {
    const response = await fetch(input, init);
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
/** A rejected authentication request, keeping its status for callers that react to it. */
export class AuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
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
    throw new AuthRequestError(
      typeof data.error === 'string'
        ? data.error
        : 'Authentication unavailable. Try again.',
      response.status,
    );
  return data;
}
export async function currentSession(): Promise<AuthSession> {
  return parseAuthSession(await authRequest('session'));
}
