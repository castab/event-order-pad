<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchOrders, changeOrderStatus } from '$lib/orders/client';
  import {
    sortOrders,
    waitMinutes,
    waitLabel,
    waitTone,
    type QueueOrder,
  } from '$lib/orders/order';
  import { totalScoops } from '$lib/tickets/ticket';

  let orders = $state<readonly QueueOrder[]>([]);
  let now = $state(Date.now());
  let loaded = $state(false);
  let checking = $state(false);
  let connectionError = $state('');
  let actionError = $state('');
  const error = $derived(actionError || connectionError);
  let lastUpdated = $state<string>();
  let pending = $state(new Set<string>());
  let generation = 0;
  let stopped = false;
  let controller: AbortController | undefined;
  const open = $derived(sortOrders(orders, 'open'));
  const done = $derived(sortOrders(orders, 'done').slice(0, 8));
  const servingCount = $derived(
    open.reduce((n, o) => n + o.ticket.servings.length, 0),
  );
  const oldest = $derived(open.length ? waitMinutes(open[0], now) : 0);
  const clock = (date: string) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(date));
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? '' : 's'}`;

  async function refresh() {
    if (checking || pending.size || stopped) return;
    checking = true;
    const revision = ++generation;
    controller = new AbortController();
    try {
      const snapshot = await fetchOrders(
        AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      );
      if (stopped || revision !== generation) return;
      orders = snapshot;
      loaded = true;
      now = Date.now();
      lastUpdated = new Date(now).toISOString();
      connectionError = '';
    } catch (failure) {
      if (!stopped && revision === generation)
        connectionError = (failure as Error).message;
    } finally {
      if (!stopped) checking = false;
    }
  }
  async function update(id: string, action: 'done' | 'reopen') {
    if (pending.has(id) || stopped) return;
    pending = new Set([...pending, id]);
    ++generation; // An older polling response cannot undo this action on screen.
    try {
      const order = await changeOrderStatus(id, action);
      if (stopped) return;
      orders = [...orders.filter((o) => o.ticket.id !== id), order];
      actionError = '';
      now = Date.now();
    } catch (failure) {
      if (!stopped) actionError = (failure as Error).message;
    } finally {
      if (!stopped) {
        pending = new Set([...pending].filter((value) => value !== id));
        void refresh();
      }
    }
  }
  onMount(() => {
    stopped = false;
    void refresh();
    const polling = setInterval(() => void refresh(), 3000);
    const ages = setInterval(() => {
      now = Date.now();
    }, 30000);
    window.addEventListener('online', refresh);
    return () => {
      stopped = true;
      clearInterval(polling);
      clearInterval(ages);
      controller?.abort();
      window.removeEventListener('online', refresh);
    };
  });
</script>

<svelte:head
  ><title>Build queue · Order Pad</title><meta
    name="description"
    content="Track open ice cream orders and mark completed orders done."
  /></svelte:head
>

<div class="queue-app">
  <header class="queue-header">
    <div class="queue-brand">
      <a href="/" aria-label="Order builder"
        ><img src="/icon.svg" alt="Order Pad" width="36" height="36" /></a
      ><span class="header-rule" aria-hidden="true"></span>
      <h1>Build queue</h1>
    </div>
    <dl class="queue-metrics" aria-label="Queue totals">
      <div>
        <dd>{loaded ? open.length : '—'}</dd>
        <dt>open</dt>
      </div>
      <div>
        <dd>{loaded ? servingCount : '—'}</dd>
        <dt>servings to build</dt>
      </div>
      <div>
        <dd>{open.length ? (oldest < 1 ? '<1m' : `${oldest}m`) : '—'}</dd>
        <dt>oldest wait</dt>
      </div>
    </dl>
  </header>
  <main class="queue-content">
    {#if error}<div class="queue-error" role="alert">
        <div>
          <strong>Queue needs attention</strong>
          <p>{error}</p>
          {#if lastUpdated}<p>
              Showing the last available orders · updated {clock(lastUpdated)}
            </p>{/if}
        </div>
        <button
          class="secondary"
          onclick={() => {
            actionError = '';
            void refresh();
          }}
          disabled={checking || !!pending.size}>Refresh queue</button
        >
      </div>{/if}
    {#if !loaded && !error}<p class="queue-loading" role="status">
        Loading build queue…
      </p>{/if}
    {#if loaded && !open.length}<div class="queue-empty">
        <h2>All caught up</h2>
        <p>New orders show up here the moment they print.</p>
      </div>{/if}
    <div class="queue-grid" aria-label="Open orders">
      {#each open as order (order.ticket.id)}
        {@const ticket = order.ticket}
        {@const age = waitMinutes(order, now)}
        <article
          class="queue-card"
          aria-label={`Order #${ticket.reference} · ${ticket.displayName}`}
        >
          <header>
            <div class="order-identity">
              <h2>#{ticket.reference}</h2>
              <p>{ticket.displayName}</p>
            </div>
            <div class="order-wait">
              <span
                class="wait-badge"
                class:moss={waitTone(age) === 'moss'}
                class:olive={waitTone(age) === 'olive'}
                class:rust={waitTone(age) === 'rust'}
                aria-label={`Wait ${waitLabel(age)}`}>{waitLabel(age)}</span
              ><time datetime={order.submittedAt}
                >{clock(order.submittedAt)}</time
              >
            </div>
          </header>
          <ol class="queue-servings">
            {#each ticket.servings as serving, index}<li>
                <span class="queue-serving-number">{index + 1}</span>
                <div>
                  <strong
                    >{plural(totalScoops(serving), 'scoop')} · {serving.container}</strong
                  >
                  <p class="flavor-mix">
                    {serving.flavors
                      .map((portion) => `${portion.count}× ${portion.flavor}`)
                      .join(', ')}
                  </p>
                  <p class="serving-toppings">
                    {serving.toppings.join(', ') || 'No toppings'}
                  </p>
                </div>
              </li>{/each}
          </ol>
          <div class="done-action">
            <button
              class="primary"
              onclick={() => update(ticket.id, 'done')}
              disabled={pending.has(ticket.id)}
              aria-busy={pending.has(ticket.id)}
              >Mark #{ticket.reference} done</button
            >
          </div>
        </article>
      {/each}
    </div>
  </main>
  {#if done.length}<section class="recently-done" aria-labelledby="done-title">
      <h2 id="done-title">Recently done</h2>
      {#each done as order (order.ticket.id)}<div class="done-chip">
          <strong>#{order.ticket.reference}</strong><span
            >{order.ticket.displayName} · done
            <time datetime={order.doneAt}>{clock(order.doneAt!)}</time></span
          ><button
            aria-label={`Undo done for #${order.ticket.reference}`}
            onclick={() => update(order.ticket.id, 'reopen')}
            disabled={pending.has(order.ticket.id)}
            aria-busy={pending.has(order.ticket.id)}>Undo</button
          >
        </div>{/each}
    </section>{/if}
</div>

<style>
  .queue-app {
    height: 100vh;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .queue-header {
    min-height: 72px;
    flex-shrink: 0;
    padding: 0 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    background: var(--surface-inverse);
    color: var(--text-on-inverse);
  }
  .queue-brand {
    display: flex;
    align-items: center;
    gap: 20px;
  }
  .queue-brand a {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
  }
  .queue-brand img {
    border-radius: 8px;
  }
  .header-rule {
    width: 1px;
    height: 28px;
    background: rgba(237, 229, 211, 0.3);
  }
  h1 {
    margin: 0;
    color: var(--cream-200);
    font-size: 15px;
    font-weight: 600;
    line-height: 1;
    letter-spacing: 0.26em;
    text-transform: uppercase;
  }
  .queue-metrics {
    display: flex;
    align-items: center;
    gap: 28px;
    margin: 0;
  }
  .queue-metrics > div {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .queue-metrics dd {
    margin: 0;
    color: var(--cream-100);
    font-size: 28px;
    font-weight: 700;
    line-height: 1;
  }
  .queue-metrics dt {
    color: var(--olive-100);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    line-height: 1.4;
  }
  .queue-content {
    min-height: 0;
    flex: 1;
    overflow-y: auto;
    padding: 24px 28px;
  }
  .queue-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
    align-items: start;
  }
  .queue-card {
    border-radius: var(--radius-card);
    background: var(--surface-card);
    box-shadow: var(--shadow-card);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .queue-card header {
    padding: 16px 18px 12px;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  .order-identity {
    min-width: 0;
  }
  .order-identity h2 {
    margin: 0;
    font-size: 34px;
    line-height: 1;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-heading);
    overflow-wrap: anywhere;
  }
  .order-identity p {
    margin: 2px 0 0;
    font-size: 16px;
    font-weight: 600;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .order-wait {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 6px;
    flex-shrink: 0;
  }
  .wait-badge {
    padding: 6px 10px;
    border-radius: var(--radius-pill);
    color: var(--cream-100);
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
  }
  .moss {
    background: var(--moss-600);
  }
  .olive {
    background: var(--olive-700);
  }
  .rust {
    background: var(--rust-600);
  }
  .order-wait time {
    font-size: 13px;
    line-height: 1;
    color: var(--text-muted);
  }
  .queue-servings {
    margin: 0;
    padding: 4px 18px;
    list-style: none;
    display: flex;
    flex-direction: column;
  }
  .queue-servings li {
    padding: 10px 0;
    display: flex;
    gap: 12px;
    border-bottom: 1px dashed var(--border-soft);
  }
  .queue-serving-number {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    border-radius: 50%;
    background: var(--olive-700);
    color: var(--cream-100);
    font-size: 12px;
    font-weight: 700;
    display: grid;
    place-items: center;
  }
  .queue-servings li > div {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .queue-servings strong {
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    color: var(--text-heading);
  }
  .queue-servings p {
    margin: 2px 0 0;
    line-height: 1.45;
  }
  .flavor-mix {
    font-size: 14px;
  }
  .serving-toppings {
    font-size: 13px;
    color: var(--text-muted);
  }
  .done-action {
    padding: 12px 18px 16px;
  }
  .done-action button {
    width: 100%;
  }
  .recently-done {
    flex-shrink: 0;
    min-height: 68px;
    padding: 10px 28px max(10px, env(safe-area-inset-bottom));
    display: flex;
    align-items: center;
    gap: 14px;
    background: var(--paper-200);
    border-top: 1px solid var(--border-soft);
    overflow-x: auto;
  }
  .recently-done h2 {
    margin: 0;
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: 0.26em;
    text-transform: uppercase;
  }
  .done-chip {
    flex-shrink: 0;
    min-height: 44px;
    padding: 0 6px 0 16px;
    border-radius: var(--radius-pill);
    background: var(--cream-100);
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
  }
  .done-chip strong {
    color: var(--text-heading);
    font-weight: 600;
  }
  .done-chip button {
    min-width: 44px;
    min-height: 44px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--brand-strong);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .queue-empty {
    min-height: 420px;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;
  }
  .queue-empty h2 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    line-height: 1.25;
    color: var(--text-heading);
    letter-spacing: -0.015em;
  }
  .queue-empty p {
    margin: 0;
    font-size: 16px;
    line-height: 1.6;
    color: var(--text-muted);
  }
  .queue-error {
    padding: 16px;
    border: 1.5px solid var(--rust-600);
    border-radius: var(--radius-card);
    background: var(--surface-card);
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    font-size: 14px;
  }
  .queue-error strong {
    color: var(--rust-600);
  }
  .queue-error p {
    margin: 4px 0 0;
  }
  .queue-loading {
    color: var(--text-muted);
  }
  @media (max-width: 1050px) {
    .queue-header {
      flex-wrap: wrap;
      padding: 14px 20px;
      gap: 16px;
    }
    .queue-metrics {
      flex-wrap: wrap;
      gap: 20px;
    }
    .queue-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 600px) {
    .queue-header {
      padding: 12px 16px;
    }
    .queue-brand {
      gap: 12px;
    }
    .queue-metrics {
      width: 100%;
      gap: 12px;
      justify-content: space-between;
    }
    .queue-metrics > div {
      flex-direction: column;
      gap: 4px;
    }
    .queue-metrics dt {
      font-size: 9px;
      letter-spacing: 0.1em;
    }
    .queue-content {
      padding: 16px;
    }
    .queue-grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .recently-done {
      padding-left: 16px;
      padding-right: 16px;
    }
    .queue-error {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
