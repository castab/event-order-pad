<script lang="ts">
  import {
    startAuthentication,
    WebAuthnAbortService,
    type PublicKeyCredentialRequestOptionsJSON,
  } from '@simplewebauthn/browser';
  import { authRequest } from './client';
  import { holdActivity } from './activity';
  import { holdUpdates } from '../app-update';
  import Turnstile from './Turnstile.svelte';
  import AuthBanner from './AuthBanner.svelte';
  import AuthIcon from './AuthIcon.svelte';
  import PasswordField from './PasswordField.svelte';
  let {
    reauthenticate = false,
    username: initialName = '',
    working = $bindable(false),
    done,
    cancel,
  }: {
    reauthenticate?: boolean;
    username?: string;
    working?: boolean;
    done?: () => void | Promise<void>;
    cancel?: () => void;
  } = $props();
  let username = $state('');
  $effect(() => {
    if (reauthenticate) username = initialName;
  });
  let password = $state('');
  let token = $state('');
  let generation = $state(0);
  let turnstile = $state<ReturnType<typeof Turnstile>>();
  let pending = $state<'' | 'password' | 'passkey'>('');
  let checking = $state(false);
  let error = $state('');
  let touched = $state(false);
  let signedIn = $state(false);
  let cancelled = false;
  const waiting = $derived(pending === 'passkey' && !checking);
  $effect(() => {
    working = !!pending;
  });
  function cancelPasskey() {
    cancelled = true;
    WebAuthnAbortService.cancelCeremony();
  }
  async function login(passkey: boolean) {
    if (pending) return;
    error = '';
    if (!passkey && (!username.trim() || !password)) {
      touched = true;
      error = reauthenticate
        ? 'Enter your password.'
        : 'Enter your username and password.';
      return;
    }
    touched = false;
    cancelled = false;
    pending = passkey ? 'passkey' : 'password';
    checking = true;
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    let submitted = false;
    try {
      // Never block the button on Cloudflare; wait for the token after the press instead.
      const verified = token || (await turnstile!.waitForToken());
      checking = false;
      submitted = true;
      if (passkey) {
        const prefix = reauthenticate ? 'passkey/reauth' : 'passkey/login';
        const data = await authRequest(prefix + '/options', {
          turnstile: verified,
        });
        const options = data.options as PublicKeyCredentialRequestOptionsJSON;
        if (!options || typeof options.challenge !== 'string')
          throw new Error('Invalid passkey options.');
        const cancelledMessage = reauthenticate
          ? 'Passkey confirmation was cancelled. Try again or use your password.'
          : 'Passkey sign-in was cancelled. Try again or use your password.';
        // Cancel can land before the ceremony starts, when there is nothing to abort.
        if (cancelled) throw new Error(cancelledMessage);
        let response;
        try {
          response = await startAuthentication({ optionsJSON: options });
        } catch (failure) {
          if (cancelled) throw new Error(cancelledMessage);
          throw failure;
        }
        await authRequest(prefix + '/verify', { response });
      } else
        await authRequest(reauthenticate ? 'reauthenticate' : 'login', {
          username,
          password,
          turnstile: verified,
        });
      password = '';
      if (reauthenticate) await done?.();
      else {
        signedIn = true;
        window.location.replace('/');
      }
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      if (submitted) generation++;
      pending = '';
      checking = false;
      release();
      releaseUpdates();
    }
  }
  const passkeyLabel = $derived(
    checking && pending === 'passkey'
      ? 'Checking…'
      : reauthenticate
        ? 'Confirm with a passkey'
        : 'Sign in with a passkey',
  );
  const submitLabel = $derived(
    checking && pending === 'password'
      ? 'Checking…'
      : pending === 'password'
        ? reauthenticate
          ? 'Confirming…'
          : 'Signing in…'
        : reauthenticate
          ? 'Confirm'
          : 'Sign in',
  );
</script>

<div class="auth-stack">
  {#if error}<AuthBanner kind="error">{error}</AuthBanner>{/if}
  {#if signedIn}<AuthBanner kind="success"
      >Signed in. Opening the order builder…</AuthBanner
    >{/if}
  {#if waiting}
    <div class="auth-panel auth-waiting" role="status">
      <strong>Waiting for your passkey…</strong>
      <span
        >Use your fingerprint, face or device PIN when your phone or browser
        asks.</span
      >
      <button type="button" class="ghost" onclick={cancelPasskey}>Cancel</button
      >
    </div>
  {/if}
  <!-- Hidden rather than removed, so the Turnstile widget survives the passkey wait. -->
  <div class="auth-stack" hidden={waiting || signedIn}>
    <button
      type="button"
      class="auth-passkey"
      disabled={!!pending}
      onclick={() => void login(true)}
      ><AuthIcon name="key" />{passkeyLabel}</button
    >
    <div class="auth-divider" aria-hidden="true">
      <span>{reauthenticate ? 'or' : 'or use your password'}</span>
    </div>
    <form
      class="auth-stack"
      novalidate
      onsubmit={(event) => {
        event.preventDefault();
        void login(false);
      }}
    >
      {#if reauthenticate}
        <input
          type="text"
          class="sr-only"
          value={username}
          autocomplete="username"
          readonly
          tabindex="-1"
          aria-hidden="true"
        />
      {:else}
        <div class="auth-field">
          <label for="login-username">Username</label>
          <input
            id="login-username"
            bind:value={username}
            autocomplete="username webauthn"
            minlength="3"
            maxlength="32"
            autocapitalize="none"
            spellcheck="false"
            aria-invalid={touched && !username.trim()}
          />
        </div>
      {/if}
      <PasswordField
        id={reauthenticate ? 'reauth-password' : 'login-password'}
        label={reauthenticate ? `Password for ${username}` : 'Password'}
        bind:value={password}
        autocomplete="current-password"
        invalid={touched && !password}
        capsLock
      />
      <Turnstile
        bind:this={turnstile}
        action="login"
        bind:token
        {generation}
        onerror={(message) => (error = message)}
      />
      {#if reauthenticate}
        <div class="auth-actions">
          <button type="submit" class="primary" disabled={!!pending}
            >{submitLabel}</button
          >
          <button
            type="button"
            class="ghost"
            disabled={!!pending}
            onclick={() => cancel?.()}>Cancel</button
          >
        </div>
      {:else}
        <button
          type="submit"
          class="primary auth-wide auth-large"
          disabled={!!pending}>{submitLabel}</button
        >
      {/if}
    </form>
  </div>
</div>
