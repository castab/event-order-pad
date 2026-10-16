<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    AuthRequestError,
    authRequest,
    currentSession,
    listPasskeys,
    type PasskeySummary,
  } from '#lib/auth/client.js';
  import { passwordReady, type AuthSession } from '#lib/auth/model.js';
  import { registerPasskey } from '#lib/auth/passkeys.js';
  import { holdActivity } from '#lib/auth/activity.js';
  import { holdUpdates } from '#lib/app-update.js';
  import LoginForm from '#lib/auth/LoginForm.svelte';
  import AuthBanner from '#lib/auth/AuthBanner.svelte';
  import AuthIcon from '#lib/auth/AuthIcon.svelte';
  import NewPasswordFields from '#lib/auth/NewPasswordFields.svelte';
  import UserMenu from '#lib/auth/UserMenu.svelte';
  type Action =
    | { kind: 'add' }
    | { kind: 'remove'; key: PasskeySummary }
    | { kind: 'password' };
  const RECENT = 300000;
  const ACTION_TEXT = {
    add: 'add a passkey',
    remove: 'remove a passkey',
    password: 'change your password',
  } as const;
  let session = $state<AuthSession>();
  let keys = $state<readonly PasskeySummary[]>([]);
  let now = $state(Date.now());
  let lockedAt = $state('');
  let busy = $state(false);
  let message = $state('');
  let error = $state('');
  let adding = $state(false);
  let deviceName = $state('');
  let removing = $state('');
  let changing = $state(false);
  let password = $state('');
  let confirm = $state('');
  let pending = $state<Action>();
  let confirmWorking = $state(false);
  let dialog = $state<HTMLDialogElement>();
  let deviceInput = $state<HTMLInputElement>();
  const username = $derived(session?.user.username ?? '');
  const unlockedUntil = $derived(
    session ? Date.parse(session.authenticatedAt) + RECENT : 0,
  );
  const unlocked = $derived(
    !!session && session.authenticatedAt !== lockedAt && now < unlockedUntil,
  );
  const minutesLeft = $derived(
    Math.max(1, Math.ceil((unlockedUntil - now) / 60000)),
  );
  const signedInUntil = $derived.by(() => {
    if (!session) return '';
    const end = new Date(session.expiresAt);
    const time = end.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
    const day = (offset: number) => {
      const date = new Date(now);
      date.setDate(date.getDate() + offset);
      return date.toDateString();
    };
    if (end.toDateString() === day(0)) return `${time} today`;
    if (end.toDateString() === day(1)) return `${time} tomorrow`;
    return `${time} on ${end.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}`;
  });
  const added = (key: PasskeySummary) =>
    new Date(key.createdAt).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  async function refresh() {
    session = await currentSession();
    keys = await listPasskeys();
    now = Date.now();
  }
  onMount(() => {
    void refresh().catch((failure) => {
      error = failure.message;
    });
    // The countdown follows the server's authenticatedAt, not a local timer start.
    const clock = setInterval(() => (now = Date.now()), 15000);
    return () => clearInterval(clock);
  });
  async function run(work: () => Promise<void>, action?: Action) {
    if (busy) return;
    busy = true;
    error = '';
    message = '';
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    try {
      await work();
    } catch (failure) {
      // The server is the authority on recency; a skewed clock lands here.
      if (
        action &&
        failure instanceof AuthRequestError &&
        failure.status === 403
      )
        void ask(action);
      else error = (failure as Error).message;
    } finally {
      busy = false;
      release();
      releaseUpdates();
    }
  }
  async function begin(action: Action) {
    if (action.kind === 'add') {
      adding = true;
      deviceName = '';
      await tick();
      deviceInput?.focus();
    } else if (action.kind === 'remove') removing = action.key.id;
    else changing = true;
  }
  async function ask(action: Action) {
    pending = action;
    // Render the form first so the modal moves focus into it.
    await tick();
    if (!dialog?.open) dialog?.showModal();
  }
  function guarded(action: Action) {
    message = '';
    error = '';
    now = Date.now();
    if (unlocked) void begin(action);
    else void ask(action);
  }
  async function confirmed() {
    const action = pending;
    await refresh();
    lockedAt = '';
    dialog?.close();
    if (action) await begin(action);
  }
  function lock() {
    // There is no server-side lock: this only hides the unlock locally so the next
    // sensitive action asks again. The server still honours the recent sign-in.
    lockedAt = session?.authenticatedAt ?? '';
    adding = false;
    changing = false;
    removing = '';
    password = '';
    confirm = '';
  }
  function addPasskey() {
    const name = deviceName.trim();
    if (!name) return;
    return run(
      async () => {
        await registerPasskey(name);
        adding = false;
        await refresh();
        message = 'Passkey added.';
      },
      { kind: 'add' },
    );
  }
  function removePasskey(key: PasskeySummary) {
    return run(
      async () => {
        await authRequest('passkey/remove', { id: key.id });
        removing = '';
        await refresh();
        message = `Passkey “${key.name}” removed.`;
      },
      { kind: 'remove', key },
    );
  }
  function changePassword() {
    if (!passwordReady(password, confirm)) return;
    return run(
      async () => {
        await authRequest('password', { password });
        password = '';
        confirm = '';
        changing = false;
        await refresh();
        message =
          'Password changed. You’ve been signed out on your other devices.';
      },
      { kind: 'password' },
    );
  }
  function logout(all: boolean) {
    return run(async () => {
      await authRequest(all ? 'logout-all' : 'logout', {});
      window.location.replace(
        all ? '/login/?signed-out=everywhere' : '/login/',
      );
    });
  }
