<script lang="ts">
  import { onMount } from 'svelte';
  import { authRequest } from './client';
  interface TurnstileApi {
    render(element: HTMLElement, options: Record<string, unknown>): string;
    reset(id: string): void;
    remove(id: string): void;
  }
  let {
    action,
    token = $bindable(''),
    generation = 0,
  }: { action: string; token?: string; generation?: number } = $props();
  let container: HTMLDivElement;
  let error = $state('');
  let api: TurnstileApi | undefined;
  let widget: string | undefined;
  let ready = $state(false);
  $effect(() => {
    void generation;
    if (ready && widget && api) {
      token = '';
      api.reset(widget);
    }
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
          callback: (value: string) => {
            token = value;
            error = '';
          },
          'expired-callback': () => {
            token = '';
          },
          'error-callback': () => {
            token = '';
            error = 'Verification failed. Reload and try again.';
          },
        });
        ready = true;
      } catch (failure) {
        if (!stopped) error = (failure as Error).message;
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

<div bind:this={container} aria-label="Human verification"></div>
{#if error}<p role="alert">{error}</p>{/if}
