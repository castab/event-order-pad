<script lang="ts">
  import designTokens from '../../design/tokens/tokens.css?raw';
  import '$lib/builder.css';
  // The supplied logo is outlined artwork; omit unused script font declarations.
  const tokenCss = designTokens.replace(/@font-face\s*\{[^}]*\}/g, '');
  let { children } = $props();
</script>

<svelte:head>{@html `<style>${tokenCss}</style>`}</svelte:head>
{@render children()}