</script>

<svelte:head><title>Your account · Order Pad</title></svelte:head>
<div class="account-app">
  <header class="account-header">
    <span class="account-brand">
      <a href="/" aria-label="Order builder"
        ><img
          class="brand-logo"
          src="/logo.svg"
          alt="Fiona's Ice Cream"
          width="83"
          height="44"
        /></a
      >
      <nav class="account-nav" aria-label="Main">
        <a href="/">Order builder</a><a href="/queue/">Now Scooping</a>
      </nav>
    </span>
    {#if username}<UserMenu {username} />{/if}
  </header>
  <main class="account-main">
    <div class="account-inner">
      <div class="account-title">
        <h1>Your account</h1>
        {#if unlocked}<span class="unlock-pill" role="status"
            ><AuthIcon name="lock" size={16} /><span
              >Changes unlocked · {minutesLeft} min left</span
            ><button type="button" class="auth-text-button" onclick={lock}
              >Lock now</button
            ></span
          >{/if}
      </div>
      {#if error}<AuthBanner kind="error">{error}</AuthBanner>{/if}
      {#if message}<AuthBanner kind="success">{message}</AuthBanner>{/if}
      <div class="account-grid">
        <section class="account-card account-who" aria-label="Signed-in user">
          <span class="account-avatar" aria-hidden="true"
            >{username.charAt(0).toUpperCase()}</span
          >
          <span class="account-who-copy">
            <strong>{username}</strong>
            <span>Can take orders, print tickets and run the queue.</span>
          </span>
        </section>

        <section class="account-card account-keys" aria-labelledby="keys-title">
          <div class="account-card-head">
            <h2 id="keys-title">Passkeys</h2>
            {#if !adding}<button
                type="button"
                class="secondary small"
                disabled={busy}
                onclick={() => guarded({ kind: 'add' })}>Add a passkey</button
              >{/if}
          </div>
          <p class="auth-text">
            Sign in with your fingerprint, face or device PIN instead of typing
            your password.
          </p>
          {#if adding}
            <form
              class="account-inset auth-stack"
              onsubmit={(event) => {
                event.preventDefault();
                void addPasskey();
              }}
            >
              <div class="auth-field">
                <label for="account-device">Name this device</label>
                <input
                  id="account-device"
                  bind:this={deviceInput}
                  bind:value={deviceName}
                  maxlength="80"
                  placeholder="For example, {username}’s phone"
                />
              </div>
              <div class="auth-actions">
                <button
                  type="submit"
                  class="primary"
                  disabled={busy || !deviceName.trim()}
                  >{busy ? 'Adding…' : 'Continue'}</button
                >
                <button
                  type="button"
                  class="ghost"
                  disabled={busy}
                  onclick={() => (adding = false)}>Cancel</button
                >
              </div>
            </form>
          {/if}
          {#if session && !keys.length}
            <p class="account-empty">
              No passkeys yet. You sign in with your password.
            </p>
          {/if}
          <ul class="account-key-list">
            {#each keys as key (key.id)}
              <li>
                <div class="account-key">
                  <span class="account-key-icon" aria-hidden="true"
                    ><AuthIcon name="key" /></span
                  >
                  <span class="account-key-copy">
                    <strong>{key.name}</strong>
                    <span>Added {added(key)}</span>
                  </span>
                  {#if removing !== key.id}<button
                      type="button"
                      class="account-remove"
                      disabled={busy}
                      aria-label="Remove passkey {key.name}"
                      onclick={() => guarded({ kind: 'remove', key })}
                      >Remove</button
                    >{/if}
                </div>
                {#if removing === key.id}
                  <div
                    class="account-confirm-remove"
                    role="group"
                    aria-label="Remove passkey {key.name}"
                  >
                    <span
                      >Remove “{key.name}”? It won’t be able to sign you in any
                      more.</span
                    >
                    <div class="auth-actions">
                      <button
                        type="button"
                        class="danger"
                        disabled={busy}
                        onclick={() => void removePasskey(key)}
                        >Remove passkey</button
                      >
                      <button
                        type="button"
                        class="ghost danger-text"
                        disabled={busy}
                        onclick={() => (removing = '')}>Keep it</button
                      >
                    </div>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </section>

        <section class="account-card account-pass" aria-labelledby="pass-title">
          <div class="account-card-head">
            <h2 id="pass-title">Password</h2>
            {#if !changing}<button
                type="button"
                class="secondary small"
                disabled={busy}
                onclick={() => guarded({ kind: 'password' })}
                >Change password</button
              >{/if}
          </div>
          {#if changing}
            <form
              class="auth-stack"
              novalidate
              onsubmit={(event) => {
                event.preventDefault();
                void changePassword();
              }}
            >
              <NewPasswordFields
                idPrefix="account"
                bind:password
                bind:confirm
              />
              <div class="auth-actions">
                <button
                  type="submit"
                  class="primary"
                  disabled={busy || !passwordReady(password, confirm)}
                  >{busy ? 'Saving…' : 'Save new password'}</button
                >
                <button
                  type="button"
                  class="ghost"
                  disabled={busy}
                  onclick={() => {
                    changing = false;
                    password = '';
                    confirm = '';
                  }}>Cancel</button
                >
              </div>
            </form>
          {:else}
            <p class="auth-text">
              Changing it signs you out on your other devices.
            </p>
          {/if}
        </section>

        <section
          class="account-card account-sessions"
          aria-labelledby="sessions-title"
        >
          <h2 id="sessions-title">Signed in</h2>
          {#if signedInUntil}<p class="auth-text">
              You’ll stay signed in on this device until {signedInUntil}.
            </p>{/if}
          <div class="auth-actions">
            <button
              type="button"
              class="secondary"
              disabled={busy}
              onclick={() => void logout(false)}>Sign out</button
            >
            <button
              type="button"
              class="ghost"
              disabled={busy}
              onclick={() => void logout(true)}>Sign out everywhere</button
            >
          </div>
          <p class="auth-note muted">
            Use “Sign out everywhere” if you left yourself signed in on a shared
            tablet.
          </p>
        </section>

        <section class="account-admin" aria-labelledby="admin-title">
          <AuthIcon name="monitor" size={22} />
          <span>
            <strong id="admin-title">Adding staff or locked out?</strong>
            <span
              >New accounts, recovery codes and turning accounts off are handled
              on the station computer. Ask whoever runs it.</span
            >
          </span>
        </section>
      </div>
    </div>
  </main>
</div>

<dialog
  class="confirm-dialog"
  bind:this={dialog}
  aria-modal="true"
  aria-labelledby="confirm-title"
  oncancel={(event) => {
    // A confirmation in flight must finish; closing would drop its result.
    if (confirmWorking) event.preventDefault();
  }}
  onclose={() => (pending = undefined)}
>
  {#if pending && session}
    <div class="auth-stack">
      <div class="auth-heading">
        <h2 id="confirm-title">Confirm it’s you</h2>
        <p>
          To {ACTION_TEXT[pending.kind]}, confirm your identity. Changes stay
          unlocked for 5 minutes.
        </p>
      </div>
      <LoginForm
        reauthenticate
        username={session.user.username}
        bind:working={confirmWorking}
        done={confirmed}
        cancel={() => dialog?.close()}
      />
    </div>
  {/if}
</dialog>
