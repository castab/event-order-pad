<script lang="ts">
  import type { Snippet } from 'svelte';
  import AuthIcon from './AuthIcon.svelte';
  let {
    id,
    label,
    value = $bindable(''),
    visible = $bindable(false),
    autocomplete,
    invalid = false,
    capsLock = false,
    describedby,
    children,
  }: {
    id: string;
    label: string;
    value?: string;
    visible?: boolean;
    autocomplete: 'current-password' | 'new-password';
    invalid?: boolean;
    capsLock?: boolean;
    describedby?: string;
    children?: Snippet;
  } = $props();
  let caps = $state(false);
  const watchCaps = (event: KeyboardEvent) => {
    if (capsLock && event.getModifierState)
      caps = event.getModifierState('CapsLock');
  };
</script>

<div class="auth-field">
  <label for={id}>{label}</label>
  <div class="auth-password">
    <input
      {id}
      type={visible ? 'text' : 'password'}
      bind:value
      {autocomplete}
      maxlength="256"
      autocapitalize="none"
      spellcheck="false"
      aria-invalid={invalid}
      aria-describedby={describedby}
      onkeydown={watchCaps}
      onkeyup={watchCaps}
    />
    <button
      type="button"
      class="auth-reveal"
      aria-pressed={visible}
      aria-label={visible ? 'Hide password' : 'Show password'}
      onclick={() => (visible = !visible)}
      ><AuthIcon name={visible ? 'eye-off' : 'eye'} /></button
    >
  </div>
  {#if capsLock && caps}<span class="auth-note error">Caps Lock is on.</span
    >{/if}
  {@render children?.()}
</div>
