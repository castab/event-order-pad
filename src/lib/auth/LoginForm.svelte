<script lang="ts">
  import { authRequest, AuthRequestError } from './client';
  import { holdActivity } from './activity';
  import { holdUpdates } from '../app-update';
  import {
    ACCESS_CODE_ALPHABET,
    ACCESS_CODE_LENGTH,
    formatAccessCode,
    parseAccessCode,
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
  const complete = $derived(code.length === ACCESS_CODE_LENGTH);
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
  async function login() {
    if (pending || !complete) return;
    error = '';
    rejected = false;
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
      const result = await authRequest('login', {
        code: canonical,
        turnstile: verified,
      });
      code = '';
      const until = Date.parse(String(result.expiresAt));
      signedIn = Number.isFinite(until)
        ? `Signed in until ${new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Opening the order builder…`
        : 'Signed in. Opening the order builder…';
      window.location.replace('/');
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
</script>

<div class="auth-stack">
  {#if error}<AuthBanner kind="error">{error}</AuthBanner>{/if}
  {#if signedIn}<AuthBanner kind="success">{signedIn}</AuthBanner>{/if}
  <form
    class="auth-stack"
    novalidate
    hidden={!!signedIn}
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
