<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { authRequest } from './client';
  interface TurnstileApi {
    render(element: HTMLElement, options: Record<string, unknown>): string;
    reset(id: string): void;
    remove(id: string): void;
  }
  interface Waiter {
    resolve(token: string): void;
    reject(error: Error): void;
  }
  let {
    action,
    token = $bindable(''),
    generation = 0,
    onerror,
  }: {
    action: string;
    token?: string;
    generation?: number;
    onerror?: (message: string) => void;
  } = $props();
  let container: HTMLDivElement;
  let failure = '';
  let api: TurnstileApi | undefined;
  let widget: string | undefined;
  const waiters = new Set<Waiter>();
  function fail(message: string) {
    failure = message;
    token = '';
    for (const waiter of waiters) waiter.reject(new Error(message));
    onerror?.(message);
  }
  /** Resolve with a verification token, waiting for Cloudflare if none is ready yet. */
  export function waitForToken(timeout = 15000): Promise<string> {
    if (token) return Promise.resolve(token);
    if (failure) return Promise.reject(new Error(failure));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        token = '';
        if (widget && api) api.reset(widget);
        reject(
          new Error(
            'Couldn’t verify this browser. Check your connection and try again.',
          ),
        );
      }, timeout);
      const waiter: Waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          waiters.delete(waiter);
          reject(error);
        },
      };
      waiters.add(waiter);
    });
  }
  $effect(() => {
    void generation;
    // Refresh only after submission, without tracking widget callbacks or bindings.
    untrack(() => {
      if (widget && api) {
        token = '';
        api.reset(widget);
      }
    });
  });
  onMount(() => {
    let stopped = false;
    let script: HTMLScriptElement | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const start = async () => {
      try {
        const config = await authRequest('config');
        if (typeof config.sitekey !== 'string' || !config.sitekey)
          throw new Error('Verification is unavailable.');
        api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
        if (!api) {
          await new Promise<void>((resolve, reject) => {
            script = document.createElement('script');
            script.src =
              'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () =>
              reject(
                new Error('Verification could not load. Reload and try again.'),
              );
            timer = setTimeout(
              () =>
                reject(
                  new Error('Verification timed out. Reload and try again.'),
                ),
              15000,
            );
            document.head.append(script);
          });
          clearTimeout(timer!);
          api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
        }
        if (stopped) return;
        if (!api)
          throw new Error('Verification is unavailable. Reload and try again.');
        widget = api.render(container, {
          sitekey: config.sitekey,
          action,
          theme: 'light',
          // Cloudflare shows the widget only when it needs the person to interact.
          appearance: 'interaction-only',
          callback: (value: string) => {
            token = value;
            failure = '';
            for (const waiter of waiters) waiter.resolve(value);
          },
          'expired-callback': () => {
            token = '';
          },
          'error-callback': () =>
            fail('Verification failed. Reload and try again.'),
        });
      } catch (error) {
        if (!stopped) fail((error as Error).message);
      }
    };
    void start();
    return () => {
      stopped = true;
      clearTimeout(timer!);
      if (widget && api) api.remove(widget);
      script?.remove();
    };
  });
</script>

<div
  class="turnstile-slot"
  bind:this={container}
  aria-label="Human verification"
></div>
