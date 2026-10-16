<script lang="ts">
  import AuthPage from '#lib/auth/AuthPage.svelte';
  import RedeemForm from '#lib/auth/RedeemForm.svelte';
</script>

<svelte:head><title>Set up your account · Order Pad</title></svelte:head>
<AuthPage><RedeemForm kind="enroll" /></AuthPage>
