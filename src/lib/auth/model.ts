export interface AuthSession {
  readonly expiresAt: string;
  readonly authenticatedAt: string;
}
/** No 0/O, 1/I/L, so a code read off a printed slip types back unambiguously. */
export const ACCESS_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ACCESS_CODE_LENGTH = 10;
export const ACCESS_CODE_HOURS = 8;
/** Canonical code: uppercase, without the spaces or hyphens people type. */
export function parseAccessCode(value: unknown): string {
  const code =
    typeof value === 'string' && value.length <= 40
      ? value.replace(/[\s-]/g, '').toUpperCase()
      : '';
  if (
    code.length !== ACCESS_CODE_LENGTH ||
    [...code].some((c) => !ACCESS_CODE_ALPHABET.includes(c))
  )
    throw new Error(
      'Enter the 10-character access code printed at the station.',
    );
  return code;
}
export const formatAccessCode = (code: string) =>
  `${code.slice(0, 5)}-${code.slice(5)}`;
export function parseAuthSession(value: unknown): AuthSession {
  const v = value as AuthSession | null;
  if (
    !v ||
    typeof v.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    typeof v.authenticatedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.authenticatedAt))
  )
    throw new Error('Invalid authentication session.');
  return Object.freeze({
    expiresAt: v.expiresAt,
    authenticatedAt: v.authenticatedAt,
  });
}
/** How long a device waits for the station to approve its sign-in. */
export const SIGN_IN_REQUEST_MINUTES = 10;
export type SignInRequest =
  | {
      readonly status: 'pending';
      readonly match: string;
      readonly expiresAt: string;
    }
  | { readonly status: 'approved'; readonly expiresAt: string }
  | { readonly status: 'denied' | 'expired' | 'none' };
/** This device's sign-in request, as the station reports it. */
export function parseSignInRequest(value: unknown): SignInRequest {
  const v = value as Record<string, unknown> | null;
  const time = (t: unknown): t is string =>
    typeof t === 'string' && Number.isFinite(Date.parse(t));
  if (
    v?.status === 'pending' &&
    typeof v.match === 'string' &&
    /^\d{4}$/.test(v.match) &&
    time(v.expiresAt)
  )
    return Object.freeze({
      status: 'pending',
      match: v.match,
      expiresAt: v.expiresAt,
    });
  if (v?.status === 'approved' && time(v.expiresAt))
    return Object.freeze({ status: 'approved', expiresAt: v.expiresAt });
  if (v?.status === 'denied' || v?.status === 'expired' || v?.status === 'none')
    return Object.freeze({ status: v.status });
  throw new Error('Invalid sign-in request.');
}
