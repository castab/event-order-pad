<script lang="ts">
  type Name =
    | 'key'
    | 'eye'
    | 'eye-off'
    | 'alert'
    | 'check'
    | 'warning'
    | 'lock'
    | 'chevron'
    | 'monitor';
  let { name, size = 20 }: { name: Name; size?: number } = $props();
</script>

<svg
  aria-hidden="true"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={name === 'check'
    ? 2.25
    : name === 'key' || name.startsWith('eye')
      ? 1.75
      : 2}
  stroke-linecap="round"
  stroke-linejoin="round"
>
  {#if name === 'key'}<path
      d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"
    /><circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
  {:else if name === 'eye'}<path
      d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
    /><circle cx="12" cy="12" r="3" />
  {:else if name === 'eye-off'}<path
      d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143M2 2l20 20"
    />
  {:else if name === 'alert'}<circle cx="12" cy="12" r="10" /><path
      d="M12 8v4M12 16h.01"
    />
  {:else if name === 'check'}<path d="M20 6 9 17l-5-5" />
  {:else if name === 'warning'}<path
      d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"
    /><path d="M12 9v4M12 17h.01" />
  {:else if name === 'lock'}<rect
      width="18"
      height="11"
      x="3"
      y="11"
      rx="2"
    /><path d="M7 11V7a5 5 0 0 1 9.9-1" />
  {:else if name === 'chevron'}<path d="m6 9 6 6 6-6" />
  {:else}<rect width="20" height="14" x="2" y="3" rx="2" /><path
      d="M8 21h8M12 17v4"
    />
  {/if}
</svg>
