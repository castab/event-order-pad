<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { OrderPublisher } from '$lib/orders/publisher';
  import { formatTicket } from '$lib/tickets/format';
  import { blankNameLabel, cleanCustomerName } from '$lib/tickets/ticket';
  import {
    flavors,
    maxScoopsPerServing,
    totalScoops,
    sameServing,
    type Flavor,
    containers,
    toppings,
    cancelServing,
    editServing,
    removeServing as removeDraftServing,
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

  let queueNotice = $state('');
  let publisher: OrderPublisher | undefined;
  let toolsOpen = $state(false);
  let toast = $state<{
    title: string;
    detail: string;
    error: boolean;
    canReprint: boolean;
  }>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
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
  const draftPreview = $derived.by(() => {
    if (!prepared) return undefined;
    try {
      return draftTicket(prepared, 'Assigned when printed', previewTimestamp);
    } catch {
      return undefined;
    }
  });
  const preview = $derived(draftPreview ? formatTicket(draftPreview) : []);
  const lastPreview = $derived(
    viewState.ticket
      ? formatTicket(viewState.ticket, last?.reprint ?? false)
      : [],
  );
  const servingCount = $derived(prepared?.servings.length ?? 0);

  const editing = $derived(draft?.editingIndex !== undefined);
  const full = $derived(!editing && (draft?.servings.length ?? 0) >= 30);
  const unchangedEdit = $derived(
    !!draft &&
      draft.editingIndex !== undefined &&
      sameServing(draft.editor, draft.servings[draft.editingIndex]),
  );
  const canSave = $derived(
    editable && editorComplete && !full && !unchangedEdit,
  );
  const fallbackName = $derived(
    draft ? blankNameLabel(Number(draft.reference)) : '',
  );
  const recoveryNeeded = $derived(
    !!viewState.notice ||
      !!formError ||
      (!!last?.result && last.result.status !== 'accepted'),
  );
  const problem = $derived(
    draft && !draft.submittedTicketId && !working
      ? unfinished || draft.servings.length
        ? printProblem || (full ? '30 servings is the most per order.' : '')
        : ''
      : '',
  );
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? '' : 's'}`;
  const mixText = (s: ServingEditor) =>
    s.flavors.map((p) => `${p.count} ${p.flavor}`).join(' + ');

  onMount(() => {
    const updateOnline = () => {
      online = navigator.onLine;
    };
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    let cancelled = false;
    try {
      const store = new IndexedDbTicketStore();
      publisher = new OrderPublisher(store, (notice) => {
        if (!cancelled) queueNotice = notice;
      });
      session = new PrintSession(store, (next) => {
        viewState = next;
        if (
          next.phase === 'printing' &&
          next.attempts.at(-1)?.reprint === false
        )
          void publisher?.flush();
      });
      void session.initialize().then(() => {
        if (!cancelled && viewState.phase === 'ready') publisher?.start();
      });
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
      clearTimeout(toastTimer);
      publisher?.stop();
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

  function dismissToast() {
    clearTimeout(toastTimer);
    toast = undefined;
  }

  function showToast(
    title: string,
    detail: string,
    error = false,
    canReprint = false,
  ) {
    dismissToast();
    toast = { title, detail, error, canReprint };
    if (!error) toastTimer = setTimeout(dismissToast, 6000);
  }

  async function reviewPrint() {
    await tick();
    document.getElementById('print-recovery')?.focus();
    document
      .getElementById('print-recovery')
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function toggleTools() {
    toolsOpen = !toolsOpen;
    if (toolsOpen) void checkPrinter();
  }

  function changeName(input: HTMLInputElement) {
    if (!draft) return;
    const name = cleanCustomerName(
      Array.from(input.value.replace(/[\p{Cc}\u2028\u2029]/gu, ''))
        .slice(0, 80)
        .join(''),
      false,
    );
    input.value = name;
    changeDraft({ ...draft, name });
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
        ?.count ?? 0;
    const count = existing + amount;
    if (count < 0 || totalScoops(draft.editor) + amount > maxScoopsPerServing)
      return;
    const selected = draft.editor.flavors.filter(
      (portion) => portion.flavor !== flavor,
    );
    changeEditor({
      ...draft.editor,
      flavors: count ? [...selected, { flavor, count }] : selected,
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
    changeDraft(removeDraftServing(draft, index));
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
    dismissToast();
    const previousAttempt = last?.id;
    const previousReference = draft?.reference;
    try {
      if (reprint) await session.print(printer, true, confirmed);
      else await session.submit(printer, confirmed);
      const completed = viewState.attempts.at(-1);
      const ticket = viewState.ticket;
      if (viewState.notice) {
        showToast('Printing needs attention', viewState.notice, true);
      } else if (
        completed?.id !== previousAttempt &&
        completed?.result &&
        ticket
      ) {
        if (completed.result.status === 'accepted') {
          previewTimestamp = new Date().toISOString();
          if (viewState.draft?.reference !== previousReference) {
            await tick();
            document.querySelector('.builder-content')?.scrollTo({ top: 0 });
          }
          showToast(
            reprint
              ? `Reprint of #${ticket.reference} sent`
              : `Order #${ticket.reference} sent to the printer`,
            reprint
              ? 'Marked REPRINT on the ticket'
              : `${ticket.displayName} · ${plural(ticket.servings.length, 'serving')} · ${plural(
                  ticket.servings.reduce((n, s) => n + totalScoops(s), 0),
                  'scoop',
                )}`,
            false,
            !reprint,
          );
        } else {
          showToast(
            completed.result.status === 'failed'
              ? 'Order submission failed'
              : 'Outcome unknown',
            completed.result.message,
            true,
          );
        }
      }
    } catch (error) {
      formError = (error as Error).message;
      showToast('Printing needs attention', formError, true);
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
    dismissToast();
    // Preserve acknowledgment while the latest saved result is still unknown.
    formError = '';
    previewTimestamp = new Date().toISOString();
    await tick();
    document.querySelector('.builder-content')?.scrollTo({ top: 0 });
  }
