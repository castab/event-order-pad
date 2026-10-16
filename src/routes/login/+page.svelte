<script lang="ts">
  import LoginForm from '#lib/auth/LoginForm.svelte';
</script>

<svelte:head><title>Sign in · Order Pad</title></svelte:head>
<main class="auth-card">
  <h1>Sign in to Order Pad</h1>
  <LoginForm />
  <p>
    Need an account or lost access? Ask the person who manages this station for
    an enrollment or recovery code.
  </p>
  <a href="/enroll/">Use an enrollment code</a><a href="/recover/"
    >Recover an account</a
  >
</main>
