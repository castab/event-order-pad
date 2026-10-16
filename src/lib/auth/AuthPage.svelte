<script lang="ts">
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
</script>

<div class="auth-page compact">
  <header class="auth-header">
    <img src="/logo.svg" alt="Fiona's Ice Cream" width="64" height="34" />
    <span class="auth-product">Order Pad</span>
  </header>
  <main class="auth-content">
    <div class="auth-column wide auth-stack">{@render children()}</div>
  </main>
</div>
