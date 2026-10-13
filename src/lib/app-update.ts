// Keeps a long-lived station tab on the latest deployed version. A new service
// worker installs in the background and then waits; this applies it (and reloads
// onto the new assets) only at a moment that cannot interrupt a send.

export const checkIntervalMs = 5 * 60_000;
export const settleAfterLoadMs = 10_000;
export const idleAfterInputMs = 60_000;

let holds = 0;

/** Block update reloads while work is in flight. Call the result to release. */
export function holdUpdates(): () => void {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

export interface ApplyContext {
  held: boolean;
  hidden: boolean;
  msSinceLoad: number;
  msSinceInput: number;
}

/** Apply a waiting update only when nothing is in flight and the user isn't mid-interaction. */
export function shouldApplyUpdate(context: ApplyContext): boolean {
  if (context.held) return false;
  return (
    context.hidden ||
    context.msSinceLoad < settleAfterLoadMs ||
    context.msSinceInput >= idleAfterInputMs
  );
}

/** Start update checks for this page; returns a cleanup function. */
export function startAppUpdates(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator))
    return () => undefined;
  const container = navigator.serviceWorker;
  const loadedAt = Date.now();
  let lastInput = loadedAt;
  let registration: ServiceWorkerRegistration | undefined;
  let applying = false;
  let stopped = false;
  // Only reload for a worker swap if one was already controlling this page;
  // the first-ever install claims clients but needs no reload.
  const hadController = !!container.controller;

  const tryApply = () => {
    const waiting = registration?.waiting;
    if (!waiting || applying || !container.controller) return;
    if (
      !shouldApplyUpdate({
        held: holds > 0,
        hidden: document.visibilityState === 'hidden',
        msSinceLoad: Date.now() - loadedAt,
        msSinceInput: Date.now() - lastInput,
      })
    )
      return;
    applying = true;
    waiting.postMessage('SKIP_WAITING');
  };
  const check = () => {
    if (!navigator.onLine) return;
    void registration?.update().then(tryApply, () => undefined);
  };
  const watch = (reg: ServiceWorkerRegistration) => {
    registration = reg;
    const track = (worker: ServiceWorker | null) =>
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed') tryApply();
      });
    reg.addEventListener('updatefound', () => track(reg.installing));
    track(reg.installing);
    tryApply();
    check();
  };
  const onControllerChange = () => {
    if (hadController && !stopped) location.reload();
  };
  const onInput = () => {
    lastInput = Date.now();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') check();
    else tryApply();
  };

  container.addEventListener('controllerchange', onControllerChange);
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('online', check);
  window.addEventListener('pointerdown', onInput, true);
  window.addEventListener('keydown', onInput, true);
  const checkTimer = setInterval(check, checkIntervalMs);
  const idleTimer = setInterval(tryApply, 15_000);
  void container.ready.then((reg) => {
    if (!stopped) watch(reg);
  });

  return () => {
    stopped = true;
    clearInterval(checkTimer);
    clearInterval(idleTimer);
    container.removeEventListener('controllerchange', onControllerChange);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('online', check);
    window.removeEventListener('pointerdown', onInput, true);
    window.removeEventListener('keydown', onInput, true);
  };
}
