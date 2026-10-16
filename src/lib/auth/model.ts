export interface AuthSession {
  readonly user: { readonly id: string; readonly username: string };
  readonly expiresAt: string;
  readonly authenticatedAt: string;
}
export function parseUsername(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 32 ||
    /[^a-zA-Z0-9._-]/.test(value)
  )
    throw new Error(
      'Use a username of 3–32 letters, digits, dots, underscores or hyphens.',
    );
  return value.toLowerCase();
}
export function parsePassword(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Array.from(value).length < 15 ||
    Array.from(value).length > 128
  )
    throw new Error('Use a password of 15–128 characters. Spaces are welcome.');
  return value;
}
export function parseAuthSession(value: unknown): AuthSession {
  const v = value as AuthSession | null;
  if (
    !v ||
    typeof v.user?.id !== 'string' ||
    !v.user.id ||
    parseUsername(v.user.username) !== v.user.username ||
    typeof v.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(v.expiresAt)) ||
    typeof v.authenticatedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.authenticatedAt))
  )
    throw new Error('Invalid authentication session.');
  return Object.freeze({
    user: Object.freeze({ id: v.user.id, username: v.user.username }),
    expiresAt: v.expiresAt,
    authenticatedAt: v.authenticatedAt,
  });
}
