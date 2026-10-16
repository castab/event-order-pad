import { getContext, setContext } from 'svelte';
import type { AuthSession } from './model';

const key = Symbol('auth-session');
/** Share the layout's verified session with pages without another request. */
export function provideSession(get: () => AuthSession | undefined) {
  setContext(key, get);
}
export function sessionUsername(): () => string {
  const get = getContext<(() => AuthSession | undefined) | undefined>(key);
  return () => get?.()?.user.username ?? '';
}
