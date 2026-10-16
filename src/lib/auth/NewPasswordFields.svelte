<script lang="ts">
  import PasswordField from './PasswordField.svelte';
  import { PASSWORD_MAX, PASSWORD_MIN, passwordLength } from './model';
  let {
    idPrefix,
    password = $bindable(''),
    confirm = $bindable(''),
  }: { idPrefix: string; password?: string; confirm?: string } = $props();
  let visible = $state(false);
  const length = $derived(passwordLength(password));
  const enough = $derived(length >= PASSWORD_MIN && length <= PASSWORD_MAX);
  const count = $derived(
    length === 0
      ? `At least ${PASSWORD_MIN} characters.`
      : length > PASSWORD_MAX
        ? `That’s ${length} characters. Use ${PASSWORD_MAX} or fewer.`
        : enough
          ? '✓ Long enough.'
          : `${length} of ${PASSWORD_MIN} characters. ${PASSWORD_MIN - length} more to go.`,
  );
  const mismatch = $derived(confirm.length > 0 && confirm !== password);
</script>

<PasswordField
  id="{idPrefix}-password"
  label="New password"
  bind:value={password}
  bind:visible
  autocomplete="new-password"
  invalid={length > PASSWORD_MAX}
  describedby="{idPrefix}-count {idPrefix}-hint"
>
  <div class="auth-meter" aria-hidden="true">
    <div
      class:enough
      style:width="{Math.min(100, Math.round((length / PASSWORD_MIN) * 100))}%"
    ></div>
  </div>
  <span
    id="{idPrefix}-count"
    class="auth-note"
    class:done={enough}
    class:error={length > PASSWORD_MAX}
    aria-live="polite">{count}</span
  >
  <span id="{idPrefix}-hint" class="auth-note muted"
    >A short phrase works well, like “mint chip on a waffle cone”. Spaces are
    fine.</span
  >
</PasswordField>
<div class="auth-field">
  <label for="{idPrefix}-confirm">Type it again</label>
  <input
    id="{idPrefix}-confirm"
    type={visible ? 'text' : 'password'}
    bind:value={confirm}
    autocomplete="new-password"
    maxlength="256"
    autocapitalize="none"
    spellcheck="false"
    aria-invalid={mismatch}
    aria-describedby="{idPrefix}-match"
  />
  <span id="{idPrefix}-match" class="auth-note error" aria-live="polite"
    >{mismatch ? 'The two passwords don’t match yet.' : ''}</span
  >
</div>
