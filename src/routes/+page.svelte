<script lang="ts">
  import { onMount } from 'svelte';
  import { formatTicket } from '$lib/tickets/format';
  import { selectPrinter, realPrinterSupport } from '$lib/printing/select';
  import { PrintSession, type SessionState } from '$lib/printing/session';
  import type { TicketPrinter } from '$lib/printing/port';
  import type { SimulationScenario } from '$lib/printing/adapters/simulated';
  import { IndexedDbTicketStore } from '$lib/storage/ticket-store';
  import {
    passPrntReturn,
    cleanPassPrntReturn,
  } from '$lib/printing/adapters/passprnt';

  let viewState = $state<SessionState>({ phase: 'loading', attempts: [] });
  let session: PrintSession;
  let mode = $state<TicketPrinter['mode']>('simulated');
  let scenario = $state<SimulationScenario>('accepted');
  let unsupported = $state<string | undefined>();
  let setupConfirmed = $state(false);
  let reprintConfirmed = $state(false);
  let online = $state(true);
  let offlineStatus = $state('Checking offline availability…');
  let handoffLaunched = $state(false);
  const last = $derived(viewState.attempts[viewState.attempts.length - 1]);
  const preview = $derived(
    viewState.ticket
      ? formatTicket(viewState.ticket, last?.reprint ?? false)
      : [],
  );
  const ready = $derived(
    viewState.phase === 'ready' &&
      (mode === 'simulated' || (!unsupported && setupConfirmed)),
  );
  const needsConfirmation = $derived(
    last?.result?.status === 'outcome-unknown',
  );
  const working = $derived(
    viewState.phase === 'saving' ||
      viewState.phase === 'printing' ||
      viewState.phase === 'handoff',
  );

  onMount(() => {
    unsupported = realPrinterSupport();
    const updateOnline = () => {
      online = navigator.onLine;
    };
    updateOnline();
    window.addEventListener('online', updateOnline);
    window.addEventListener('offline', updateOnline);
    try {
      session = new PrintSession(new IndexedDbTicketStore(), (next) => {
        viewState = next;
      });
      const returned = passPrntReturn(location.href);
      void session.initialize(returned).then(() => {
        if (viewState.phase !== 'blocked')
          history.replaceState(
            history.state,
            '',
            cleanPassPrntReturn(location.href),
          );
      });
    } catch {
      viewState = {
        phase: 'blocked',
        attempts: [],
        notice:
          'IndexedDB is unavailable in this browser. Printing is blocked because tickets and attempts cannot be saved.',
      };
    }
    let cancelled = false;
    const checkCache = async () => {
      try {
        const names = await caches.keys();
        if (!cancelled)
          offlineStatus = names.some((name) => name.startsWith('order-pad-'))
            ? 'App assets cached · test reopening offline on this device'
            : 'Assets not cached yet · offline reopening unverified';
      } catch {
        if (!cancelled)
          offlineStatus = 'Offline cache unavailable in this browser';
      }
    };
    void checkCache();
    if ('serviceWorker' in navigator) {
      void navigator.serviceWorker.ready.then(checkCache);
    } else
      offlineStatus =
        'Service workers unavailable · offline reopening unsupported';
    return () => {
      cancelled = true;
      window.removeEventListener('online', updateOnline);
      window.removeEventListener('offline', updateOnline);
    };
  });

  async function print(reprint: boolean) {
    if (!ready || (reprint && needsConfirmation && !reprintConfirmed)) return;
    reprintConfirmed = false;
    handoffLaunched = false;
    await session.print(selectPrinter(mode, scenario), reprint);
  }
</script>

<svelte:head>
  <title>Order Pad · Ticket Test</title>
  <meta
    name="description"
    content="A preparation ticket printer test with explicit simulation and Star Android USB modes."
  />
</svelte:head>

