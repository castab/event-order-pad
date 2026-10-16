<script lang="ts">
  import type { Snippet } from 'svelte';
  import AuthIcon from './AuthIcon.svelte';
  let { kind, children }: { kind: 'error' | 'success'; children: Snippet } =
    $props();
</script>

<div class="auth-banner {kind}" role={kind === 'error' ? 'alert' : 'status'}>
  <AuthIcon name={kind === 'error' ? 'alert' : 'check'} />
  <span>{@render children()}</span>
</div>
