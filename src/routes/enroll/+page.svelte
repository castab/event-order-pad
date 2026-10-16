<script lang="ts">
  import RedeemForm from '#lib/auth/RedeemForm.svelte';
</script>

<svelte:head><title>Create account · Order Pad</title></svelte:head>
<main class="auth-card">
  <h1>Create your account</h1>
  <RedeemForm kind="enroll" /><a href="/login/">Back to sign in</a>
</main>
