<script lang="ts">
  import {
    startAuthentication,
    type PublicKeyCredentialRequestOptionsJSON,
  } from '@simplewebauthn/browser';
  import { authRequest } from './client';
  import { holdActivity } from './activity';
  import { holdUpdates } from '../app-update';
  import Turnstile from './Turnstile.svelte';
  let {
    reauthenticate = false,
    username: initialName = '',
    done,
  }: {
    reauthenticate?: boolean;
    username?: string;
    done?: () => void;
  } = $props();
  let username = $state('');
  $effect(() => {
    if (reauthenticate) username = initialName;
  });
  let password = $state('');
  let token = $state('');
  let generation = $state(0);
  let busy = $state(false);
  let error = $state('');
  async function login(passkey: boolean) {
    if (busy || !token) return;
    busy = true;
    error = '';
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    try {
      if (passkey) {
        const prefix = reauthenticate ? 'passkey/reauth' : 'passkey/login';
        const data = await authRequest(prefix + '/options', {
          turnstile: token,
        });
        const options = data.options as PublicKeyCredentialRequestOptionsJSON;
        if (!options || typeof options.challenge !== 'string')
          throw new Error('Invalid passkey options.');
        const response = await startAuthentication({ optionsJSON: options });
        await authRequest(prefix + '/verify', { response });
      } else
        await authRequest(reauthenticate ? 'reauthenticate' : 'login', {
          username,
          password,
          turnstile: token,
        });
      password = '';
      if (reauthenticate) done?.();
      else window.location.replace('/');
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      generation++;
      busy = false;
      release();
      releaseUpdates();
    }
  }
</script>

<form
  onsubmit={(event) => {
    event.preventDefault();
    void login(false);
  }}
>
  <label
    >Username<input
      bind:value={username}
      autocomplete="username webauthn"
      required
      minlength="3"
      maxlength="32"
      autocapitalize="none"
      spellcheck="false"
      readonly={reauthenticate}
    /></label
  >
  <label
    >Password<input
      bind:value={password}
      type="password"
      autocomplete="current-password"
      required
      maxlength="256"
    /></label
  >
  <Turnstile action="login" bind:token {generation} />
  <button type="submit" disabled={busy || !token}
    >{busy
      ? 'Signing in…'
      : reauthenticate
        ? 'Confirm password'
        : 'Sign in'}</button
  >
  <button
    type="button"
    disabled={busy || !token}
    onclick={() => void login(true)}
    >{reauthenticate
      ? 'Confirm with passkey'
      : 'Sign in with a passkey'}</button
  >
  {#if error}<p role="alert">{error}</p>{/if}
</form>
