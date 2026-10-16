<script lang="ts">
  import { onMount } from 'svelte';
  import LoginForm from '#lib/auth/LoginForm.svelte';
  import AuthBanner from '#lib/auth/AuthBanner.svelte';
  let signedOutEverywhere = $state(false);
  onMount(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get('signed-out') === 'everywhere') {
      signedOutEverywhere = true;
      history.replaceState(null, '', url.pathname);
    }
  });
</script>

<svelte:head><title>Sign in · Order Pad</title></svelte:head>
<div class="auth-page signin">
  <div class="signin-brand">
    <img src="/logo.svg" alt="Fiona's Ice Cream" width="113" height="60" />
    <span class="auth-product">Order Pad</span>
    <p class="signin-line">
      Take orders, print prep tickets and keep the scoop line moving.
    </p>
  </div>
  <main class="signin-form">
    <div class="auth-column auth-stack">
      <div class="auth-heading">
        <h1>Sign in</h1>
        <p>For Fiona’s staff. Use the account set up for you on the station.</p>
      </div>
      {#if signedOutEverywhere}<AuthBanner kind="success"
          >Signed out everywhere, including this device.</AuthBanner
        >{/if}
      <LoginForm />
      <div class="signin-footer">
        <p>First time here? <a href="/enroll/">Set up your account</a></p>
        <p>Locked out? <a href="/recover/">Use a recovery code</a></p>
        <p class="auth-note muted">
          Codes come from whoever runs the station computer.
        </p>
      </div>
    </div>
  </main>
</div>
