<script lang="ts">
  import { authRequest } from './client';
  import { holdActivity } from './activity';
  import { holdUpdates } from '../app-update';
  import { parseAccessCode } from './model';
  import Turnstile from './Turnstile.svelte';
  import AuthBanner from './AuthBanner.svelte';
  let code = $state('');
  let token = $state('');
  let generation = $state(0);
  let turnstile = $state<ReturnType<typeof Turnstile>>();
  let pending = $state(false);
  let checking = $state(false);
  let error = $state('');
  let touched = $state(false);
  let signedIn = $state(false);
  async function login() {
    if (pending) return;
    error = '';
    try {
      parseAccessCode(code);
    } catch (failure) {
      touched = true;
      error = (failure as Error).message;
      return;
    }
    touched = false;
    pending = true;
    checking = true;
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    let submitted = false;
    try {
      // Never block the button on Cloudflare; wait for the token after the press instead.
      const verified = token || (await turnstile!.waitForToken());
      checking = false;
      submitted = true;
      await authRequest('login', { code, turnstile: verified });
      code = '';
      signedIn = true;
      window.location.replace('/');
    } catch (failure) {
      error = (failure as Error).message;
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
  {#if signedIn}<AuthBanner kind="success"
      >Signed in. Opening the order builder…</AuthBanner
    >{/if}
  <form
    class="auth-stack"
    novalidate
    hidden={signedIn}
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
        bind:value={code}
        autocomplete="one-time-code"
        autocapitalize="characters"
        spellcheck="false"
        maxlength="20"
        placeholder="XXXXX-XXXXX"
        aria-describedby="access-code-hint"
        aria-invalid={touched}
      />
      <p id="access-code-hint" class="auth-hint">
        The current code is printed at the station. A new code ends this one.
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
      disabled={pending}
      >{checking
        ? 'Checking…'
        : pending
          ? 'Signing in…'
          : 'Start shift'}</button
    >
  </form>
</div>
