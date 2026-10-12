<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { formatTicket } from '$lib/tickets/format';
  import {
    flavors,
    maxScoopsPerServing,
    totalScoops,
    scoopSummary,
    type Flavor,
    containers,
    toppings,
    emptyEditor,
    draftTicket,
    commitServing,
    hasPendingServing,
    prepareDraftForPrint,
    type OrderDraft,
    type ServingEditor,
  } from '$lib/tickets/order';
  import { PrintSession, type SessionState } from '$lib/printing/session';
  import { IndexedDbTicketStore } from '$lib/storage/ticket-store';
  import {
    LinuxCupsPrinter,
    linuxPrinterStatus,
    type LinuxPrinterStatus,
  } from '$lib/printing/adapters/linux-cups';

  let tab = $state<'order' | 'printer'>('order');
  let viewState = $state<SessionState>({ phase: 'loading', attempts: [] });
  let session: PrintSession;
  let sending = $state(false);
  let checkingPrinter = $state(false);
  let printerStatus = $state<LinuxPrinterStatus>({
    ready: false,
    message: 'Checking the server’s USB printer…',
  });
  let outputConfirmed = $state(false);
  let formError = $state('');
  let online = $state(true);
  let offlineStatus = $state('Checking offline availability…');
  let previewTimestamp = $state(new Date().toISOString());
  const printer = new LinuxCupsPrinter();
  const draft = $derived(viewState.draft);
  const last = $derived(viewState.attempts.at(-1));
  const working = $derived(
    sending || ['saving', 'printing', 'handoff'].includes(viewState.phase),
  );
  const editable = $derived(
    viewState.phase === 'ready' &&
      !working &&
      !!draft &&
      !draft.submittedTicketId,
  );
  const unfinished = $derived(!!draft && hasPendingServing(draft));
  const editorComplete = $derived(
    !!draft?.editor.flavors.length && !!draft?.editor.container,
  );
  const needsConfirmation = $derived(
    last?.result?.status === 'outcome-unknown',
  );
  const prepared = $derived.by(() => {
    if (!draft || draft.submittedTicketId) return undefined;
    try {
      return prepareDraftForPrint(draft);
    } catch {
      return undefined;
    }
  });
  const printProblem = $derived.by(() => {
    if (!draft || draft.submittedTicketId) return '';
    try {
      prepareDraftForPrint(draft);
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  });
  const canSend = $derived(
    viewState.phase === 'ready' &&
      !working &&
      !checkingPrinter &&
      printerStatus.ready &&
      (!needsConfirmation || outputConfirmed),
  );
  const draftPreview = $derived(
    prepared
      ? draftTicket(prepared, 'Assigned when printed', previewTimestamp)
      : undefined,
  );
  const preview = $derived(draftPreview ? formatTicket(draftPreview) : []);
  const lastPreview = $derived(
    viewState.ticket
      ? formatTicket(viewState.ticket, last?.reprint ?? false)
      : [],
  );
  const servingCount = $derived(
    prepared?.servings.length ?? draft?.servings.length ?? 0,
  );

  onMount(() => {
    const updateOnline = () => {
      online = navigator.onLine;
    };
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    let cancelled = false;
    try {
      session = new PrintSession(new IndexedDbTicketStore(), (next) => {
        viewState = next;
      });
      void session.initialize();
    } catch {
      viewState = {
        phase: 'blocked',
        attempts: [],
        notice:
          'IndexedDB is unavailable in this browser. Printing is blocked because tickets and attempts cannot be saved.',
      };
    }
    void checkPrinter();
    const checkCache = async () => {
      try {
        const names = await caches.keys();
        if (!cancelled)
          offlineStatus = names.some((name) => name.startsWith('order-pad-'))
            ? 'App assets cached · printer host connection required'
            : 'App assets not cached yet';
      } catch {
        if (!cancelled)
          offlineStatus = 'Offline cache unavailable in this browser';
      }
    };
    void checkCache();
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.ready.then(checkCache);
    return () => {
      cancelled = true;
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  });

  async function checkPrinter() {
    if (working || checkingPrinter) return;
    checkingPrinter = true;
    printerStatus = {
      ...printerStatus,
      message: 'Checking the server’s USB printer…',
    };
    printerStatus = await linuxPrinterStatus();
    checkingPrinter = false;
  }

  function selectTab(next: 'order' | 'printer') {
    tab = next;
    if (next === 'printer' && !checkingPrinter) void checkPrinter();
  }

  async function tabKey(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    selectTab(
      event.key === 'Home'
        ? 'order'
        : event.key === 'End'
          ? 'printer'
          : tab === 'order'
            ? 'printer'
            : 'order',
    );
    await tick();
    document.getElementById(`${tab}-tab`)?.focus();
  }

  function changeDraft(next: OrderDraft) {
    if (!editable) return;
    formError = '';
    try {
      session.updateDraft(next);
    } catch (error) {
      formError = (error as Error).message;
    }
  }

  function changeEditor(editor: ServingEditor) {
    if (draft) changeDraft({ ...draft, editor });
  }

  function changeScoops(flavor: Flavor, amount: number) {
    if (!draft || !editable) return;
    const existing =
      draft.editor.flavors.find((portion) => portion.flavor === flavor)
        ?.scoops ?? 0;
    const scoops = existing + amount;
    if (scoops < 0 || totalScoops(draft.editor) + amount > maxScoopsPerServing)
      return;
    const selected = draft.editor.flavors.filter(
      (portion) => portion.flavor !== flavor,
    );
    changeEditor({
      ...draft.editor,
      flavors: scoops ? [...selected, { flavor, scoops }] : selected,
    });
  }

  function addServing() {
    if (!draft || !editable) return;
    try {
      changeDraft(commitServing(draft));
    } catch (error) {
      formError = (error as Error).message;
    }
  }

  function removeServing(index: number) {
    if (!draft) return;
    changeDraft({
      ...draft,
      servings: draft.servings.filter((_, i) => i !== index),
      editor: draft.editingIndex === index ? emptyEditor() : draft.editor,
      editingIndex:
        draft.editingIndex === index
          ? undefined
          : draft.editingIndex !== undefined && draft.editingIndex > index
            ? draft.editingIndex - 1
            : draft.editingIndex,
    });
  }

  async function print(reprint: boolean) {
    if (
      !canSend ||
      (!reprint && (!editable || !prepared)) ||
      (reprint && !viewState.attempts.length)
    )
      return;
    const confirmed = outputConfirmed;
    outputConfirmed = false;
    formError = '';
    sending = true;
    try {
      if (reprint) await session.print(printer, true, confirmed);
      else await session.submit(printer, confirmed);
      if (viewState.phase === 'ready' && last?.result?.status === 'accepted')
        previewTimestamp = new Date().toISOString();
    } catch (error) {
      formError = (error as Error).message;
    } finally {
      sending = false;
    }
  }

  async function startNewOrder() {
    if (
      working ||
      viewState.phase !== 'ready' ||
      (needsConfirmation && !outputConfirmed)
    )
      return;
    await session.newOrder(outputConfirmed);
    // Preserve acknowledgment while the latest saved result is still unknown.
    formError = '';
    previewTimestamp = new Date().toISOString();
  }
</script>

<svelte:head>
  <title>Order Pad · Build an order</title>
  <meta
    name="description"
    content="Build ice cream orders and print tickets to the server’s USB printer."
  />
</svelte:head>

{#snippet receipt(lines: ReturnType<typeof formatTicket>)}
  <div class="paper">
    {#each lines as line, index (index)}
      <div
        class:heading={line.role === 'heading'}
        class:reference={line.role === 'reference'}
        class:reprint={line.role === 'reprint'}
        class:end={line.role === 'end'}
      >
        {line.text || '\u00a0'}
      </div>
    {/each}
  </div>
{/snippet}

<div class="app">
  <header>
    <a class="brand" href="#order-panel" onclick={() => selectTab('order')}
      ><span class="brand-icon" aria-hidden="true">≡</span><span
        ><strong>Order Pad</strong><small>Preparation tickets</small></span
      ></a
    >
    <div class="tabs" role="tablist" aria-label="Workspace">
      <button
        id="order-tab"
        role="tab"
        aria-selected={tab === 'order'}
        aria-controls="order-panel"
        tabindex={tab === 'order' ? 0 : -1}
        onclick={() => selectTab('order')}
        onkeydown={tabKey}>Order</button
      >
      <button
        id="printer-tab"
        role="tab"
        aria-selected={tab === 'printer'}
        aria-controls="printer-panel"
        tabindex={tab === 'printer' ? 0 : -1}
        onclick={() => selectTab('printer')}
        onkeydown={tabKey}>Printer settings</button
      >
    </div>
  </header>

  <main>
    <div
      id="order-panel"
      role="tabpanel"
      tabindex="0"
      aria-labelledby="order-tab"
      hidden={tab !== 'order'}
    >
      <div class="intro">
        <div>
          <h1>Build an order</h1>
          <p>
            Choose your scoops and container. Print includes your current
            serving.
          </p>
        </div>
        <div class="printer-indicator" class:attention={!printerStatus.ready}>
          <span class="dot" aria-hidden="true"></span>
          <span
            >{checkingPrinter
              ? 'Checking USB printer…'
              : printerStatus.ready
                ? 'USB printing ready'
                : 'Printer needs attention'}</span
          >
          <button class="text-button" onclick={() => selectTab('printer')}
            >Settings</button
          >
        </div>
      </div>

      {#if !checkingPrinter && !printerStatus.ready}
        <div class="notice warning" role="alert">
          <strong>Printer unavailable</strong>
          <p>{printerStatus.message}</p>
          <button
            class="secondary compact"
            onclick={checkPrinter}
            disabled={working}>Check printer</button
          >
        </div>
      {/if}
      {#if viewState.notice}<div class="notice warning" role="alert">
          <strong>Storage needs attention</strong>
          <p>{viewState.notice}</p>
        </div>{/if}
      {#if needsConfirmation}
        <div class="notice warning">
          <strong>Outcome unknown · check the printer before continuing</strong>
          <p>
            The ticket may have printed or be queued. Check the output and
            pending CUPS jobs. Nothing will be resent automatically.
          </p>
          <label class="checkbox"
            ><input
              type="checkbox"
              bind:checked={outputConfirmed}
              disabled={working}
            /><span>I checked the output and am ready to continue.</span></label
          >
        </div>
      {/if}

      <div class="order-layout">
        <section class="card editor" aria-labelledby="serving-title">
          {#if draft && !draft.submittedTicketId}
            <div class="section-heading">
              <h2 id="serving-title">
                {draft.editingIndex === undefined
                  ? 'Choose your serving'
                  : `Edit serving ${draft.editingIndex + 1}`}
              </h2>
              <span class="muted"
                >{draft.editingIndex === undefined
                  ? `Serving ${draft.servings.length + 1}`
                  : 'Changes included when printing'}</span
              >
            </div>
            <fieldset disabled={!editable}>
              <legend
                >Flavors &amp; scoops <span>mix up to 5 scoops</span></legend
              >
              <div class="choices scoop-choices">
                {#each flavors as flavor}
                  {@const count =
                    draft.editor.flavors.find(
                      (portion) => portion.flavor === flavor,
                    )?.scoops ?? 0}
                  <div class="scoop-choice" class:selected={count > 0}>
                    <strong>{flavor}</strong>
                    <div
                      class="scoop-counter"
                      role="group"
                      aria-label={`${flavor} scoops`}
                    >
                      <button
                        class="scoop-button"
                        aria-label={`Remove scoop of ${flavor}`}
                        disabled={!editable || count === 0}
                        onclick={() => changeScoops(flavor, -1)}>−</button
                      >
                      <span
                        class="scoop-count"
                        aria-label={`${flavor} scoop count`}
                        aria-live="polite">{count}</span
                      >
                      <button
                        class="scoop-button"
                        aria-label={`Add scoop of ${flavor}`}
                        disabled={!editable ||
                          totalScoops(draft.editor) >= maxScoopsPerServing}
                        onclick={() => changeScoops(flavor, 1)}>+</button
                      >
                    </div>
                  </div>
                {/each}
              </div>
              <p class="scoop-total" aria-live="polite">
                {totalScoops(draft.editor)} of 5 scoops{totalScoops(
                  draft.editor,
                ) === maxScoopsPerServing
                  ? ' · Remove a scoop to change flavors.'
                  : ''}
              </p>
            </fieldset>
            <fieldset disabled={!editable}>
              <legend>Container <span>choose one</span></legend>
              <div class="choices containers">
                {#each containers as container}<label class="choice"
                    ><input
                      type="radio"
                      name="container"
                      value={container}
                      checked={draft.editor.container === container}
                      onchange={() =>
                        changeEditor({ ...draft!.editor, container })}
                    /><span>{container}</span></label
                  >{/each}
              </div>
            </fieldset>
            <fieldset disabled={!editable}>
              <legend>Toppings <span>optional</span></legend>
              <div class="choices">
                {#each toppings as topping}<label class="choice"
                    ><input
                      type="checkbox"
                      checked={draft.editor.toppings.includes(topping)}
                      onchange={(event) =>
                        changeEditor({
                          ...draft!.editor,
                          toppings: event.currentTarget.checked
                            ? [...draft!.editor.toppings, topping]
                            : draft!.editor.toppings.filter(
                                (t) => t !== topping,
                              ),
                        })}
                    /><span>{topping}</span></label
                  >{/each}
              </div>
            </fieldset>
            <div class="editor-actions">
              <button
                class="secondary"
                onclick={addServing}
                disabled={!editable ||
                  !editorComplete ||
                  (draft.servings.length >= 30 &&
                    draft.editingIndex === undefined)}
                >{draft.editingIndex === undefined
                  ? 'Add serving'
                  : 'Save serving'}</button
              >
              {#if unfinished}<button
                  class="text-button"
                  disabled={!editable}
                  onclick={() =>
                    changeDraft({
                      ...draft!,
                      editor: emptyEditor(),
                      editingIndex: undefined,
                    })}>Cancel serving</button
                >{/if}
            </div>
            <p class="small">
              {draft.editingIndex === undefined
                ? 'For more servings, add this one and choose another. For the last serving, just press Print order.'
                : 'Save to keep editing, or press Print order to save and submit.'}
            </p>
          {:else if draft}<h2 id="serving-title">Submitted order</h2>
            <p class="muted">
              {last?.result?.status === 'failed'
                ? 'No job was submitted. Resolve the issue, then reprint this order or start a new one.'
                : 'This order is saved. Check its print result before continuing.'}
            </p>
            <ol class="servings submitted" aria-label="Submitted servings">
              {#each draft.servings as serving, index}<li>
                  <strong>{index + 1}. {scoopSummary(serving)}</strong>
                  <p>
                    {serving.container} · {totalScoops(serving)}
                    {totalScoops(serving) === 1 ? 'scoop' : 'scoops'} · {serving.toppings.join(
                      ', ',
                    ) || 'No toppings'}
                  </p>
                </li>{/each}
            </ol>
          {:else}<h2 id="serving-title">Your serving</h2>
            <p class="muted">
              {viewState.phase === 'blocked'
                ? 'Resolve the storage issue to recover your order.'
                : 'Loading your order…'}
            </p>{/if}
        </section>

        <aside class="card order-summary" aria-labelledby="order-title">
          <div class="section-heading">
            <h2 id="order-title">Your order</h2>
            <span class="count"
              >{servingCount}
              {servingCount === 1 ? 'serving' : 'servings'}</span
            >
          </div>
          {#if draft}
            <label class="field-label" for="order-name">Name (optional)</label>
            <input
              id="order-name"
              type="text"
              maxlength="80"
              autocomplete="off"
              placeholder="Customer name"
              value={draft.name}
              disabled={!editable}
              oninput={(event) =>
                changeDraft({ ...draft!, name: event.currentTarget.value })}
            />
            <p class="small">
              Ticket label: <strong
                >{draft.name.trim() || draft.reference}</strong
              >
            </p>
            <ol class="servings" aria-label="Order servings">
              {#each prepared?.servings ?? draft.servings as serving, index}
                {@const pending =
                  !!prepared &&
                  unfinished &&
                  (draft.editingIndex === index ||
                    (draft.editingIndex === undefined &&
                      index === draft.servings.length))}
                <li class:pending>
                  <div>
                    <strong>{index + 1}. {scoopSummary(serving)}</strong>
                    <p>
                      {serving.container} · {totalScoops(serving)}
                      {totalScoops(serving) === 1 ? 'scoop' : 'scoops'} · {serving.toppings.join(
                        ', ',
                      ) || 'No toppings'}
                    </p>
                    {#if pending}<span class="pending-label"
                        >Included when printing</span
                      >{/if}
                  </div>
                  {#if !draft.submittedTicketId && !pending}<div
                      class="serving-actions"
                    >
                      <button
                        class="text-button"
                        disabled={!editable || unfinished}
                        aria-label={`Edit serving ${index + 1}`}
                        onclick={() =>
                          changeDraft({
                            ...draft!,
                            editor: { ...serving },
                            editingIndex: index,
                          })}>Edit</button
                      ><button
                        class="text-button"
                        disabled={!editable}
                        aria-label={`Remove serving ${index + 1}`}
                        onclick={() => removeServing(index)}>Remove</button
                      >
                    </div>{/if}
                </li>
              {/each}
            </ol>
            {#if !servingCount}<p class="empty">
                Your servings will appear here.
              </p>{/if}
            {#if draft.servings.length >= 30}<p class="small">
                This order has reached the 30-serving limit.
              </p>{/if}
            {#if !draft.submittedTicketId}<details class="receipt-details">
                <summary>Ticket preview</summary>
                <div aria-label="Preparation ticket preview">
                  {#if preview.length}{@render receipt(preview)}{:else}<p
                      class="small"
                    >
                      {printProblem}
                    </p>{/if}
                </div>
              </details>{/if}
            <button
              class="text-button new-order"
              onclick={startNewOrder}
              disabled={working ||
                viewState.phase !== 'ready' ||
                (needsConfirmation && !outputConfirmed) ||
                (!draft.submittedTicketId &&
                  !draft.servings.length &&
                  !unfinished &&
                  !draft.name)}>New order</button
            >
          {/if}
        </aside>
      </div>

      <section class="card last-order" aria-labelledby="last-title">
        <div class="section-heading">
          <div>
            <h2 id="last-title">Last submitted order</h2>
            <p class="muted">
              {viewState.ticket?.reference ?? 'No orders submitted yet'}
            </p>
          </div>
          <button
            class="secondary compact"
            onclick={() => print(true)}
            disabled={!canSend || !viewState.attempts.length}
            >Reprint last order</button
          >
        </div>
        {#if viewState.ticket}<details class="receipt-details">
            <summary>View last receipt</summary>
            <div aria-label="Last submitted ticket preview">
              {@render receipt(lastPreview)}
            </div>
          </details>{/if}
        {#if viewState.attempts.length}<details class="attempt-details">
            <summary>Print attempts ({viewState.attempts.length})</summary>
            <ol class="attempts">
              {#each [...viewState.attempts].reverse() as attempt (attempt.id)}<li
                >
                  <div>
                    <strong
                      >{attempt.reprint ? 'REPRINT' : 'ORDER'} · {attempt.mode ===
                      'linux-cups'
                        ? 'Server USB'
                        : `Previous ${attempt.mode} attempt`}</strong
                    ><span class="small"
                      >{new Date(attempt.startedAt).toLocaleString()}</span
                    >
                  </div>
                  <span
                    class="outcome"
                    class:unknown={attempt.result?.status === 'outcome-unknown'}
                    >{attempt.result?.status ?? 'Awaiting response'}</span
                  >
                  <p>
                    {attempt.result?.message ?? 'Intent saved before sending.'}
                  </p>
                </li>{/each}
            </ol>
          </details>{/if}
      </section>
      {#if formError}<p class="notice warning" role="alert">{formError}</p>{/if}
      <div class="action-bar">
        <div class="feedback" role="status" aria-live="polite">
          {#if viewState.notice}<strong>Storage needs attention</strong>
          {:else if working}<strong
              >{viewState.phase === 'saving'
                ? 'Saving order…'
                : 'Submitting order…'}</strong
            >
          {:else if last?.result}<strong
              >{last.result.status === 'accepted'
                ? `${last.reprint ? 'Reprint' : 'Order'} submitted — ${viewState.ticket?.reference}`
                : last.result.status === 'failed'
                  ? 'Order submission failed'
                  : 'Outcome unknown'}</strong
            >
            <p>
              {last.result.status === 'accepted'
                ? 'Accepted by the USB print queue.'
                : last.result.message}
            </p>
          {:else}<strong
              >{viewState.phase === 'loading'
                ? 'Loading your order…'
                : 'Ready for your next order'}</strong
            >{/if}
          {#if printProblem && !working}<p class="print-help" id="print-help">
              {printProblem}
            </p>{/if}
        </div>
        <button
          class="primary print-button"
          aria-describedby={printProblem ? 'print-help' : undefined}
          onclick={() => print(false)}
          disabled={!canSend || !editable || !prepared}
          >{working
            ? 'Submitting…'
            : `Print order${servingCount ? ` · ${servingCount}` : ''}`}</button
        >
      </div>
    </div>

    <div
      id="printer-panel"
      role="tabpanel"
      tabindex="0"
      aria-labelledby="printer-tab"
      hidden={tab !== 'printer'}
    >
      <div class="intro">
        <div>
          <h1>Printer settings</h1>
          <p>Orders print to the USB printer attached to this server.</p>
        </div>
      </div>
      <section class="card settings-card" aria-labelledby="usb-title">
        <h2 id="usb-title">Star TSP143IIIU</h2>
        <p class="muted">Primary order-ticket printer · USB</p>
        <dl>
          <dt>Print destination</dt>
          <dd>This server’s USB printer</dd>
          <dt>CUPS queue</dt>
          <dd>
            {printerStatus.queue ?? 'Unavailable until the service responds'}
          </dd>
        </dl>
        <div class="notice" class:warning={!printerStatus.ready}>
          <strong
            >{checkingPrinter
              ? 'Checking printer…'
              : printerStatus.ready
                ? 'USB queue configured'
                : 'Printer needs attention'}</strong
          >
          <p>{printerStatus.message}</p>
        </div>
        <button
          class="secondary"
          onclick={checkPrinter}
          disabled={working || checkingPrinter}
          >{checkingPrinter ? 'Checking printer…' : 'Check printer'}</button
        >
        <h3>Server setup</h3>
        <ol class="setup-steps">
          <li>
            Connect the Star printer’s USB-B port to this server and power the
            printer on.
          </li>
          <li>
            Configure a local USB CUPS queue with the Star TSP100 Cutter driver.
            Set <code>ORDER_PAD_QUEUE</code> to that queue when starting the Order
            Pad service.
          </li>
          <li>
            Verify a CUPS test print on the server, then open this server’s
            Order Pad address on your ordering device.
          </li>
        </ol>
        <p class="small">
          Printer configuration is managed on the server. Queue readiness and
          accepted submissions do not verify physical output. If tickets stop
          appearing, check paper, power, USB, and pending CUPS jobs before
          reprinting.
        </p>
        <details>
          <summary>Connection and local storage</summary>
          <p class="small">
            {online ? 'Network available' : 'Device offline'} · {offlineStatus}
          </p>
          <p class="small">
            Drafts and the last submitted receipt are saved in this browser.
            Printing requires a connection to this server. Keep one Order Pad
            tab open per station and preserve browser storage when recovering a
            print.
          </p>
        </details>
      </section>
    </div>
  </main>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }
  :global(body) {
    margin: 0;
    color: #233b34;
    background: #f2f4ed;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  :global(button),
  :global(input) {
    font: inherit;
  }
  :global(button),
  :global(a) {
    -webkit-tap-highlight-color: transparent;
  }
  :global(:focus-visible) {
    outline: 3px solid #c67c27;
    outline-offset: 3px;
  }
  :global([hidden]) {
    display: none !important;
  }
  .app {
    max-width: 1280px;
    margin: auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 20px;
    padding: 20px 32px;
    border-bottom: 1px solid #d7ded2;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: inherit;
    text-decoration: none;
  }
  .brand-icon {
    background: #174f45;
    color: white;
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: grid;
    place-items: center;
    font-size: 30px;
  }
  .brand strong {
    display: block;
    font-size: 20px;
  }
  .brand small {
    color: #5c7166;
    font-size: 12px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    background: #e5eae0;
    padding: 4px;
    border-radius: 12px;
  }
  button {
    min-height: 48px;
    border-radius: 9px;
    border: 1px solid transparent;
    padding: 10px 16px;
    cursor: pointer;
    font-weight: 650;
    color: #174f45;
    background: transparent;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .tabs button {
    font-size: 14px;
  }
  .tabs button[aria-selected='true'] {
    background: #fffef9;
    box-shadow: 0 1px 4px #233b3412;
  }
  main {
    padding: 26px 32px 170px;
  }
  .intro {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }
  h1 {
    font-size: clamp(26px, 3vw, 34px);
    letter-spacing: -0.8px;
    margin: 0 0 8px;
  }
  .intro p,
  .muted {
    margin: 0;
    color: #5c7166;
    font-size: 14px;
    line-height: 1.5;
  }
  .printer-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #28523d;
    white-space: nowrap;
  }
  .dot {
    width: 8px;
    height: 8px;
    background: #497b5a;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .attention .dot {
    background: #ad731e;
  }
  .attention {
    color: #805119;
  }
  .text-button {
    text-decoration: underline;
    text-underline-offset: 3px;
    padding: 8px 10px;
    font-size: 13px;
  }
  .order-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.5fr) minmax(300px, 1fr);
    align-items: start;
    gap: 20px;
  }
  .card {
    background: #fffef9;
    border: 1px solid #d5ded2;
    border-radius: 16px;
    padding: 24px;
  }
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 20px;
  }
  h2 {
    font-size: 19px;
    margin: 0;
    letter-spacing: -0.3px;
  }
  .section-heading > .muted {
    font-size: 12px;
  }
  h3 {
    font-size: 16px;
    margin-top: 28px;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0 0 22px;
    min-width: 0;
  }
  legend {
    font-size: 14px;
    font-weight: 700;
    margin-bottom: 10px;
  }
  legend span {
    font-weight: 400;
    color: #627369;
    margin-left: 8px;
    font-size: 12px;
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .containers {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 9px;
    border: 1px solid #bdcfc1;
    border-radius: 9px;
    padding: 12px;
    min-height: 54px;
    cursor: pointer;
    font-size: 14px;
    line-height: 1.3;
  }
  .scoop-choice {
    border: 1px solid #bdcfc1;
    border-radius: 9px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
  }
  .scoop-choice.selected {
    background: #e2ede2;
    border-color: #174f45;
  }
  .scoop-choice strong {
    font-size: 14px;
  }
  .scoop-counter {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .scoop-button {
    width: 44px;
    min-height: 44px;
    padding: 0;
    font-size: 24px;
    border-color: #bdcfc1;
    background: #fffef9;
  }
  .scoop-count {
    min-width: 20px;
    text-align: center;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .scoop-total {
    margin: 12px 0 0;
    font-size: 13px;
    color: #28523d;
  }
  .choice:has(input:checked) {
    background: #e2ede2;
    border-color: #174f45;
  }
  .choice input,
  .checkbox input {
    width: 21px;
    height: 21px;
    margin: 0;
    accent-color: #174f45;
    flex-shrink: 0;
  }
  .editor-actions {
    display: flex;
    gap: 8px;
  }
  .secondary {
    border-color: #174f45;
    background: transparent;
  }
  .primary {
    background: #174f45;
    color: white;
    border-color: #174f45;
  }
  .small {
    font-size: 12px;
    line-height: 1.6;
    color: #627369;
  }
  .order-summary {
    position: sticky;
    top: 16px;
  }
  .count {
    border-radius: 20px;
    background: #e7eee3;
    padding: 6px 10px;
    font-size: 12px;
    white-space: nowrap;
  }
  .field-label {
    display: block;
    margin-bottom: 8px;
    font-size: 13px;
    font-weight: 650;
  }
  #order-name {
    display: block;
    width: 100%;
    min-height: 48px;
    border: 1px solid #bdcfc1;
    border-radius: 9px;
    background: white;
    padding: 10px 12px;
    color: inherit;
  }
  .servings {
    list-style: none;
    padding: 0;
    margin: 16px 0;
  }
  .servings li {
    border-top: 1px solid #e1e6dc;
    padding: 14px 0;
  }
  .servings strong {
    font-size: 14px;
  }
  .servings p {
    font-size: 13px;
    line-height: 1.5;
    margin: 5px 0 0;
    color: #5c7166;
  }
  .serving-actions {
    display: flex;
    margin: 4px 0 -8px;
  }
  .pending-label {
    display: block;
    font-size: 11px;
    color: #28523d;
    margin-top: 8px;
  }
  .pending {
    background: #eef4ed;
    padding: 14px 12px !important;
    border-radius: 8px;
  }
  .empty {
    color: #718073;
    font-size: 14px;
    margin: 24px 0;
  }
  details {
    border-top: 1px solid #e1e6dc;
    margin-top: 12px;
  }
  summary {
    cursor: pointer;
    font-weight: 650;
    font-size: 13px;
    padding: 14px 0;
    min-height: 48px;
  }
  .new-order {
    margin-top: 12px;
  }
  .last-order {
    margin-top: 20px;
  }
  .last-order .section-heading {
    margin-bottom: 0;
  }
  .last-order .muted {
    margin-top: 6px;
    overflow-wrap: anywhere;
  }
  .paper {
    background: white;
    color: #252d29;
    max-width: 430px;
    margin: 8px auto 16px;
    padding: 20px;
    box-shadow: 0 3px 12px #233b3410;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font:
      12px/1.6 ui-monospace,
      Consolas,
      monospace;
  }
  .paper .heading,
  .paper .reference,
  .paper .reprint,
  .paper .end {
    text-align: center;
    font-weight: 800;
  }
  .paper .reference {
    font-size: 20px;
    margin: 8px 0;
  }
  .paper .reprint {
    border: 2px solid #252d29;
    font-size: 20px;
    margin-bottom: 12px;
  }
  .attempts {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .attempts li {
    border-top: 1px solid #e1e6dc;
    padding: 16px 0;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    font-size: 13px;
  }
  .attempts .small {
    display: block;
  }
  .attempts p {
    grid-column: 1 / -1;
    line-height: 1.5;
    margin: 0;
    color: #5c7166;
  }
  .outcome {
    background: #e7eee3;
    padding: 6px 8px;
    border-radius: 6px;
    align-self: start;
    font-size: 12px;
  }
  .outcome.unknown {
    background: #fff0d8;
    color: #805119;
  }
  .notice {
    background: #eef4ed;
    border-radius: 10px;
    border: 1px solid #d5ded2;
    padding: 16px;
    margin-bottom: 20px;
    font-size: 14px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .notice p {
    margin: 8px 0;
  }
  .warning {
    background: #fff0d8;
    border-color: #dfc99f;
  }
  .checkbox {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
  }
  .action-bar {
    position: fixed;
    z-index: 5;
    bottom: 12px;
    left: 50%;
    transform: translateX(-50%);
    width: min(calc(100% - 32px), 1216px);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    padding: 16px 24px;
    background: #fffef9;
    border: 1px solid #bdcfc1;
    border-radius: 14px;
    box-shadow: 0 4px 24px #233b3420;
  }
  .feedback {
    min-width: 0;
    font-size: 14px;
  }
  .feedback strong {
    overflow-wrap: anywhere;
  }
  .feedback p {
    font-size: 12px;
    line-height: 1.4;
    margin: 5px 0 0;
    color: #627369;
  }
  .feedback .print-help {
    color: #805119;
  }
  .print-button {
    min-width: 190px;
    min-height: 56px;
    font-size: 16px;
    flex-shrink: 0;
  }
  .settings-card {
    max-width: 740px;
  }
  .settings-card > .muted {
    margin: 8px 0 24px;
  }
  dl {
    display: grid;
    grid-template-columns: 150px minmax(0, 1fr);
    gap: 12px;
    font-size: 14px;
    margin-bottom: 24px;
  }
  dt {
    color: #627369;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
    font-weight: 600;
  }
  .setup-steps {
    padding-left: 22px;
    font-size: 14px;
    line-height: 1.6;
  }
  .setup-steps li {
    margin-bottom: 10px;
  }
  code {
    overflow-wrap: anywhere;
  }
  @media (max-width: 900px) {
    header {
      padding: 18px 20px;
    }
    main {
      padding: 24px 20px 200px;
    }
    .intro {
      align-items: start;
      flex-direction: column;
    }
    .card {
      padding: 20px;
    }
    .order-layout {
      grid-template-columns: minmax(0, 1.2fr) minmax(260px, 1fr);
      gap: 16px;
    }
    .containers {
      grid-template-columns: 1fr;
    }
    .section-heading {
      flex-wrap: wrap;
    }
  }
  @media (max-width: 650px) {
    header {
      flex-direction: column;
      align-items: stretch;
      gap: 14px;
      padding: 16px;
    }
    .tabs button {
      flex: 1;
    }
    main {
      padding: 20px 16px 230px;
    }
    .order-layout {
      grid-template-columns: 1fr;
    }
    .order-summary {
      position: static;
    }
    .containers {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .choice {
      padding: 10px 8px;
      font-size: 13px;
      gap: 6px;
    }
    .card {
      padding: 18px;
    }
    .action-bar {
      flex-direction: column;
      align-items: stretch;
      padding: 12px 16px;
      gap: 10px;
      bottom: 8px;
    }
    .print-button {
      width: 100%;
    }
    .last-order .section-heading {
      align-items: start;
    }
    .compact {
      font-size: 13px;
      padding: 8px 12px;
    }
    .attempts li {
      grid-template-columns: 1fr;
    }
    .outcome {
      justify-self: start;
    }
    dl {
      grid-template-columns: 1fr;
      gap: 6px;
    }
    dd {
      margin-bottom: 12px;
    }
  }
</style>
