# Order builder, prep ticket & build queue — implementation brief

> **Status (2026-10-12): implemented.** All three suggested phases are built. This brief is kept as the original handoff and the source of the ordering rules and layout intent. Where it and the code differ, the code and [README](../README.md) are authoritative. Known differences:
>
> - The build queue screen is titled **Now Scooping** (route `/queue/`), not "BUILD QUEUE".
> - The queue uses Server-Sent Events (`GET /api/orders/events`) rather than polling, and queue visibility can be switched off while event capture continues with `ORDER_PAD_TRACKING_ENABLED=false`.
> - The UI prints only through the Linux CUPS service; the PassPRNT path mentioned below is no longer selectable, so order registration commits atomically with print intent through `POST /api/station`. Postgres on the app host owns drafts, counters, tickets, attempts and dispatch records; database failure blocks order work. The browser has no persistence or outbox.
> - Postgres stores independent anonymous browser workspaces. Only order numbering is global; the service assigns a number atomically with print intent. Same-workspace revision checks reject stale tabs.
> - `design/tokens/tokens.css` is imported by the app at runtime; the rest of this folder is reference only.
> - The header shows **New order** until the service assigns a number when the order is committed for printing, and only then `Order #0043`.
> - The “Shared order store” section below is the original proposal. Order events live in Postgres (`order_events`, append-only, latest event wins), not on disk. The queue never polls. The builder never calls `POST /api/orders`; the first order is recorded by `POST /api/station`. `GET`/`POST /api/orders*` remain for diagnostics and same-origin clients.
> - Tickets stored in IndexedDB (the “legacy history” discussion below) are no longer used. Only `schema: 2` tickets parse; v1 `items` data is rejected and never imported.

This folder is the design handoff for the order builder and build queue: touch order entry that prints a
preparation ticket, plus a second screen where the build station tracks open orders and marks
them done. It replaces handwritten notepad orders with a fixed, repeatable format.

## What's in here

| Path | What it is |
| --- | --- |
| `screens/order-builder.dc.html` | Order-taking screen. Responsive: phone (S10e, 390×844), tablet (820 wide) and laptop (1280 wide) layouts in one file; breakpoints in its `<style>` block. |
| `screens/prep-ticket.dc.html` | The printed ticket, 80 mm roll, designed at 576 px wide (72 mm printable at 203 dpi). |
| `screens/build-queue.dc.html` | Build-station queue, landscape tablet (designed at 1180×820). |
| `tokens/tokens.json`, `tokens/tokens.css`, `tokens/bundle.css` | Fiona's Ice Cream design system values: colors, type, spacing, radii, shadows. |

**The `.dc.html` files are reference designs, not code to ship.** They were made in a design
canvas and use its template syntax (`<x-dc>`, `<sc-for>`, `<sc-if>`, `{{ hole }}`,
`<x-import component-from-global-scope=…>` for design-system components, `./support.js`). They
will not render on their own. Read them for:

- exact layout, spacing, colors and copy (inline `style` attributes use the token CSS variables);
- states and conditional UI (`<sc-if>` blocks);
- behavior: the `<script type="text/x-dc">` block at the bottom of each file is a working
  reference implementation of the screen logic (validation, editing, toast, queue).

Rebuild them as Svelte components in this app. Do not import the `.dc.html` files or add a
React runtime. The design system's `Button`, `Badge`, `Input`, `Card` and `Wordmark` are React
components in the source system; recreate their look in Svelte from the tokens (pill buttons,
16 px cards, 10 px inputs, Poppins). The Wordmark is supplied logo art — ask the owner for
`logo.svg` rather than typesetting the brand name.

Keep everything in `README.md` → "Printing and reliability" and the invariants in `AGENTS.md`
true. In particular: tickets stay immutable, intent is saved before any send, real mode never
falls back to simulation, and reprints keep the original ticket ID.

## Ordering rules (source of truth)

Soft serve is not offered for now.

**A serving is one cup or cone.**

- **Flavors:** Chocolate, Vanilla, Strawberry, Chocolate Chip. Each flavor has its own − and +
  controls, so flavors can be mixed in one serving.
- **Scoops:** 1–5 total per serving, counted across all flavors (2 Chocolate Chip + 1 Strawberry
  = 3). The editor starts at 0; at least one scoop is required. At 5, every + is disabled until a
  scoop is removed.
- **Container:** exactly one of Cup, Cake Cone, Sugar Cone. None is preselected.
- **Toppings:** optional, any combination of Whipped cream, Gummy Bears, Caramel Sauce,
  Chocolate Sauce, Sliced Almonds, Maraschino Cherries, Rainbow Sprinkles, and Chocolate
  Sprinkles. With none selected the ticket prints "No toppings".

