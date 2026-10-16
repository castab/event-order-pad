<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Turnstile from './Turnstile.svelte';
  import AuthBanner from './AuthBanner.svelte';
  import AuthIcon from './AuthIcon.svelte';
  import NewPasswordFields from './NewPasswordFields.svelte';
  import { authRequest } from './client';
  import { passwordReady } from './model';
  import { defaultDeviceName, registerPasskey } from './passkeys';
  import { holdActivity } from './activity';
  import { holdUpdates } from '../app-update';
  let { kind }: { kind: 'enroll' | 'recover' } = $props();
  // The service sends one message for unknown, used and expired codes.
  const INVALID_CODE =
    'This enrollment or recovery link is invalid or expired.';
  const copy = $derived(
    kind === 'enroll'
      ? {
          title: 'Set up your account',
          intro: 'Choose the password you’ll sign in with.',
          code: 'Invite code',
          submit: 'Create account',
          lifetime: 'Invite codes last 24 hours.',
          ready: 'Your account is ready',
        }
      : {
          title: 'Recover your account',
          intro: 'Choose a new password to get back in.',
          code: 'Recovery code',
          submit: 'Set new password',
          lifetime: 'Recovery codes last 30 minutes.',
          ready: 'You’re back in',
        },
  );
  let code = $state('');
  let fromLink = $state(false);
  let password = $state('');
  let confirm = $state('');
  let token = $state('');
  let generation = $state(0);
  let turnstile = $state<ReturnType<typeof Turnstile>>();
  let busy = $state(false);
  let checking = $state(false);
  let error = $state('');
  let step = $state<'form' | 'passkey' | 'done'>('form');
  let deviceName = $state('');
  let addedPasskey = $state(false);
  let codeInput = $state<HTMLInputElement>();
  let heading = $state<HTMLHeadingElement>();
  const canSubmit = $derived(!!code.trim() && passwordReady(password, confirm));
  onMount(() => {
    code = window.location.hash.slice(1);
    fromLink = !!code;
    history.replaceState(null, '', window.location.pathname);
  });
  async function enterCode() {
    fromLink = false;
    code = '';
    await tick();
    codeInput?.focus();
  }
  async function hold(work: () => Promise<void>) {
    busy = true;
    error = '';
    const release = holdActivity();
    const releaseUpdates = holdUpdates();
    try {
      await work();
    } catch (failure) {
      error = (failure as Error).message;
    } finally {
      busy = false;
      checking = false;
      release();
      releaseUpdates();
    }
  }
  async function showStep(next: 'passkey' | 'done') {
    step = next;
    await tick();
    heading?.focus();
  }
  function redeem() {
    if (busy || !canSubmit) return;
    let submitted = false;
    return hold(async () => {
      try {
        checking = true;
        const verified = token || (await turnstile!.waitForToken());
        checking = false;
        submitted = true;
        await authRequest(kind, {
          token: code.trim(),
          password,
          turnstile: verified,
        });
      } catch (failure) {
        const message = (failure as Error).message;
        throw new Error(
          message === INVALID_CODE
            ? `${message} Ask whoever runs the station for a new one. ${copy.lifetime}`
            : message,
        );
      } finally {
        if (submitted) generation++;
      }
      password = '';
      confirm = '';
      deviceName = defaultDeviceName();
      await showStep('passkey');
    });
  }
  async function finish(added: boolean) {
    addedPasskey = added;
    await showStep('done');
    setTimeout(() => window.location.replace('/'), 900);
  }
  function addPasskey() {
    if (busy) return;
    return hold(async () => {
      if (!deviceName.trim()) throw new Error('Give this device a name.');
      await registerPasskey(deviceName.trim());
      await finish(true);
    });
  }
</script>

{#if step === 'form'}
  <div class="auth-heading">
    <h1>{copy.title}</h1>
    <p>{copy.intro}</p>
  </div>
  {#if error}<AuthBanner kind="error">{error}</AuthBanner>{/if}
  {#if kind === 'recover'}
    <div class="auth-warning">
      <AuthIcon name="warning" />
      <span
        ><strong
          >This replaces your password and removes your saved passkeys.</strong
        > You can add a passkey again right after.</span
      >
    </div>
  {/if}
  <form
    class="auth-stack"
    novalidate
    onsubmit={(event) => {
      event.preventDefault();
      void redeem();
    }}
  >
    {#if fromLink}
      <div class="auth-code-row">
        <AuthIcon name="check" />
        <span>{copy.code} added from your link</span>
        <button type="button" class="auth-text-button" onclick={enterCode}
          >Enter a code instead</button
        >
      </div>
    {:else}
      <div class="auth-field">
        <label for="redeem-code">{copy.code}</label>
        <input
          id="redeem-code"
          class="auth-mono"
          bind:this={codeInput}
          bind:value={code}
          autocomplete="off"
          autocapitalize="none"
          spellcheck="false"
          aria-describedby="redeem-code-hint"
        />
        <span id="redeem-code-hint" class="auth-note muted"
          >Paste the code from the link you were sent.</span
        >
      </div>
    {/if}
    <p class="auth-text">
      Your username was set when this code was made. You’ll use it with this
      password to sign in.
    </p>
    <NewPasswordFields idPrefix="redeem" bind:password bind:confirm />
    <Turnstile
      bind:this={turnstile}
      action={kind}
      bind:token
      {generation}
      onerror={(message) => (error = message)}
    />
    <button
      type="submit"
      class="primary auth-wide auth-large"
      disabled={busy || !canSubmit}
      >{checking ? 'Checking…' : busy ? 'Saving…' : copy.submit}</button
    >
  </form>
  <a class="auth-back" href="/login/">Back to sign in</a>
{:else if step === 'passkey'}
  <div class="auth-heading">
    <span class="auth-badge"><AuthIcon name="check" size={28} /></span>
    <h1 bind:this={heading} tabindex="-1">{copy.ready}</h1>
    <p>You’re signed in on this device.</p>
  </div>
  {#if error}<AuthBanner kind="error">{error}</AuthBanner>{/if}
  <section class="auth-panel auth-stack" aria-labelledby="passkey-offer">
    <h2 id="passkey-offer">Sign in with one tap next time</h2>
    <p class="auth-text">
      Add a passkey and this device will sign you in with your fingerprint, face
      or PIN. No password to type at the trailer window.
    </p>
    <div class="auth-field">
      <label for="redeem-device">Name this device</label>
      <input
        id="redeem-device"
        bind:value={deviceName}
        maxlength="80"
        aria-describedby="redeem-device-hint"
      />
      <span id="redeem-device-hint" class="auth-note muted"
        >So you can tell your passkeys apart later.</span
      >
    </div>
    <button
      type="button"
      class="primary auth-wide auth-large"
      disabled={busy}
      onclick={() => void addPasskey()}
      >{busy ? 'Adding…' : 'Add a passkey'}</button
    >
    <button
      type="button"
      class="ghost auth-wide"
      disabled={busy}
      onclick={() => void finish(false)}>Skip for now</button
    >
  </section>
{:else}
  <div class="auth-done" role="status">
    <span class="auth-badge large"><AuthIcon name="check" size={36} /></span>
    <h1 bind:this={heading} tabindex="-1">
      {addedPasskey ? 'Passkey added' : 'All set'}
    </h1>
    <p>Opening the order builder…</p>
  </div>
{/if}
