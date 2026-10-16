<script lang="ts">
  import RedeemForm from '#lib/auth/RedeemForm.svelte';
</script>

<svelte:head><title>Recover account · Order Pad</title></svelte:head>
<main class="auth-card">
  <h1>Recover your account</h1>
  <p>
    Recovery replaces your password and removes previous passkeys. You can add
    passkeys again after signing in.
  </p>
  <RedeemForm kind="recover" /><a href="/login/">Back to sign in</a>
</main>
