<script lang="ts">
  import AuthIcon from './AuthIcon.svelte';
  import { authRequest } from './client';
  import { hasActivity } from './activity';
  let { username }: { username: string } = $props();
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
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === 'ArrowDown'
        ? (index + 1) % list.length
        : event.key === 'ArrowUp'
          ? (index - 1 + list.length) % list.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? list.length - 1
              : -1;
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') close();
    else if (next >= 0) {
      event.preventDefault();
      list[next]?.focus();
    }
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

<div class="user-menu" bind:this={root}>
  <button
    type="button"
    class="user-menu-trigger"
    bind:this={trigger}
    aria-haspopup="menu"
    aria-expanded={open}
    aria-controls={open ? 'user-menu-list' : undefined}
    onclick={() => (open ? close() : (open = true))}
    onkeydown={(event) => {
      if (event.key === 'ArrowDown' && !open) {
        event.preventDefault();
        open = true;
      }
    }}
  >
    <span class="user-avatar" aria-hidden="true"
      >{username.charAt(0).toUpperCase()}</span
    ><span class="user-name">{username}</span><AuthIcon
      name="chevron"
      size={16}
    />
  </button>
  {#if open}
    <div
      id="user-menu-list"
      class="user-menu-list"
      role="menu"
      aria-label={username}
      tabindex="-1"
      bind:this={menu}
      onkeydown={navigate}
    >
      <a role="menuitem" href="/account/" onclick={() => close()}
        >Your account</a
      >
      <button
        type="button"
        role="menuitem"
        disabled={signingOut}
        onclick={() => void signOut()}
        >{signingOut ? 'Signing out…' : 'Sign out'}</button
      >
      {#if error}<p class="user-menu-error" role="alert">{error}</p>{/if}
    </div>
  {/if}
</div>
