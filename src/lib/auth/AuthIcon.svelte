<script lang="ts">
  type Name = 'alert' | 'check' | 'lock' | 'chevron' | 'printer';
  let { name, size = 20 }: { name: Name; size?: number } = $props();
</script>

<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={name === 'check' ? 2.25 : name === 'printer' ? 1.75 : 2}
  stroke-linecap="round"
  stroke-linejoin="round"
>
  {#if name === 'alert'}<circle cx="12" cy="12" r="10" /><path
      d="M12 8v4M12 16h.01"
    />
  {:else if name === 'check'}<path d="M20 6 9 17l-5-5" />
  {:else if name === 'lock'}<rect
      width="18"
      height="11"
      x="3"
      y="11"
      rx="2"
    /><path d="M7 11V7a5 5 0 0 1 9.9-1" />
  {:else if name === 'chevron'}<path d="m6 9 6 6 6-6" />
  {:else}<path d="M6 9V3h12v6" /><path
      d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"
    /><path d="M6 14h12v7H6z" />
  {/if}
</svg>
