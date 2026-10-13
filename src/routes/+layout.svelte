<script lang="ts">
  import designTokens from '../../design/tokens/tokens.css?raw';
  import '#lib/builder.css';
  import { onMount } from 'svelte';
  import { startAppUpdates } from '#lib/app-update.js';
  // The supplied logo is outlined artwork; omit unused script font declarations.
  const tokenCss = designTokens.replace(/@font-face\s*\{[^}]*\}/g, '');
  let { children } = $props();
  onMount(startAppUpdates);
</script>

<svelte:head>{@html `<style>${tokenCss}</style>`}</svelte:head>
{@render children()}
