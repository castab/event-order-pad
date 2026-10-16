<script lang="ts">
  import { onMount } from 'svelte';
  import Turnstile from './Turnstile.svelte';
  import { authRequest } from './client';
  import { parsePassword } from './model';
  import { holdActivity } from './activity';
  import { holdUpdates } from '../app-update';
  let { kind }: { kind: 'enroll' | 'recover' } = $props();
  let code = $state('');
  let password = $state('');
  let confirm = $state('');
  let token = $state('');
  let generation = $state(0);
  let busy = $state(false);
  let error = $state('');
  onMount(() => {
    code = window.location.hash.slice(1);
    history.replaceState(null, '', window.location.pathname);
  });
  async function redeem() {
    if (busy || !token) return;
    error = '';
    try {
      parsePassword(password);
      if (password !== confirm) throw new Error('The passwords do not match.');
    } catch (failure) {
      error = (failure as Error).message;
      return;
    }
    busy = true;
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    try {
      await authRequest(kind, { token: code, password, turnstile: token });
      password = '';
      confirm = '';
      window.location.replace('/');
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      busy = false;
      generation++;
      release();
      releaseUpdates();
    }
  }
</script>

<form
  onsubmit={(event) => {
    event.preventDefault();
    void redeem();
  }}
>
  <label
    >{kind === 'enroll' ? 'Enrollment code' : 'Recovery code'}<input
      bind:value={code}
      autocomplete="off"
      required
      spellcheck="false"
      autocapitalize="none"
    /></label
  >
  <p>
    Your username was chosen when this code was issued. Use a password of 15–128
    characters; spaces are welcome.
  </p>
  <label
    >New password<input
      bind:value={password}
      type="password"
      autocomplete="new-password"
      required
      maxlength="256"
    /></label
  >
  <label
    >Confirm password<input
      bind:value={confirm}
      type="password"
      autocomplete="new-password"
      required
      maxlength="256"
    /></label
  >
  <Turnstile action={kind} bind:token {generation} />
  <button disabled={busy || !token}
    >{busy
      ? 'Saving…'
      : kind === 'enroll'
        ? 'Create account'
        : 'Recover account'}</button
  >
  {#if error}<p role="alert">{error}</p>{/if}
</form>
