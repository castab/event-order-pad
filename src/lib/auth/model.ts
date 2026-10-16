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
export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 128;
/** Count characters the way the server does, so emoji and accents count once. */
export const passwordLength = (value: string) => Array.from(value).length;
export const passwordReady = (password: string, confirm: string) =>
  passwordLength(password) >= PASSWORD_MIN &&
  passwordLength(password) <= PASSWORD_MAX &&
  password === confirm;
export function parsePassword(value: unknown): string {
  if (
    typeof value !== 'string' ||
    passwordLength(value) < PASSWORD_MIN ||
    passwordLength(value) > PASSWORD_MAX
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
