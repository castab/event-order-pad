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
