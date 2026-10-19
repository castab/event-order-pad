<script lang="ts">
  import AuthIcon from './AuthIcon.svelte';
  import { authRequest } from './client';
  import { hasActivity } from './activity';
  let { expiresAt }: { expiresAt: string } = $props();
  const until = $derived(
    new Date(expiresAt).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    }),
  );
  let open = $state(false);
  let signingOut = $state(false);
  let error = $state('');
  let root = $state<HTMLElement>();
  let trigger = $state<HTMLButtonElement>();
  let menu = $state<HTMLElement>();
  const items = () =>
    Array.from(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  function close(focus = false) {
    open = false;
    if (focus) trigger?.focus();
  }
  $effect(() => {
    if (!open) return;
    items()[0]?.focus();
    const outside = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  });
  function navigate(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close();
  }
  const settled = async () => {
    while (hasActivity())
      await new Promise((resolve) => setTimeout(resolve, 200));
  };
  async function signOut() {
    if (signingOut) return;
    signingOut = true;
    error = '';
    try {
      // Revoking the session under an in-flight save or print would strand its result.
      await settled();
      await authRequest('logout', {});
      await settled();
      window.location.replace('/login/');
    } catch (failure) {
      signingOut = false;
      error = (failure as Error).message;
    }
  }
</script>

<div class="access-menu" bind:this={root}>
  <button
    type="button"
    class="access-menu-trigger"
    bind:this={trigger}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? 'access-menu-list' : undefined}
    aria-label={`Access until ${until}`}
    onclick={() => (open ? close() : (open = true))}
    onkeydown={(event) => {
      if (event.key === 'ArrowDown' && !open) {
        event.preventDefault();
        open = true;
      }
    }}
  >
    <span class="access-icon" aria-hidden="true"
      ><AuthIcon name="lock" size={18} /></span
    ><span class="access-until">Until {until}</span><AuthIcon
      name="chevron"
      size={16}
    />
  </button>
  {#if open}
    <div
      id="access-menu-list"
      class="access-menu-list"
      role="menu"
      aria-label="Shift access"
      tabindex="-1"
      bind:this={menu}
      onkeydown={navigate}
    >
      <p class="access-menu-note">
        This device is signed in until {until}. Signing out uses up its code, so
        you’ll need a new one to sign back in.
      </p>
      <button
        type="button"
        role="menuitem"
        disabled={signingOut}
        onclick={() => void signOut()}
        >{signingOut ? 'Signing out…' : 'Sign out this device'}</button
      >
      {#if error}<p class="access-menu-error" role="alert">{error}</p>{/if}
    </div>
  {/if}
</div>