**Orders.**

- Up to 30 servings per order, also subject to the ticket's maximum printable length.
- Single-serving order: configure the serving and press **Print order**. Printing includes the
  serving currently being edited.
- Multi-serving order: press **Add serving** after each serving to save it and start the next;
  configure the last one, then **Print order**.
- Saved servings can be edited or removed before printing. While editing, **Save serving**
  replaces that serving, and **Print order** prints the replacement (never a duplicate).
- **Cancel serving** clears the unfinished serving. While editing, it becomes **Cancel edit** and
  discards the edit, leaving the saved serving as it was.
- **Validation:** every serving needs ≥1 scoop and a container. An incomplete serving blocks
  Add serving and Print order and must be finished or cancelled. Show what's missing
  ("To finish this serving: add at least one scoop and choose a container.").
- **Customer name:** optional, ≤80 printable characters (strip control characters). If blank,
  use a stable two-word label (below).
- Editable orders display “New order”; draft previews and blank-name placeholders display “Assigned when printed”. The service assigns the number and resolves the blank-name label only when committing the order for printing.
- Separate browser profiles can edit independently. An automatic persistent opaque cookie restores each profile’s database draft and latest receipt; there is no station setup. Tabs in the same profile share a workspace.
- Concurrent printing is serialized, with up to eight waiting requests and a 30-second slot timeout. Pending CUPS jobs receive a further 30-second wait; timeout means nothing was submitted. Waiting requests never replay after restart.
- No prices or payments anywhere.
- After printing, **Reprint last order** prints the previous ticket again with the REPRINT marker
  and the same ticket ID.

### Blank-name label

Friendly adjective + ice-cream noun, derived from a hash of the ticket's random ID so each
order gets an unpredictable label that is still stable across reprints and reloads:

```ts
const ADJ = ['Happy','Sunny','Jolly','Cheery','Lucky','Cozy','Breezy','Bouncy','Friendly','Merry','Peppy','Snazzy'];
const NOUN = ['Sprinkle','Waffle','Cherry','Scoop','Sundae','Cone','Swirl','Fudge','Gumdrop','Almond','Caramel','Gummy Bear'];
// FNV-1a 32-bit hash of the ticket ID, spread over all 144 pairs
const pick = fnv1a(ticketId) % (ADJ.length * NOUN.length);
const label = `${ADJ[Math.floor(pick / NOUN.length)]} ${NOUN[pick % NOUN.length]}`;
```

Store the resolved display name on the ticket at creation so it never depends on recomputing.

## Domain changes (`src/lib/tickets/`)

The current `TicketItem { name, quantity, modifiers[], instructions? }` can't express the
servings rules. Replace it with structured servings. Keep `parseTicket` as the single validating
entry point and keep everything frozen.

```ts
export const FLAVORS = ['Chocolate', 'Vanilla', 'Strawberry', 'Chocolate Chip'] as const;
export const CONTAINERS = ['Cup', 'Cake Cone', 'Sugar Cone'] as const;
export const TOPPINGS = ['Whipped cream', 'Gummy Bears', 'Caramel Sauce', 'Chocolate Sauce',
  'Sliced Almonds', 'Maraschino Cherries', 'Rainbow Sprinkles', 'Chocolate Sprinkles'] as const;

export interface Serving {
  readonly flavors: readonly { flavor: Flavor; count: number }[]; // menu order, counts ≥1, sum 1–5
  readonly container: Container;
  readonly toppings: readonly Topping[];                          // menu order, no duplicates
}

export interface OrderTicket {
  readonly id: string;
  readonly createdAt: string;      // ISO UTC, as today
  readonly reference: string;      // e.g. "0043"
  readonly customerName?: string;  // what was typed, ≤80
  readonly displayName: string;    // customerName or the blank-name label
  readonly servings: readonly Serving[]; // 1–30
}
```

- Validation in `parseTicket`: known values only; scoop totals 1–5; 1–30 servings; flavors and
  toppings normalized to menu order so identical orders always serialize identically.
- Tickets already stored in IndexedDB use the old `items` shape. Either version the schema
  (`schema: 2`) and keep a read-only parser for v1 history, or document a one-time reset. Don't
  let old records crash history.
- `sampleTicket()` should become the #0043 order shown in `screens/prep-ticket.dc.html`.
- The order reference needs a persistent, increasing counter in Postgres on the app host.

## The prep ticket (`formatTicket` and the PassPRNT/PDF renderers)

Layout, top to bottom (see `screens/prep-ticket.dc.html`):

1. REPRINT banner (reprints only): inverse block, "REPRINT", "Check for the first copy before
   building".
