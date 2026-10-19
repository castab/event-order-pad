<script lang="ts">
  import LoginForm from '#lib/auth/LoginForm.svelte';
  import AuthIcon from '#lib/auth/AuthIcon.svelte';
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
        <p>For Fiona’s staff. Enter this device’s access code.</p>
      </div>
      <LoginForm />
      <section class="code-help" aria-labelledby="code-help-title">
        <AuthIcon name="printer" size={22} />
        <div>
          <h2 id="code-help-title">Where’s the code?</h2>
          <p>
            It’s on a slip printed at the station. Each code works once, on one
            device, within an hour of printing.
          </p>
          <p class="muted">
            No code, or it stopped working? Whoever runs the station can mint
            you a new one.
          </p>
        </div>
      </section>
    </div>
  </main>
</div>
