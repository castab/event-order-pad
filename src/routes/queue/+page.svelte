<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { changeOrderStatus } from '#lib/orders/client.js';
  import { columnCount, packColumns } from '#lib/orders/pack.js';
  import {
    sortOrders,
    waitMinutes,
    waitLabel,
    waitTone,
    type QueueOrder,
  } from '#lib/orders/order.js';
  import { fetchTrackingEnabled } from '#lib/orders/features.js';
  import { QueueFeed } from '#lib/orders/stream.js';
  import { totalScoops } from '#lib/tickets/ticket.js';

  let orders = $state<readonly QueueOrder[]>([]);
  let now = $state(Date.now());
  let loaded = $state(false);
  let checking = $state(false);
  let connectionError = $state('');
  let actionError = $state('');
  const error = $derived(actionError || connectionError);
  let lastUpdated = $state<string>();
  let pending = $state(new Set<string>());
  let stopped = false;
  let feed: QueueFeed | undefined;
  let trackingEnabled = $state<boolean>();
  let checkingFeatures = false;
  let featuresController: AbortController | undefined;
  let ageTimer: ReturnType<typeof setInterval> | undefined;
  const open = $derived(sortOrders(orders, 'open'));
  const done = $derived(sortOrders(orders, 'done').slice(0, 8));
  const servingCount = $derived(
    open.reduce((n, o) => n + o.ticket.servings.length, 0),
  );
  const oldest = $derived(open.length ? waitMinutes(open[0], now) : 0);
  const openIds = $derived(open.map((o) => o.ticket.id));
  const openById = $derived(new Map(open.map((o) => [o.ticket.id, o])));
  const position = $derived(new Map(open.map((o, i) => [o.ticket.id, i + 1])));

  // Packed columns: cards go oldest first into the shortest column, using
  // measured heights. Cards that have no height yet are measured in a hidden
  // row with the same column widths; the visible stacks only change when the
  // set of open orders or the column count changes, never on the age refresh.
  let contentWidth = $state(0);
  const columnTotal = $derived(columnCount(contentWidth));
  let layout = $state<{ key: string; columns: readonly (readonly string[])[] }>(
    { key: '', columns: [] },
  );
  let measuring = $state<{
    key: string;
    columns: number;
    ids: string[];
    missing: string[];
  }>();
  const stacks = $derived(
    layout.columns.map((ids) => ids.flatMap((id) => openById.get(id) ?? [])),
  );
  const heights = new Map<string, number>();
  let measuredWidth = 0;
  let planToken = 0;

  function commit(key: string, columns: number, ids: readonly string[]) {
    layout = {
      key,
      columns: packColumns(
        ids.map((id) => heights.get(id) ?? 0),
        columns,
      ).map((stack) => stack.map((index) => ids[index])),
    };
  }
  function plan(key: string, columns: number, ids: string[]) {
    if (key === layout.key || measuring?.key === key) return;
    if (measuredWidth !== contentWidth) {
      heights.clear();
      measuredWidth = contentWidth;
    }
    for (const id of [...heights.keys()])
      if (!ids.includes(id)) heights.delete(id);
    const missing = ids.filter((id) => !heights.has(id));
    const token = ++planToken;
    if (!missing.length) {
      measuring = undefined;
      commit(key, columns, ids);
      return;
    }
    const start = () => {
      if (token === planToken && !stopped)
        measuring = { key, columns, ids, missing };
    };
    // Measure with the real font: wait for it, but never longer than a second.
    if (document.fonts?.status === 'loading')
      void Promise.race([
        document.fonts.ready,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]).then(start);
    else start();
  }
  function measured(id: string, height: number) {
    const current = measuring;
    if (!current?.missing.includes(id)) return;
    heights.set(id, height);
    if (current.missing.every((missing) => heights.has(missing))) {
      measuring = undefined;
      commit(current.key, current.columns, current.ids);
    }
  }
  $effect(() => {
    const columns = columnTotal;
    const ids = openIds;
    if (!contentWidth) return;
    untrack(() => plan(JSON.stringify([columns, ids]), columns, ids));
  });
  const clock = (date: string) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(date));
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? '' : 's'}`;

  async function checkFeatures(reconnect: boolean) {
    if (checkingFeatures || stopped) return;
    checkingFeatures = true;
    checking = true;
    featuresController = new AbortController();
    try {
      const enabled = await fetchTrackingEnabled(featuresController.signal);
      if (stopped) return;
      trackingEnabled = enabled;
      if (!enabled) {
        feed?.stop();
        feed = undefined;
        clearInterval(ageTimer);
        ageTimer = undefined;
        orders = [];
        loaded = false;
        connectionError = '';
        actionError = '';
      } else if (!feed) {
        feed = new QueueFeed((state) => {
          orders = state.orders;
          loaded = state.loaded;
          checking = state.connecting;
          connectionError = state.error;
          lastUpdated = state.updatedAt;
          now = Date.now();
          if (state.error) void checkFeatures(false);
        });
        feed.start();
        ageTimer = setInterval(() => {
          now = Date.now();
        }, 30000);
      } else if (reconnect) feed.refresh();
    } catch (failure) {
      if (!stopped) connectionError = (failure as Error).message;
    } finally {
      checkingFeatures = false;
      if (!stopped) checking = false;
    }
  }
  function refresh() {
    void checkFeatures(true);
  }
  async function update(id: string, action: 'done' | 'reopen') {
    if (pending.has(id) || stopped) return;
    pending = new Set([...pending, id]);
    try {
      const change = await changeOrderStatus(id, action);
      if (stopped) return;
      feed?.applyChange(change);
      actionError = '';
      now = Date.now();
    } catch (failure) {
      if (!stopped) actionError = (failure as Error).message;
    } finally {
      if (!stopped) {
        pending = new Set([...pending].filter((value) => value !== id));
      }
    }
  }
  onMount(() => {
    stopped = false;
    refresh();
    window.addEventListener('online', refresh);
    return () => {
      stopped = true;
      feed?.stop();
      clearInterval(ageTimer);
      featuresController?.abort();
      window.removeEventListener('online', refresh);
    };
  });
</script>

<svelte:head
  ><title>Now Scooping · Order Pad</title><meta
    name="description"
    content="Track open ice cream orders and mark completed orders done."
  /></svelte:head
>

{#snippet card(order: QueueOrder)}
  {@const ticket = order.ticket}
  {@const age = waitMinutes(order, now)}
  <article
    class="queue-card"
    aria-label={`Order #${ticket.reference} · ${ticket.displayName}`}
    aria-posinset={position.get(ticket.id)}
    aria-setsize={open.length}
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
        ><time datetime={order.submittedAt}>{clock(order.submittedAt)}</time>
      </div>
    </header>
    <ol class="queue-servings">
      {#each ticket.servings as serving, index}<li>
          <span class="queue-serving-number">{index + 1}</span>
          <div class="serving-detail">
            <strong
              >{plural(totalScoops(serving), 'scoop')} · {serving.container}</strong
            >
            <ul class="chips" aria-label="Flavors">
              {#each serving.flavors as portion (portion.flavor)}
                <li class="chip flavor-chip">
                  <span class="chip-count">{portion.count}</span>
                  <span class="chip-name">{portion.flavor}</span>
                </li>
              {/each}
            </ul>
            {#if serving.toppings.length}
              <ul class="chips" aria-label="Toppings">
                {#each serving.toppings as topping (topping)}
                  <li class="chip topping-chip">
                    <svg
                      aria-hidden="true"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2.5"
                      stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg
                    >
                    <span class="chip-name">{topping}</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <span class="chip no-toppings">No toppings</span>
            {/if}
          </div>
        </li>{/each}
    </ol>
    <div class="done-action">
      <button
        class="primary"
        onclick={() => update(ticket.id, 'done')}
        disabled={!!connectionError || pending.has(ticket.id)}
        aria-busy={pending.has(ticket.id)}>Mark #{ticket.reference} done</button
      >
    </div>
  </article>
{/snippet}

<div class="queue-app">
  <header class="queue-header">
    <div class="queue-brand">
      <a href="/" aria-label="Order builder"
        ><img
          class="brand-logo"
          src="/logo.svg"
          alt="Fiona's Ice Cream"
          width="83"
          height="44"
        /></a
      ><span class="header-rule" aria-hidden="true"></span>
      <h1>Now Scooping</h1>
    </div>
    {#if trackingEnabled !== false}<dl
        class="queue-metrics"
        aria-label="Queue totals"
      >
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
      </dl>{/if}
  </header>
  <main class="queue-content" bind:clientWidth={contentWidth}>
    {#if trackingEnabled === false}
      <section class="queue-empty" aria-label="Order tracking disabled">
        <h2>Order tracking is turned off</h2>
        <p>Orders still print normally.</p>
        <a class="queue-link" href="/">Back to order builder</a>
      </section>
    {/if}
    {#if error}<div class="queue-error" role="alert">
        <div>
          <strong
            >{connectionError && !actionError && loaded
              ? 'Reconnecting…'
              : 'Queue needs attention'}</strong
          >
          <p>{error}</p>
          {#if lastUpdated}<p>
              Showing the last available orders · updated {clock(lastUpdated)}
            </p>{/if}
        </div>
        <button
          class="secondary"
          onclick={() => {
            actionError = '';
            refresh();
          }}
          disabled={checking || !!pending.size}>Refresh queue</button
        >
      </div>{/if}
    {#if trackingEnabled !== false && !loaded && !error}<p
        class="queue-loading"
        role="status"
      >
        Loading build queue…
      </p>{/if}
    {#if loaded && !open.length}<div class="queue-empty">
        <h2>All caught up</h2>
        <p>New orders show up here the moment they print.</p>
      </div>{/if}
    <div class="queue-columns" role="group" aria-label="Open orders">
      {#each stacks as stack, column (column)}
        <div class="queue-column">
          {#each stack as order (order.ticket.id)}{@render card(order)}{/each}
        </div>
      {/each}
      {#if measuring}<div class="queue-measure" aria-hidden="true" inert>
          {#each { length: measuring.columns } as _, column}
            <div class="queue-column">
              {#if column === 0}
                {#each measuring.missing as id (id)}
                  {@const order = openById.get(id)}
                  {#if order}<div
                      bind:clientHeight={
                        null, (height) => measured(id, height ?? 0)
                      }
                    >
                      {@render card(order)}
                    </div>{/if}
                {/each}
              {/if}
            </div>
          {/each}
        </div>{/if}
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
            disabled={!!connectionError || pending.has(order.ticket.id)}
            aria-busy={pending.has(order.ticket.id)}>Undo</button
          >
        </div>{/each}
    </section>{/if}
</div>

<style>
  .queue-app {
    height: 100%;
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
    flex-shrink: 0;
    height: 44px;
    display: grid;
    place-items: center;
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
  .queue-columns {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 20px;
  }
  .queue-column {
    flex: 1 1 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .queue-measure {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 0;
    overflow: hidden;
    visibility: hidden;
    pointer-events: none;
    display: flex;
    align-items: flex-start;
    gap: 20px;
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
  .queue-servings > li {
    padding: 12px 0;
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
  .serving-detail {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .serving-detail strong {
    font-size: 15px;
    font-weight: 600;
    line-height: 26px;
    color: var(--text-heading);
  }
  .chips {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    height: 32px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    white-space: nowrap;
  }
  .chip-name {
    line-height: 1;
    white-space: nowrap;
  }
  .flavor-chip {
    padding: 0 12px 0 4px;
    gap: 8px;
    border-radius: var(--radius-pill);
    background: var(--surface-page);
  }
  .chip-count {
    min-width: 24px;
    height: 24px;
    box-sizing: border-box;
    padding: 0 6px;
    border-radius: var(--radius-pill);
    background: var(--olive-900);
    color: var(--cream-100);
    font-size: 13px;
    font-weight: 700;
    line-height: 24px;
    text-align: center;
  }
  .flavor-chip .chip-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text-heading);
  }
  .topping-chip {
    padding: 0 12px 0 8px;
    gap: 6px;
    border-radius: 6px;
    border: 1.5px solid var(--olive-700);
    background: var(--surface-card);
    color: var(--olive-700);
  }
  .topping-chip svg {
    flex-shrink: 0;
  }
  .topping-chip .chip-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--olive-900);
  }
  .no-toppings {
    align-self: flex-start;
    padding: 0 12px;
    border-radius: 6px;
    border: 1.5px dashed var(--paper-300);
    font-size: 14px;
    font-weight: 500;
    line-height: 1;
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