2. "PREP TICKET" and the local date/time (e.g. `Sun 10/11 · 7:42 PM`, station local time
   rather than UTC).
3. Order number, very large (`#0043`).
4. Display name, large, uppercase.
5. Totals box: `3 SERVINGS | 7 SCOOPS`.
6. Heavy rule, then one block per serving, always in this field order:
   - `SERVING 1 OF 3` (no tick box; orders are small enough to build without checking off servings)
   - scoop total in an inverse tag + container: `[3] SCOOPS · SUGAR CONE`
   - one line per flavor: `2 × Chocolate Chip`
   - `TOPPINGS` + comma list, or `No toppings`
   - dashed rule between servings, heavy rule after the last
7. `END OF TICKET` and the ticket ID.

Black on white only (thermal). The 42-column text layout should follow the same order using
ASCII separators, e.g.:

```
PREP TICKET               SUN 10/11 7:42 PM
ORDER #0043
MARIA
3 SERVINGS | 7 SCOOPS
==========================================
SERVING 1 OF 3
    3 SCOOPS - SUGAR CONE
    2 x Chocolate Chip
    1 x Strawberry
    TOPPINGS: Whipped cream, Chocolate Sauce
------------------------------------------
```

Enforce a maximum ticket length (lines or rendered height) and block **Print order** with a
clear message when an order would exceed it, even under 30 servings.

## Order builder screen (`src/routes/+page.svelte` or a new route)

See `screens/order-builder.dc.html`.

### Responsive layout

The builder must work on phones and on wider screens (tablets, laptops) from one component.
Use CSS breakpoints, not separate pages or user-agent sniffing. The layout CSS is the
`.ob-*` rules in the design file's `<style>` block.

| Width | Layout |
| --- | --- |
| < 760 px (phones) | One scrolling column: customer name and saved servings, then the serving editor. The action bar (status line, Cancel/Add, Print order) is sticky at the bottom of the screen. |
| ≥ 760 px (tablets, small laptops) | Two columns filling the viewport under the header. Left: the serving editor, scrolling on its own, max 880 px wide. Right: a 340–400 px "This order" panel with order summary, name, saved servings (scrolls) and the action bar pinned to the bottom of the panel. When nothing is saved, the panel shows "Servings you add show up here. For a one-serving order, just press Print order." |
| ≥ 1100 px (laptops) | Same two columns; flavor rows go to 2 columns and toppings to 3. |

- The toast spans the width under the header on phones. On wide screens it sits top-right, 380 px wide.
- Size the app shell with `100dvh` so mobile browser toolbars don't hide the action bar.
  Respect `env(safe-area-inset-bottom)` on the sticky bar.
- Keep DOM order equal to reading order on every layout, so keyboard and screen-reader order
  stay sensible: header → name + saved servings → serving editor → actions. Place them with
  `grid-template-areas` per breakpoint instead of CSS `order`. The design file uses
  `display: contents` + `order` for the phone case only because of the canvas it was drawn in.
- Touch targets stay ≥ 44 px at every size; don't shrink controls on wide screens.
- Playwright: run the builder tests at 390×844, 820×1180 and 1280×800.

Structure:

- **Header** (olive): logo, `ORDER #0043`, and a reprint icon button (disabled until something
  has printed; `aria-label="Reprint last order"`).
- **Customer name** input with hint "Left blank, the ticket says “Sunny Caramel”" (live label).
- **Saved servings** list: number, `3 scoops · Sugar Cone`, flavor mix + topping count; tap to
  edit (highlighted "Editing now"), trash button to remove. Shows `n of 30`. Hidden when empty.
- **Serving editor** card titled "Serving N":
  - Flavors: four rows, name + − count + (44 px round buttons); 5-dot scoop meter and
    `3 / 5 scoops`; at 5, the note "5 scoops is the most per serving. Remove one to change the mix."
  - Container: three equal toggle buttons.
  - Toppings: 2-column toggle grid, marked Optional.
- **Bottom bar**: red status line when the serving is incomplete; row of
  `Cancel serving | Add serving` (or `Cancel edit | Save serving`); full-width **Print order**
  (`Print order · 3 servings` when more than one).
- Tapping a saved serving while a new serving is half-built does nothing (protects the draft);
  finish or cancel it first.
- **On print:** don't navigate. Save intent and send through the existing session/port, then
  immediately reset to a new order (next reference, blank name, no servings) and show a toast
  under the header: "Order #0043 sent to the printer" / "Maria · 3 servings · 7 scoops", with
  **Reprint** and dismiss, auto-hiding after ~6 s. A reprint shows "Reprint of #0043 sent /
  Marked REPRINT on the ticket".

  Real printing results are accepted/failed/unknown. The design shows the accepted case. A
  failed or unknown result must not silently vanish: keep the existing recovery UI and show the
  toast in an error tone with the recovery action instead.

