<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    authRequest,
    AuthRequestError,
    cancelSignIn,
    signInStatus,
  } from './client';
  import { holdActivity } from './activity';
  import { holdUpdates } from '../app-update';
  import {
    ACCESS_CODE_ALPHABET,
    ACCESS_CODE_LENGTH,
    formatAccessCode,
    parseAccessCode,
    parseSignInRequest,
    type SignInRequest,
  } from './model';
  import Turnstile from './Turnstile.svelte';
  import AuthBanner from './AuthBanner.svelte';
  import AuthIcon from './AuthIcon.svelte';
  let code = $state('');
  let token = $state('');
  let generation = $state(0);
  let turnstile = $state<ReturnType<typeof Turnstile>>();
  let pending = $state(false);
  let checking = $state(false);
  let error = $state('');
  let rejected = $state(false);
  let signedIn = $state('');
  let waiting = $state<{ match: string; expiresAt: string }>();
  let offline = $state(false);
  let denied = $state(false);
  let now = $state(Date.now());
  let watching = 0;
  const complete = $derived(code.length === ACCESS_CODE_LENGTH);
  const minutesLeft = $derived(
    waiting
      ? Math.max(1, Math.ceil((Date.parse(waiting.expiresAt) - now) / 60000))
      : 0,
  );
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));
  /** Keeps only characters a slip can show, so a typo never reaches the server. */
  function typed(event: Event & { currentTarget: HTMLInputElement }) {
    code = [...event.currentTarget.value.toUpperCase()]
      .filter((c) => ACCESS_CODE_ALPHABET.includes(c))
      .join('')
      .slice(0, ACCESS_CODE_LENGTH);
    event.currentTarget.value = shown(code);
    error = '';
    rejected = false;
  }
  const shown = (value: string) =>
    value.length > 5 ? formatAccessCode(value) : value;
  /** Applies the station's decision; only approval leaves this page. */
  function settle(request: SignInRequest) {
    if (request.status === 'pending') {
      void watch(request);
      return;
    }
    watching++;
    waiting = undefined;
    offline = false;
    if (request.status === 'approved') {
      const until = new Date(request.expiresAt).toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
      signedIn = `Approved. Signed in until ${until}. Opening the order builder…`;
      window.location.replace('/');
      return;
    }
    if (request.status === 'none') return;
    // A decided request is forgotten so a reload does not repeat its message.
    void cancelSignIn().catch(() => undefined);
    if (request.status === 'denied') denied = true;
    else
      error =
        'The request expired before anyone approved it. Enter the code to try again.';
  }
  /** Checks for the station's decision every 3 seconds; a failed check never ends the wait. */
  async function watch(request: { match: string; expiresAt: string }) {
    const id = ++watching;
    waiting = { match: request.match, expiresAt: request.expiresAt };
    now = Date.now();
    for (let first = true; id === watching; first = false) {
      if (!first) await pause(3000);
      if (id !== watching) return;
      let status;
      try {
        status = await signInStatus();
        offline = false;
      } catch {
        offline = true;
        continue;
      }
      if (id !== watching) return;
      now = Date.now();
      if (status.status !== 'pending') {
        if (status.status === 'none')
          error =
            'The request ended before anyone approved it. The code may have been replaced. Enter the latest code to try again.';
        settle(status);
        return;
      }
      waiting = { match: status.match, expiresAt: status.expiresAt };
    }
  }
  async function cancel() {
    watching++;
    waiting = undefined;
    offline = false;
    await cancelSignIn().catch(() => undefined);
  }
  async function login() {
    if (pending || !complete) return;
    error = '';
    rejected = false;
    denied = false;
    pending = true;
    checking = true;
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    let submitted = false;
    try {
      const canonical = parseAccessCode(code);
      // Never block the button on Cloudflare; wait for the token after the press instead.
      const verified = token || (await turnstile!.waitForToken());
      checking = false;
      submitted = true;
      const result = parseSignInRequest(
        await authRequest('login', {
          code: canonical,
          turnstile: verified,
        }),
      );
      code = '';
      settle(result);
    } catch (failure) {
      error = (failure as Error).message;
      rejected = failure instanceof AuthRequestError && failure.status === 401;
    } finally {
      if (submitted) generation++;
      pending = false;
      checking = false;
      release();
      releaseUpdates();
    }
  }
  // A reload while waiting picks the request back up from its cookie.
  onMount(() => {
    signInStatus().then(settle, () => undefined);
  });
  onDestroy(() => watching++);
</script>

<div class="auth-stack">
  {#if denied}
    <div class="print-toast error auth-toast" role="alert">
      <span class="toast-icon"><AuthIcon name="alert" /></span>
      <div class="toast-copy">
        <strong>The request to sign in was denied.</strong><span
          >Check with the shift lead before trying again.</span
        >
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Dismiss"
        onclick={() => (denied = false)}><AuthIcon name="close" /></button
      >
    </div>
  {/if}
  {#if error}<AuthBanner kind="error">{error}</AuthBanner>{/if}
  {#if signedIn}<AuthBanner kind="success">{signedIn}</AuthBanner>{/if}
  {#if waiting}
    <section class="auth-waiting" aria-labelledby="waiting-title">
      <h2 id="waiting-title">Waiting for approval</h2>
      <p>
        Show this number to whoever runs the station. They approve this device
        only if their screen shows the same number.
      </p>
      <p class="match-number">
        <span class="sr-only">Your number is</span>
        {waiting.match}
      </p>
      <p class="auth-hint" aria-live="polite">
        {offline
          ? 'Connection lost. Still waiting…'
          : `Waits up to ${minutesLeft} more ${minutesLeft === 1 ? 'minute' : 'minutes'}.`}
      </p>
      <button type="button" class="secondary auth-wide" onclick={cancel}
        >Cancel</button
      >
    </section>
  {/if}
  <form
    class="auth-stack"
    novalidate
    hidden={!!signedIn || !!waiting}
    onsubmit={(event) => {
      event.preventDefault();
      void login();
    }}
  >
    <div class="auth-field">
      <label for="access-code">Access code</label>
      <input
        id="access-code"
        class="access-code-input"
        class:complete
        value={shown(code)}
        oninput={typed}
        autocomplete="one-time-code"
        autocapitalize="characters"
        autocorrect="off"
        spellcheck="false"
        maxlength="20"
        placeholder="XXXXX-XXXXX"
        aria-describedby="access-code-count"
        aria-invalid={rejected}
      />
      <p
        id="access-code-count"
        class="auth-hint"
        class:complete
        aria-live="polite"
      >
        {#if complete}<AuthIcon
            name="check"
            size={16}
          />Ready{:else if code}{code.length}
          of {ACCESS_CODE_LENGTH} characters{:else}{ACCESS_CODE_LENGTH} letters and
          numbers. Capitals and the dash are added for you.{/if}
      </p>
    </div>
    <Turnstile
      bind:this={turnstile}
      action="login"
      bind:token
      {generation}
      onerror={(message) => (error = message)}
    />
    <button
      type="submit"
      class="primary auth-wide auth-large"
      disabled={pending || !complete}
      >{checking
        ? 'Checking…'
        : pending
          ? 'Signing in…'
          : 'Start shift'}</button
    >
  </form>
</div>