<div class="app">
  <header>
    <div class="brand">
      <span class="brand-icon" aria-hidden="true">≡</span>
      <div><strong>Order Pad</strong><span>Preparation tickets</span></div>
    </div>
    <span class="milestone">MILESTONE 1 <span>·</span> PRINTER TEST</span>
  </header>
  <main>
    <div class="intro">
      <div>
        <p class="eyebrow">FROM THE COUNTER TO THE KITCHEN</p>
        <h1>Test a preparation ticket.</h1>
        <p>One sample order. One clear printer boundary. No checkout.</p>
      </div>
      <span class:real={mode === 'star-passprnt'} class="mode-badge"
        >{mode === 'simulated'
          ? 'SIMULATED · NO PHYSICAL PRINT'
          : 'REAL USB · DEVICE TEST REQUIRED'}</span
      >
    </div>

    <div class="workspace">
      <section class="controls" aria-labelledby="printer-title">
        <div class="section-heading">
          <span class="step">01</span>
          <div>
            <h2 id="printer-title">Printer &amp; transport</h2>
            <p>Choose where this test ticket goes.</p>
          </div>
        </div>
        <label for="printer">Printer mode</label>
        <select
          id="printer"
          bind:value={mode}
          disabled={working}
          onchange={() => {
            setupConfirmed = false;
            reprintConfirmed = false;
          }}
        >
          <option value="simulated">Simulated printer — no hardware</option>
          <option value="star-passprnt"
            >Star TSP143IIIU — USB-B / PassPRNT</option
          >
        </select>
        {#if mode === 'simulated'}
          <div class="status good">
            <span class="dot"></span>
            <div>
              <strong>Simulation ready</strong>
              <p>
                Renders the ticket and saves the attempt. Nothing is physically
                printed.
              </p>
            </div>
          </div>
          <label for="scenario">Simulate an outcome</label>
          <select id="scenario" bind:value={scenario} disabled={working}>
            <option value="accepted">Accepted</option><option value="failed"
              >Failed · paper out</option
            ><option value="outcome-unknown">Unknown · response missing</option>
          </select>
        {:else}
          <div class="status caution">
            <span class="dot"></span>
            <div>
              <strong
                >{unsupported
                  ? 'Unsupported runtime'
                  : 'Android eligible · connection unverified'}</strong
              >
              <p>
                {unsupported ??
                  'Star PassPRNT handles USB permission and printing. Installation and device connection have not been verified by this page.'}
              </p>
            </div>
          </div>
          <div class="setup">
            <h3>USB setup</h3>
            <ol>
              <li>
                Install Star Quick Setup Utility and Star PassPRNT on the Galaxy
                S10e (Android 12).
              </li>
              <li>
                Connect the phone’s <strong>USB-C</strong> port through a USB
                host/OTG adapter and data cable to the printer’s
                <strong>USB-B</strong> port. Power the printer from mains.
              </li>
              <li>
                Grant Android USB access to Star’s apps. Verify a sample print
                in Quick Setup Utility, then select TSP100IIIU / USB in
                PassPRNT. Keep only this printer connected.
              </li>
              <li>
                Open this app’s HTTPS URL in Chrome. Save an attempt here, then
                tap the PassPRNT launch link once. Return to the same browser
                and origin for the result.
              </li>
            </ol>
            <label class="checkbox"
              ><input
                type="checkbox"
                bind:checked={setupConfirmed}
                disabled={!!unsupported || working}
              /><span>I completed USB permission and printer selection.</span
              ></label
            >
            <p class="small">
              If access was denied, reconnect and grant permission in
              Android/PassPRNT. The printer’s USB-A port only charges Android
              devices; USB-B does not charge the phone. Hardware and offline
              return still need testing.
            </p>
          </div>
        {/if}

        <div class="actions">
          {#if viewState.phase === 'handoff'}
            <div class="warning">
              <strong>Attempt saved · PassPRNT launch pending</strong>
              <p>
                Tap once to send this ticket through PassPRNT. Keep PassPRNT in
                the foreground until it returns. Error retry pop-ups are
                disabled.
              </p>
              {#if !handoffLaunched}
                <a
                  class="launch"
                  href={viewState.handoffUrl}
                  onclick={() => {
                    handoffLaunched = true;
                  }}>Open PassPRNT and print ↗</a
                >
              {:else}
                <p>
                  Launch requested. This page cannot confirm that PassPRNT
                  opened or printed.
                </p>
              {/if}
              <p>
                If no result returns, close PassPRNT and inspect the printer
                first. Recovering records an unknown outcome and never sends
                another ticket.
              </p>
              <button class="secondary" onclick={() => location.reload()}
                >Recover without resending</button
              >
            </div>
          {/if}
          <button
            class="primary"
            onclick={() => print(false)}
            disabled={!ready || viewState.attempts.length > 0}
            >{working
              ? viewState.phase === 'saving'
                ? 'Saving print attempt…'
                : viewState.phase === 'handoff'
                  ? 'Waiting for PassPRNT…'
                  : 'Sending test ticket…'
              : 'Print Test Ticket'}</button
          >
          {#if needsConfirmation}<div class="warning">
              <strong>Outcome unknown · duplicates are possible</strong>
              <p>
                Check the printer and kitchen before reprinting. There will be
                no automatic retry.
              </p>
              <label class="checkbox"
                ><input
                  type="checkbox"
                  bind:checked={reprintConfirmed}
                  disabled={working}
                /><span>I checked the output and want another ticket.</span
                ></label
              >
            </div>{/if}
          <button
            class="secondary"
            onclick={() => print(true)}
            disabled={!ready ||
              !viewState.attempts.length ||
              (needsConfirmation && !reprintConfirmed)}
            >Reprint Last Ticket</button
          >
          <p class="small">
            Every repeat is marked REPRINT and keeps the original ticket ID.
            Keep one Order Pad tab open per station.
          </p>
        </div>
        <div class="feedback" role="status" aria-live="polite">
          {#if viewState.notice}<strong>Storage needs attention</strong>
            <p>{viewState.notice}</p>
          {:else if viewState.phase === 'loading'}<p>
              Recovering the saved ticket…
            </p>
          {:else if viewState.phase === 'saving'}<strong
              >Saving print intent</strong
            >
            <p>No data has been sent yet.</p>
          {:else if viewState.phase === 'printing'}<strong
              >Attempt saved · awaiting response</strong
            >
            <p>Keep the printing application in the foreground.</p>
          {:else if viewState.phase === 'handoff'}<strong
              >Attempt saved · awaiting PassPRNT result</strong
            >
            <p>
              No successful print is claimed by preparing or opening the link.
            </p>
          {:else if last?.result}<strong
              >{last.result.status === 'accepted'
                ? 'Accepted'
                : last.result.status === 'failed'
                  ? 'Failed'
                  : 'Outcome unknown'}{last.result.simulated
                ? ' · SIMULATED'
                : ' · STAR USB'}</strong
            >
            <p>{last.result.message}</p>
          {:else}<p>Ticket saved locally. Ready for its first test.</p>{/if}
        </div>
      </section>

      <section class="preview-panel" aria-labelledby="preview-title">
        <div class="section-heading">
          <span class="step">02</span>
          <div>
            <h2 id="preview-title">Ticket preview</h2>
            <p>Illustrative data · 80 mm paper layout</p>
          </div>
        </div>
        <div class="paper">
          <div class="paper-caption">
            {last && last.mode !== 'simulated'
              ? 'TEXT PREVIEW · CHECK PHYSICAL OUTPUT'
              : 'SIMULATED PREVIEW · NOTHING PRINTED'}
          </div>
          <div class="receipt" aria-label="Preparation ticket preview">
            {#each preview as line, i (i)}<div
                class:heading={line.role === 'heading'}
                class:reference={line.role === 'reference'}
                class:reprint={line.role === 'reprint'}
                class:end={line.role === 'end'}
              >
                {line.text || '\u00a0'}
              </div>{/each}
          </div>
          <div class="cut-line">
            <span>✂</span> PARTIAL CUT AFTER END MARKER
          </div>
        </div>
      </section>
    </div>

    <section class="history" aria-labelledby="history-title">
      <div class="section-heading">
        <span class="step">03</span>
        <div>
          <h2 id="history-title">Saved print attempts</h2>
          <p>Recovered after reload on this browser and origin.</p>
        </div>
        <span class="count">{viewState.attempts.length}</span>
      </div>
      {#if !viewState.attempts.length}<p class="empty">
          No attempts yet. The sample ticket is saved before the first send.
        </p>{:else}<ol class="attempts">
          {#each [...viewState.attempts].reverse() as attempt (attempt.id)}<li>
              <div>
                <strong
                  >{attempt.reprint ? 'REPRINT' : 'TEST TICKET'} · #{viewState
                    .ticket?.reference}</strong
                ><span
                  >{attempt.mode === 'simulated'
                    ? 'Simulation'
                    : attempt.mode === 'star-usb'
                      ? 'Previous IV adapter'
                      : 'Star PassPRNT USB'} · {new Date(
                    attempt.startedAt,
                  ).toLocaleString()}</span
                >
              </div>
              <span
                class="outcome"
                class:unknown={attempt.result?.status === 'outcome-unknown'}
                >{attempt.result?.status ?? 'Awaiting response'}</span
              >
              <p>{attempt.result?.message ?? 'Intent saved before sending.'}</p>
            </li>{/each}
        </ol>{/if}
    </section>
    <footer>
      <span class="network"
        ><span class="dot" class:offline={!online}></span>{online
          ? 'Network available'
          : 'Device offline'}</span
      ><span>{offlineStatus}</span>
      <p>
        Chrome offline reopening and PassPRNT’s return must be tested on the
        Galaxy S10e. Local data can be removed by browser storage cleanup; this
        milestone has no cloud backup.
      </p>
    </footer>
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
  :global(select),
  :global(input) {
    font: inherit;
  }
  :global(button),
  :global(select),
  :global(a) {
    -webkit-tap-highlight-color: transparent;
  }
  :global(:focus-visible) {
    outline: 3px solid #c67c27;
    outline-offset: 4px;
  }
  .app {
    max-width: 1400px;
    margin: auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 24px 36px;
    border-bottom: 1px solid #d7ded2;
  }
  .brand {
    display: flex;
    gap: 12px;
    align-items: center;
  }
  .brand-icon {
    background: #174f45;
    color: #fff;
    width: 42px;
    height: 42px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    font-size: 32px;
  }
  .brand strong {
    display: block;
    font-size: 21px;
  }
  .brand div > span {
    font-size: 13px;
    color: #5c7166;
  }
  .milestone {
    font-size: 11px;
    letter-spacing: 1.5px;
    font-weight: 700;
    color: #5c7166;
  }
  .milestone span {
    padding: 0 6px;
  }
  main {
    padding: 38px 36px;
  }
  .intro {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 30px;
  }
  .eyebrow {
    font-size: 11px;
    font-weight: 750;
    letter-spacing: 1.5px;
    color: #537364;
  }
  h1 {
    font-size: clamp(26px, 3vw, 38px);
    letter-spacing: -1px;
    margin: 10px 0;
  }
  .intro p:last-child {
    color: #5c7166;
    margin-bottom: 0;
  }
  .mode-badge {
    flex-shrink: 0;
    border: 1px solid #bdd4c5;
    border-radius: 24px;
    background: #e2ede2;
    color: #28523d;
    padding: 12px 16px;
    font-size: 11px;
    letter-spacing: 0.6px;
    font-weight: 750;
  }
  .mode-badge.real {
    color: #805119;
    background: #fcf0d9;
    border-color: #e0c79c;
  }
  .workspace {
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(360px, 1fr);
    gap: 24px;
    align-items: start;
  }
  .controls,
  .history {
    border: 1px solid #d5ded2;
    border-radius: 18px;
    background: #fffef9;
    padding: 26px;
  }
  .section-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }
  .step {
    font-family: ui-monospace, monospace;
    font-size: 12px;
    padding: 9px;
    border: 1px solid #cfd9ce;
    border-radius: 8px;
    color: #647b68;
  }
  h2 {
    font-size: 19px;
    margin: 0 0 5px;
    letter-spacing: -0.3px;
  }
  .section-heading p {
    font-size: 13px;
    color: #687c6e;
    margin: 0;
  }
  label {
    display: block;
    font-size: 13px;
    font-weight: 650;
    margin-bottom: 8px;
  }
  select {
    display: block;
    width: 100%;
    padding: 14px 12px;
    min-height: 52px;
    background: #fff;
    border: 1px solid #bdcfc1;
    border-radius: 9px;
    font-size: 15px;
    color: #233b34;
  }
  .status {
    display: flex;
    gap: 11px;
    padding: 16px;
    border-radius: 10px;
    margin: 18px 0;
    font-size: 14px;
    background: #eef4ed;
  }
  .status p {
    margin: 6px 0 0;
    line-height: 1.5;
    font-size: 13px;
    color: #4d6757;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    background: #497b5a;
    border-radius: 50%;
    flex-shrink: 0;
    margin-top: 5px;
  }
  .caution {
    background: #fff0d8;
  }
  .caution .dot {
    background: #ad731e;
  }
  .setup {
    font-size: 14px;
    line-height: 1.6;
  }
  h3 {
    font-size: 15px;
  }
  .setup ol {
    padding-left: 22px;
  }
  .setup li {
    margin-bottom: 10px;
  }
  .launch {
    display: inline-block;
    color: #174f45;
    padding: 12px 0;
    font-weight: 650;
  }
  .checkbox {
    display: flex;
    gap: 12px;
    align-items: center;
    min-height: 52px;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
  }
  .checkbox input {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
    accent-color: #174f45;
  }
  .actions {
    border-top: 1px solid #e1e6dc;
    margin-top: 24px;
    padding-top: 24px;
  }
  button {
    width: 100%;
    min-height: 56px;
    border-radius: 10px;
    cursor: pointer;
    font-size: 16px;
    font-weight: 700;
    border: 1px solid #174f45;
  }
  .primary {
    background: #174f45;
    color: #fff;
    margin-bottom: 12px;
  }
  .secondary {
    background: transparent;
    color: #174f45;
  }
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .small {
    font-size: 12px;
    line-height: 1.6;
    color: #627369;
  }
  .feedback {
    background: #f1f4ed;
    border-radius: 10px;
    padding: 16px;
    font-size: 14px;
    margin-top: 18px;
  }
  .feedback p {
    margin: 6px 0 0;
    line-height: 1.6;
  }
  .warning {
    background: #fff0d8;
    border: 1px solid #dfc99f;
    border-radius: 10px;
    padding: 14px;
    margin-bottom: 12px;
    font-size: 14px;
    line-height: 1.5;
  }
  .warning p {
    margin: 8px 0;
  }
  .preview-panel {
    background: #e5eae0;
    padding: 26px;
    border: 1px solid #d5ded2;
    border-radius: 18px;
  }
  .paper {
    max-width: 430px;
    margin: 0 auto;
    background: #fffef9;
    box-shadow: 0 6px 22px #273b3212;
    padding: 24px 20px 0;
  }
  .paper-caption {
    text-align: center;
    font-size: 9px;
    font-weight: 750;
    letter-spacing: 0.8px;
    color: #69766d;
    margin-bottom: 25px;
  }
  .receipt {
    font:
      13px/1.65 ui-monospace,
      Consolas,
      monospace;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: #252d29;
  }
  .receipt .heading,
  .receipt .reference,
  .receipt .reprint,
  .receipt .end {
    text-align: center;
    font-weight: 800;
  }
  .receipt .heading {
    letter-spacing: 1px;
    margin-bottom: 10px;
  }
  .receipt .reference {
    font-size: 25px;
    margin-bottom: 14px;
  }
  .receipt .reprint {
    font-size: 24px;
    border: 2px solid #252d29;
    margin-bottom: 16px;
  }
  .receipt .end {
    margin: 18px 0;
  }
  .cut-line {
    border-top: 2px dashed #c8cfc5;
    font-size: 9px;
    color: #657269;
    letter-spacing: 0.5px;
    text-align: center;
    padding: 14px 0;
  }
  .cut-line span {
    margin-right: 6px;
    font-size: 15px;
  }
  .history {
    margin-top: 24px;
  }
  .history .section-heading {
    margin-bottom: 12px;
  }
  .count {
    margin-left: auto;
    border-radius: 30px;
    padding: 6px 12px;
    background: #e7eee3;
    font-size: 14px;
  }
  .empty {
    color: #718073;
    font-size: 14px;
    margin: 22px 0 4px;
  }
  .attempts {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .attempts li {
    padding: 18px 0;
    border-top: 1px solid #e2e7de;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
  }
  .attempts strong {
    font-size: 14px;
  }
  .attempts li div > span {
    display: block;
    margin-top: 5px;
    font-size: 12px;
    color: #677b6b;
  }
  .outcome {
    font-size: 12px;
    color: #3d5f46;
    padding: 7px 10px;
    background: #e9efe3;
    border-radius: 6px;
    align-self: start;
  }
  .outcome.unknown {
    background: #fff0d8;
    color: #805119;
  }
  .attempts p {
    grid-column: 1 / -1;
    font-size: 13px;
    margin: 0;
    line-height: 1.5;
    color: #556b5c;
  }
  footer {
    margin-top: 25px;
    display: flex;
    flex-wrap: wrap;
    gap: 10px 22px;
    color: #657a69;
    font-size: 12px;
  }
  footer p {
    flex-basis: 100%;
    margin: 0;
    line-height: 1.5;
  }
  .network {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .network .dot {
    margin: 0;
  }
  .dot.offline {
    background: #b57a32;
  }
  @media (max-width: 950px) {
    .intro {
      align-items: start;
      flex-direction: column;
    }
    .workspace {
      gap: 16px;
    }
    .controls,
    .preview-panel {
      padding: 20px;
    }
    header {
      padding: 20px 24px;
    }
    main {
      padding: 28px 24px;
    }
  }
  @media (max-width: 860px) {
    .workspace {
      grid-template-columns: 1fr;
    }
    .milestone {
      display: none;
    }
    main {
      padding: 24px 16px;
    }
    header {
      padding: 18px 20px;
    }
    .mode-badge {
      font-size: 10px;
    }
    .attempts li {
      grid-template-columns: 1fr;
    }
    .attempts p {
      grid-column: 1;
    }
    .outcome {
      justify-self: start;
    }
    .receipt {
      font-size: clamp(10px, 2.7vw, 13px);
    }
  }
</style>
