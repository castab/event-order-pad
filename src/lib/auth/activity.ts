let active = 0;
/** Keep authentication navigation from interrupting a save or print handoff. */
export function holdActivity(): () => void {
  active++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active--;
    }
  };
}
export const hasActivity = () => active > 0;
