<script lang="ts">
  import designTokens from '../../design/tokens/tokens.css?raw';
  import '#lib/builder.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { startAppUpdates } from '#lib/app-update.js';
  import { currentSession } from '#lib/auth/client.js';
  import { hasActivity } from '#lib/auth/activity.js';
  import type { AuthSession } from '#lib/auth/model.js';
  import { provideSession } from '#lib/auth/session-context.js';
  const tokenCss = designTokens.replace(/@font-face\s*\{[^}]*\}/g, '');
  let { children } = $props();
  let session = $state<AuthSession>();
  provideSession(() => session);
  let lost = $state(false);
  let unavailable = $state('');
  const publicPage = $derived(
    ['/login', '/enroll', '/recover'].includes(
      page.url.pathname.replace(/\/$/, ''),
    ),
  );
  onMount(() => {
    const stopUpdates = startAppUpdates();
    let stopped = false;
    let checking = false;
    const required = () => {
      if (!publicPage) lost = true;
    };
    const check = async () => {
      if (checking || stopped || publicPage || lost) return;
      checking = true;
      try {
        const next = await currentSession();
        if (!stopped) {
          session = next;
          unavailable = '';
        }
      } catch {
        if (!stopped) {
          unavailable =
            'Connection unavailable. Reconnect to sign in and continue.';
          if (!hasActivity()) session = undefined;
        }
      } finally {
        checking = false;
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) {
        session = undefined;
        lost = false;
      }
      void check();
    };
    const preventBusyNavigation = (event: MouseEvent) => {
      if (
        hasActivity() &&
        event.target instanceof Element &&
        event.target.closest('a[href]')
      )
        event.preventDefault();
    };
    window.addEventListener('order-pad-auth-required', required);
    window.addEventListener('pageshow', shown);
    document.addEventListener('visibilitychange', visible);
    document.addEventListener('click', preventBusyNavigation, true);
    const health = setInterval(() => {
      if (session && Date.now() >= Date.parse(session.expiresAt)) required();
      else void check();
    }, 15000);
    const navigation = setInterval(() => {
      if (lost && !hasActivity()) {
        session = undefined;
        window.location.replace('/login/');
      }
    }, 200);
    void check();
    return () => {
      stopped = true;
      stopUpdates();
      clearInterval(health);
      clearInterval(navigation);
      window.removeEventListener('order-pad-auth-required', required);
      window.removeEventListener('pageshow', shown);
      document.removeEventListener('visibilitychange', visible);
      document.removeEventListener('click', preventBusyNavigation, true);
    };
  });
</script>

<svelte:head>{@html `<style>${tokenCss}</style>`}</svelte:head>
{#if publicPage}
  {@render children()}
{:else if session}
  <div class="authenticated-app" inert={lost}>
    {@render children()}
  </div>
  {#if lost}<div class="auth-overlay" role="status">
      Sign-in expired. Waiting for current work to finish safely…
    </div>{/if}
{:else}
  <main class="auth-card">
    <h1>Order Pad</h1>
    <p role="status">{unavailable || 'Checking sign-in…'}</p>
    <a href="/login/">Sign in</a>
  </main>
{/if}
