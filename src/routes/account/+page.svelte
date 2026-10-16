<script lang="ts">
  import { onMount } from 'svelte';
  import {
    startRegistration,
    type PublicKeyCredentialCreationOptionsJSON,
  } from '@simplewebauthn/browser';
  import {
    authRequest,
    currentSession,
    listPasskeys,
    type PasskeySummary,
  } from '#lib/auth/client.js';
  import { parsePassword } from '#lib/auth/model.js';
  import { holdActivity } from '#lib/auth/activity.js';
  import { holdUpdates } from '#lib/app-update.js';
  import LoginForm from '#lib/auth/LoginForm.svelte';
  let username = $state('');
  let keys = $state<readonly PasskeySummary[]>([]);
  let password = $state('');
  let confirm = $state('');
  let name = $state('');
  let busy = $state(false);
  let message = $state('');
  let error = $state('');
  let authenticatedAt = $state('');
  const recent = $derived(
    !!authenticatedAt && Date.now() - Date.parse(authenticatedAt) < 300000,
  );
  async function refresh() {
    const session = await currentSession();
    username = session.user.username;
    authenticatedAt = session.authenticatedAt;
    keys = await listPasskeys();
  }
  onMount(() => {
    void refresh().catch((failure) => {
      error = failure.message;
    });
  });
  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    message = '';
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    try {
      await work();
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      busy = false;
      release();
      releaseUpdates();
    }
  }
  function addPasskey() {
    return run(async () => {
      const data = await authRequest('passkey/register/options', {});
      const options = data.options as PublicKeyCredentialCreationOptionsJSON;
      if (!options || typeof options.challenge !== 'string')
        throw new Error('Invalid passkey options.');
      const response = await startRegistration({ optionsJSON: options });
      await authRequest('passkey/register/verify', { response, name });
      name = '';
      await refresh();
      message = 'Passkey added.';
    });
  }
  function changePassword() {
    return run(async () => {
      parsePassword(password);
      if (password !== confirm) throw new Error('The passwords do not match.');
      await authRequest('password', { password });
      password = '';
      confirm = '';
      await refresh();
      message = 'Password changed. Other sessions have been signed out.';
    });
  }
  function logout(all: boolean) {
    return run(async () => {
      await authRequest(all ? 'logout-all' : 'logout', {});
      window.location.replace('/login/');
    });
  }
</script>

<svelte:head><title>Account · Order Pad</title></svelte:head>
<main class="auth-card">
  <h1>Your account</h1>
  <p>
    Signed in as <strong>{username}</strong>. All users can take orders, print
    and manage the queue.
  </p>
  <a href="/">Order builder</a><a href="/queue/">Now Scooping</a>
  <section>
    <h2>Confirm your identity</h2>
    <p>Credential changes require sign-in within the last five minutes.</p>
    {#if username}<LoginForm
        reauthenticate
        {username}
        done={() => void refresh()}
      />{/if}
  </section>
  <section>
    <h2>Passkeys</h2>
    <ul>
      {#each keys as key (key.id)}<li>
          {key.name}<button
            disabled={busy}
            onclick={() =>
              void run(async () => {
                await authRequest('passkey/remove', { id: key.id });
                await refresh();
                message = 'Passkey removed.';
              })}
            aria-label={`Remove passkey ${key.name}`}>Remove</button
          >
        </li>{/each}
    </ul>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void addPasskey();
      }}
    >
      <label
        >Passkey name<input
          bind:value={name}
          maxlength="80"
          required
          placeholder="For example, phone or security key"
        /></label
      ><button disabled={busy || !recent}>Add a passkey</button>
    </form>
  </section>
  <section>
    <h2>Change password</h2>
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void changePassword();
      }}
    >
      <label
        >New password<input
          type="password"
          bind:value={password}
          autocomplete="new-password"
          maxlength="256"
          required
        /></label
      >
      <label
        >Confirm new password<input
          type="password"
          bind:value={confirm}
          autocomplete="new-password"
          maxlength="256"
          required
        /></label
      >
      <button disabled={busy || !recent}>Change password</button>
    </form>
  </section>
  <section>
    <h2>Sessions</h2>
    <p>
      Sign-in lasts 16 hours. Account enrollment, disabling and recovery are
      managed on the Linux station.
    </p>
    <button disabled={busy} onclick={() => void logout(false)}>Sign out</button
    ><button disabled={busy} onclick={() => void logout(true)}
      >Sign out all devices</button
    >
  </section>
  {#if error}<p role="alert">{error}</p>{/if}{#if message}<p role="status">
      {message}
    </p>{/if}
</main>