- Touch targets ≥44 px; every toggle is a real `<button aria-pressed>`; the scoop count is
  announced (`aria-live`).

## Build queue screen (new route, e.g. `/queue`)

See `screens/build-queue.dc.html`.

- **Header:** logo, "BUILD QUEUE", and counts: open orders, servings to build, oldest wait.
- **Packed columns of open orders**, oldest first, with no gaps under short cards. A plain CSS
  grid leaves holes because each row is as tall as its tallest card. Instead:
  - Render N column stacks (flex column, 20 px gap), with N from the container width: 1 below
    640 px, 2 below 1000 px, 3 below 1500 px, otherwise 4. Three on a landscape tablet.
  - Place cards in age order. Each card goes into the currently shortest column, leftmost on
    ties, so the first row reads oldest → newer left to right and older orders sit higher.
  - Use real card heights (Svelte `bind:clientHeight` or a `ResizeObserver`). The design file
    estimates heights only because it can't measure.
  - Re-pack only when the set of open orders or the column count changes, not on the 30-second
    age refresh. Expect cards to shift when one is marked done; that's fine.
  - Don't use CSS multi-column (`columns: 3`): it fills top-to-bottom, so the oldest orders
    would all stack in the first column. Don't rely on `grid-template-rows: masonry`; browser
    support is too thin.
  - Keep DOM order = age order for keyboard and screen readers (visually-hidden ordered list,
    or `aria-posinset`/`aria-setsize` on each card).

  Each card shows:
  - order number, display name, time placed;
  - a wait badge that names the time and is tinted by age (moss under 5 min, olive 5–10, rust
    10+);
  - servings listed in ticket order. Each serving shows:
    - a headline: `3 scoops · Sugar Cone`;
    - one rounded chip per flavor, each with a dark count bubble (`[2] Chocolate Chip`);
    - one chip per topping. Topping chips use a different shape from flavor chips (6 px
      radius, olive outline, leading `+` icon), so the two never read as one list.
    - A serving with no toppings shows a single dashed, muted "No toppings" chip.
    - Never join toppings or flavors into one comma-separated line. Chips wrap onto new lines
      but never split a name (`white-space: nowrap` inside each chip).
    - Render each set as a `<ul>` with `aria-label` "Flavors" / "Toppings" so screen readers
      announce the count of each.
  - **Mark #0043 done**, a single tap with no confirmation.
- **Recently done** strip along the bottom (last ~8) with **Undo** to reopen a mistaken tap.
- **Empty state:** "All caught up / New orders show up here the moment they print."
- Ages refresh at least every 30 s.

**Rules:**

- An order appears when it is first submitted for printing.
- A reprint never adds a card and never reopens a done order.
- Key everything by ticket ID; the first print upserts, later ones are no-ops.

### Shared order store

The builder (phone) and the queue (tablet) are different devices, so IndexedDB can't be the
source of truth for the queue. Use the Linux printer service, which already serves the app and
keeps a durable journal:

- `POST /api/orders` — idempotent upsert by ticket ID; body is the validated ticket. Created as
  `open`. An existing ID is left unchanged, which covers reprints.
- `GET /api/orders?status=open` (plus recent `done`) — for the queue; poll every 2–5 s, or use
  Server-Sent Events.
- `POST /api/orders/:id/done` and `POST /api/orders/:id/reopen` (undo).
- Persist to disk like the existing attempt journal so a restart doesn't lose the queue.
- The CUPS path can record the order when the print is submitted. The PassPRNT path never touches
  the service, so the builder must also `POST /api/orders` (same origin) when it saves print
  intent. If that call fails, the ticket still prints; retry the upsert in the background.
- Consider moving reference-number assignment to the service so two order-taking phones can't
  issue the same number.

## Suggested phases

1. **Domain + ticket:** new `Serving`/`OrderTicket` model, validation, blank-name label,
   `formatTicket` and the PassPRNT/PDF layouts, legacy history handling. Unit tests for every rule
   above.
2. **Order builder UI:** editor, saved servings, edit/cancel/save, print + toast + reprint,
   wired to the existing session and port. Playwright tests for single-serving, multi-serving,
   edit-then-print (no duplicate), incomplete-blocks-print, 5-scoop cap, 30-serving cap.
3. **Build queue:** service endpoints and persistence, `/queue` route, reprint-doesn't-reopen
   test, undo test.

Keep `npm run check`, `lint`, `test`, `build`, `build:printer` and `test:e2e` passing at every
phase.