</script>

<svelte:head>
  <title>Order Pad · Build an order</title>
  <meta
    name="description"
    content="Build ice cream orders and print preparation tickets."
  />
</svelte:head>

{#snippet icon(kind: 'print' | 'trash' | 'check' | 'close')}
  <svg
    aria-hidden="true"
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    {#if kind === 'print'}<path
        d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6z"
      />
    {:else if kind === 'trash'}<path
        d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"
      />
    {:else if kind === 'check'}<path d="M20 6 9 17l-5-5" />
    {:else}<path d="M18 6 6 18M6 6l12 12" />{/if}
  </svg>
{/snippet}

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

<div class="builder-app">
  <header class="builder-header">
    <img
      class="app-icon"
      src="/icon.svg"
      alt="Order Pad"
      width="36"
      height="36"
    />
    <div class="header-order">
      <span>Order #{draft?.reference ?? '…'}</span>
      <button
        class="icon-button"
        aria-label="Reprint last order"
        title="Reprint last order"
        onclick={() => print(true)}
        disabled={!canSend || !viewState.ticket || !viewState.attempts.length}
        >{@render icon('print')}</button
      >
    </div>
  </header>

  {#if toast}
    <div
      class="print-toast"
      class:error={toast.error}
      role={toast.error ? 'alert' : 'status'}
      aria-live={toast.error ? 'assertive' : 'polite'}
      aria-label="Print notification"
    >
      <span class="toast-icon"
        >{#if toast.error}<span aria-hidden="true">!</span>{:else}{@render icon(
            'check',
          )}{/if}</span
      >
      <div class="toast-copy">
        <strong>{toast.title}</strong><span>{toast.detail}</span>
      </div>
      {#if toast.error}<button class="toast-action" onclick={reviewPrint}
          >Review print</button
        >
      {:else if toast.canReprint}<button
          class="toast-action"
          onclick={() => print(true)}
          disabled={!canSend}>Reprint</button
        >{/if}
      <button class="icon-button" aria-label="Dismiss" onclick={dismissToast}
        >{@render icon('close')}</button
      >
    </div>
  {/if}

  <main class="builder-content">
    {#if !checkingPrinter && !printerStatus.ready}
      <section class="notice error" role="alert">
        <strong>Printer unavailable</strong>
        <p>{printerStatus.message}</p>
        <button class="secondary" onclick={checkPrinter} disabled={working}
          >Check printer</button
        >
      </section>
    {/if}
    {#if recoveryNeeded}
      <section
        class="notice error recovery"
        id="print-recovery"
        tabindex="-1"
        aria-label="Print recovery"
      >
        {#if viewState.notice}<div role="alert">
            <strong>Storage needs attention</strong>
            <p>{viewState.notice}</p>
          </div>{/if}
        {#if formError}<p role="alert">{formError}</p>{/if}
        {#if last?.result && last.result.status !== 'accepted'}
          <strong
            >{last.result.status === 'outcome-unknown'
              ? 'Outcome unknown · check the printer before continuing'
              : 'Order submission failed'}</strong
          >
          <p>{last.result.message}</p>
          {#if needsConfirmation}
            <p>
              The ticket may have printed or be queued. Check the output and
              pending CUPS jobs. Nothing will be resent automatically.
            </p>
            <label class="output-check"
              ><input
                type="checkbox"
                bind:checked={outputConfirmed}
                disabled={working}
              /><span>I checked the output and am ready to continue.</span
              ></label
            >
          {:else}<p>
              No job was submitted. Resolve the issue, then deliberately reprint
              or start a new order.
            </p>{/if}
          <div class="recovery-actions">
            <button
              class="secondary"
              onclick={() => print(true)}
              disabled={!canSend}>Reprint saved order</button
            ><button
              class="ghost"
              onclick={startNewOrder}
              disabled={working ||
                viewState.phase !== 'ready' ||
                (needsConfirmation && !outputConfirmed)}>New order</button
            >
          </div>
        {/if}
      </section>
    {/if}

    {#if draft}
      <div class="name-field">
        <label for="order-name">Customer name (optional)</label>
        <input
          id="order-name"
          type="text"
          autocomplete="off"
          placeholder={fallbackName}
          value={draft.name}
          disabled={!editable}
          aria-describedby="name-hint"
          oninput={(event) => changeName(event.currentTarget)}
        />
        <p id="name-hint">Left blank, the ticket says “{fallbackName}”</p>
      </div>
      {#if draft.servings.length && !draft.submittedTicketId}
        <section class="saved-section" aria-labelledby="saved-title">
          <div class="section-label">
            <h2 id="saved-title">Saved servings</h2>
            <span>{draft.servings.length} of 30</span>
          </div>
          <ol class="saved-servings" aria-label="Order servings">
            {#each draft.servings as serving, index}
              <li>
                <button
                  class="saved-serving"
                  class:editing={draft.editingIndex === index}
                  aria-label={`Edit serving ${index + 1}`}
                  aria-pressed={draft.editingIndex === index}
                  disabled={!editable}
                  onclick={() => changeDraft(editServing(draft!, index))}
                >
                  <span class="serving-number">{index + 1}</span><span
                    class="saved-copy"
                    ><strong
                      >{plural(totalScoops(serving), 'scoop')} · {serving.container}</strong
                    ><span
                      >{draft.editingIndex === index
                        ? 'Editing now'
                        : `${mixText(serving)} · ${serving.toppings.length ? plural(serving.toppings.length, 'topping') : 'No toppings'}`}</span
                    ></span
                  >
                </button>
                <button
                  class="remove-serving"
                  aria-label={`Remove serving ${index + 1}`}
                  disabled={!editable}
                  onclick={() => removeServing(index)}
                  >{@render icon('trash')}</button
                >
              </li>
            {/each}
          </ol>
        </section>
      {/if}
      <section class="serving-card" aria-labelledby="serving-title">
        {#if !draft.submittedTicketId}
          <div class="serving-heading">
            <h1 id="serving-title">
              Serving {(draft.editingIndex ?? draft.servings.length) + 1}
            </h1>
            {#if editing}<span class="badge">Editing</span>{/if}
          </div>
          <fieldset disabled={!editable}>
            <legend class="sr-only">Flavors</legend>
            <div class="section-label">
              <h2>Flavors</h2>
              <div class="scoop-meter">
                <span class="meter-dots" aria-hidden="true"
                  >{#each [0, 1, 2, 3, 4] as n}<span
                      class:filled={n < totalScoops(draft.editor)}
                    ></span>{/each}</span
                ><span aria-live="polite" aria-label="Total scoops"
                  >{totalScoops(draft.editor)} / 5 scoops</span
                >
              </div>
            </div>
            <div class="flavor-rows">
              {#each flavors as flavor}
                {@const count =
                  draft.editor.flavors.find((p) => p.flavor === flavor)
                    ?.count ?? 0}
                <div class="flavor-row">
                  <span>{flavor}</span>
                  <div
                    class="flavor-counter"
                    role="group"
                    aria-label={`${flavor} scoops`}
                  >
                    <button
                      class="scoop-button minus"
                      aria-label={`Remove a ${flavor} scoop`}
                      disabled={!editable || count === 0}
                      onclick={() => changeScoops(flavor, -1)}>−</button
                    >
                    <span
                      class="scoop-count"
                      class:zero={count === 0}
                      aria-label={`${flavor} scoop count`}>{count}</span
                    >
                    <button
                      class="scoop-button plus"
                      aria-label={`Add a ${flavor} scoop`}
                      disabled={!editable ||
                        totalScoops(draft.editor) >= maxScoopsPerServing}
                      onclick={() => changeScoops(flavor, 1)}>+</button
                    >
                  </div>
                </div>
              {/each}
            </div>
            {#if totalScoops(draft.editor) >= maxScoopsPerServing}<p
                class="scoop-limit"
              >
                5 scoops is the most per serving. Remove one to change the mix.
              </p>{/if}
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>Container</legend>
            <div class="container-grid">
              {#each containers as container}<button
                  class="toggle"
                  aria-pressed={draft.editor.container === container}
                  onclick={() => changeEditor({ ...draft!.editor, container })}
                  >{container}</button
                >{/each}
            </div>
          </fieldset>
          <fieldset disabled={!editable}>
            <legend>Toppings <span>Optional</span></legend>
            <div class="topping-grid">
              {#each toppings as topping}{@const selected =
                  draft.editor.toppings.includes(topping)}<button
                  class="toggle topping"
                  aria-pressed={selected}
                  onclick={() =>
                    changeEditor({
                      ...draft!.editor,
                      toppings: selected
                        ? draft!.editor.toppings.filter((t) => t !== topping)
                        : [...draft!.editor.toppings, topping],
                    })}
                  ><span aria-hidden="true">{selected ? '✓' : '+'}</span
                  >{topping}</button
                >{/each}
            </div>
          </fieldset>
        {:else}
          <h1 id="serving-title">Submitted order</h1>
          <ol class="submitted-servings" aria-label="Submitted servings">
            {#each draft.servings as serving, index}<li>
                <strong
                  >Serving {index + 1} · {plural(totalScoops(serving), 'scoop')} ·
                  {serving.container}</strong
                >
                <p>
                  {mixText(serving)} · {serving.toppings.join(', ') ||
                    'No toppings'}
                </p>
              </li>{/each}
          </ol>
        {/if}
      </section>
    {:else}<section class="serving-card">
        <h1>Your serving</h1>
        <p>
          {viewState.phase === 'blocked'
            ? 'Resolve the storage issue to recover your order.'
            : 'Loading your order…'}
        </p>
      </section>{/if}

    <section class="order-tools">
      <button
        class="tools-toggle"
        aria-expanded={toolsOpen}
        aria-controls="order-tools-panel"
        onclick={toggleTools}
        >Order tools <span aria-hidden="true">{toolsOpen ? '−' : '+'}</span
        ></button
      >
      <div id="order-tools-panel" hidden={!toolsOpen}>
        <a class="queue-link" href="/queue/">Build queue</a>
        {#if queueNotice}<p role="status" aria-label="Queue synchronization">
            {queueNotice}
          </p>{/if}
        <section aria-labelledby="usb-title" class="tools-card">
          <h2 id="usb-title">Printer settings</h2>
          <p>
            {checkingPrinter
              ? 'Checking USB printer…'
              : printerStatus.ready
                ? 'USB printing ready'
                : 'Printer needs attention'}
          </p>
          <p>Orders print to the USB printer attached to this server.</p>
          <dl>
            <dt>Printer</dt>
            <dd>Star TSP143IIIU</dd>
            <dt>CUPS queue</dt>
            <dd>
              {printerStatus.queue ?? 'Unavailable until the service responds'}
            </dd>
          </dl>
          <p>{printerStatus.message}</p>
          <button
            class="secondary"
            onclick={checkPrinter}
            disabled={working || checkingPrinter}
            >{checkingPrinter ? 'Checking printer…' : 'Check printer'}</button
          >
          <details>
            <summary>Server setup</summary>
            <ol>
              <li>
                Connect the Star printer’s USB-B port to this server and power
                the printer on.
              </li>
              <li>
                Configure a local USB CUPS queue with the Star TSP100 Cutter
                driver. Set <code>ORDER_PAD_QUEUE</code> to that queue when starting
                the Order Pad service.
              </li>
              <li>
                Verify a CUPS test print, then open this server’s Order Pad
                address on your ordering device.
              </li>
            </ol>
            <p>
              Queue readiness and accepted submissions do not verify physical
              output. Check paper, power, USB, and pending CUPS jobs before
              reprinting.
            </p>
          </details>
          <details>
            <summary>Connection and local storage</summary>
            <p>
              {online ? 'Network available' : 'Device offline'} · {offlineStatus}
            </p>
            <p>
              Drafts and the last submitted receipt are saved in this browser.
              Printing requires this server. Keep one Order Pad tab open per
              station and preserve browser storage during recovery.
            </p>
          </details>
        </section>
        {#if draft && !draft.submittedTicketId}<details class="tools-card">
            <summary>Ticket preview</summary>
            <div aria-label="Preparation ticket preview">
              {#if preview.length}{@render receipt(preview)}{:else}<p>
                  {printProblem}
                </p>{/if}
            </div>
          </details>{/if}
        {#if viewState.ticket}<section class="tools-card">
            <h2>Last submitted order</h2>
            <p>
              #{viewState.ticket.reference} · {viewState.ticket.displayName}
            </p>
            <p>
              {last?.result?.status === 'accepted'
                ? `${last.reprint ? 'Reprint' : 'Order'} submitted — ${viewState.ticket.displayName}`
                : last?.result?.message}
            </p>
            <details>
              <summary>View last receipt</summary>
              <div aria-label="Last submitted ticket preview">
                {@render receipt(lastPreview)}
              </div>
            </details>
            <details>
              <summary>Print attempts ({viewState.attempts.length})</summary>
              <ol>
                {#each [...viewState.attempts].reverse() as attempt (attempt.id)}<li
                  >
                    <strong
                      >{attempt.reprint ? 'REPRINT' : 'ORDER'} · {attempt.mode ===
                      'linux-cups'
                        ? 'Server USB'
                        : `Previous ${attempt.mode} attempt`}</strong
                    >
                    <p>
                      {new Date(attempt.startedAt).toLocaleString()} · {attempt
                        .result?.status ?? 'Awaiting response'}
                    </p>
                    <p>
                      {attempt.result?.message ??
                        'Intent saved before sending.'}
                    </p>
                  </li>{/each}
              </ol>
            </details>
          </section>{/if}
        {#if draft && !recoveryNeeded}<button
            class="ghost"
            onclick={startNewOrder}
            disabled={working ||
              viewState.phase !== 'ready' ||
              (needsConfirmation && !outputConfirmed) ||
              (!draft.submittedTicketId &&
                !draft.servings.length &&
                !unfinished &&
                !draft.name)}>New order</button
          >{/if}
      </div>
    </section>
  </main>

  <footer class="builder-actions">
    {#if working}<p class="problem" role="status">
        {viewState.phase === 'saving' ? 'Saving order…' : 'Submitting order…'}
      </p>{:else if problem}<p class="problem" role="status" id="print-help">
        {problem}
      </p>{/if}
    <div class="serving-actions">
      <button
        class="ghost"
        onclick={() => draft && changeDraft(cancelServing(draft))}
        disabled={!editable || !unfinished}
        >{editing ? 'Cancel edit' : 'Cancel serving'}</button
      ><button class="secondary" onclick={addServing} disabled={!canSave}
        >{editing ? 'Save serving' : 'Add serving'}</button
      >
    </div>
    <button
      class="primary print-button"
      aria-describedby={problem ? 'print-help' : undefined}
      onclick={() => print(false)}
      disabled={!canSend || !editable || !prepared}
      >{working
        ? 'Submitting…'
        : servingCount > 1
          ? `Print order · ${servingCount} servings`
          : 'Print order'}</button
    >
  </footer>
</div>
