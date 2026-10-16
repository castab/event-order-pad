# Sign-in and account screens — implementation brief

Status: design handoff, not yet implemented. It redesigns the browser side of the authentication
added on this branch: `/login/`, `/enroll/`, `/recover/` and `/account/`. Server behaviour, security
rules and the terminal-only account administration stay as they are unless a section below says
otherwise. Where this brief and `AGENTS.md` disagree, `AGENTS.md` wins.

## What's in here

| Path | Route | What it is |
| --- | --- | --- |
| `screens/sign-in.dc.html` | `/login/` | Sign in. Phone layout below 900 px, split brand panel + form at 900 px and up. A `scenario` prop previews the error and Cloudflare-challenge states. |
| `screens/enroll-recover.dc.html` | `/enroll/`, `/recover/` | One screen with a `mode` prop (`enroll` / `recover`) and a `codeInLink` prop. Three steps: password → offer a passkey → done. |
| `screens/account.dc.html` | `/account/` | Account page, phone to laptop. Two-column grid from 860 px. Shows the “Confirm it’s you” dialog, unlock countdown, passkey add/remove and inline password change. |

Like the other screens in this folder, these `.dc.html` files are reference designs in a canvas
template syntax (`<x-dc>`, `<sc-if>`, `{{ }}`, `<x-import>`). They do not run here and must not be
imported. Read inline styles for spacing, colour and copy, `<style>` blocks for breakpoints, and the
`<script type="text/x-dc">` block for the reference behaviour. Rebuild in Svelte 5 with the
`design/tokens/tokens.css` variables. The DS `Button` / `Wordmark` / `Badge` are React components in
the source system: match their look in Svelte (pill buttons, uppercase letterspaced labels, the
self-hosted `static/logo.svg`), do not add React.

## Problems this fixes

- The current pages are unbranded forms on cream with browser-default blue links.
- “Sign in” and “Sign in with a passkey” look identical, so there is no obvious main action.
- The Turnstile widget is the most prominent thing on the page, and both buttons stay disabled
  with no explanation until it finishes.
- Errors appear below the buttons, often off screen on a phone.
- Enroll/recover show an empty-looking code field even though the code arrived in the link, and
  give the password rule only as a sentence.
- The account page shows a full re-login form at the top at all times, and the Add passkey /
  Change password buttons are silently disabled until it is used.
- “Account” is a loose text link in the builder and queue headers.

## Shared rules for all four screens

- Keep every security property in `AGENTS.md` invariant 14 and README “Authentication”:
  Turnstile stays required for login, enrollment, recovery and re-authentication; there is no
  browser account administration; session loss still waits for `holdActivity()`.
- Keep `holdActivity()` and `holdUpdates()` around every request, as the current forms do.
- Fields: 48 px tall, 10 px radius, 1.5 px `--olive-300` border, `--surface-card` fill, 16 px text
  (prevents iOS zoom). Real `<label for>` on every field. Touch targets ≥ 44 px.
- Errors go in a `role="alert"` banner **above** the form (rust border, light rust fill), and the
  offending fields get a rust border. Successes use a `role="status"` banner in `--olive-100`.
- Password fields have a show/hide button (`aria-pressed`, label “Show password” / “Hide
  password”). On sign-in, show “Caps Lock is on.” from `KeyboardEvent.getModifierState`.
- Copy follows `AGENTS.md`: sentence case, curly quotes and apostrophes.

## Turnstile

- Render with `appearance: 'interaction-only'` in `src/lib/auth/Turnstile.svelte`, so Cloudflare’s
  widget only appears when it needs the person to interact. Keep `theme: 'light'`.
- Reserve its slot below the password field so the layout does not jump if it does appear.
- Do not disable submit buttons while a token is pending. On press without a token, show the
  button’s busy label (“Checking…”), wait for the callback, then submit. If no token arrives within
  15 s, show “Couldn’t verify this browser. Check your connection and try again.” and reset.
- Keep the existing single-use token handling (`generation` bump after every attempt, the
  behaviour from “Keep Turnstile tokens ready until authentication submission”).
- Turnstile failures keep their current meaning: new sign-ins are blocked, existing sessions
  continue.

## `/login/` — sign in

Phone (< 900 px): olive band with the cream wordmark and “ORDER PAD”, then the form, max 400 px.
Wide (≥ 900 px): olive panel on the left (min 360 px / 44 %) with the wordmark and “Take orders,
print prep tickets and keep the scoop line moving.”; the form centred on the right.

Order of the form:

1. Heading “Sign in”, subline “For Fiona’s staff. Use the account set up for you on the station.”
2. Error / status banner slot.
3. **Sign in with a passkey**: full width, outlined pill with a key icon. Uses the existing
   `passkey/login/options` → `startAuthentication` → `passkey/login/verify` flow. While waiting,
   replace the form with a card: “Waiting for your passkey…”, “Use your fingerprint, face or
   device PIN when your phone or browser asks.”, and a Cancel button that aborts the WebAuthn
   ceremony and shows “Passkey sign-in was cancelled. Try again or use your password.”
4. Divider “or use your password”.
5. Username (`autocomplete="username webauthn"`, keep conditional mediation), Password.
6. Turnstile slot.
7. **Sign in**: the only filled primary button. Busy label “Signing in…”. Blank fields →
   “Enter your username and password.” without calling the server.
8. Footer: “First time here? **Set up your account**” → `/enroll/`, “Locked out? **Use a recovery
   code**” → `/recover/`, then “Codes come from whoever runs the station computer.”

On success keep `window.location.replace('/')`. Show “Signed in. Opening the order builder…”
for the moment before navigation.

## `/enroll/` and `/recover/`

Compact olive header (wordmark + “ORDER PAD”), content max 420 px.

| | Enroll | Recover |
| --- | --- | --- |
| Heading | Set up your account | Recover your account |
| Intro | Choose the password you’ll sign in with. | Choose a new password to get back in. |
| Code label | Invite code | Recovery code |
| Warning | — | “This replaces your password and removes your saved passkeys. You can add a passkey again right after.” |
| Button | Create account | Set new password |

- **Code**: the page already reads the code from the URL fragment and strips it. If a code was
  found, show an `--olive-100` row “Invite code added from your link ✓” with an “Enter a code
  instead” text button. Only show the code field when there was no fragment or the person asks
  for it; then use a monospace input and the hint “Paste the code from the link you were sent.”
- Below it: “Your username was set when this code was made. You’ll use it with this password to
  sign in.” (See “Optional: show the username” below.)
- **New password**: show/hide button, a 6 px meter that fills to 15 characters, and a live
  `aria-live="polite"` line: “At least 15 characters.” → “9 of 15 characters. 6 more to go.” →
  “✓ Long enough.” Hint: “A short phrase works well, like “mint chip on a waffle cone”. Spaces are
  fine.” Count with `Array.from` as `parsePassword` does.
- **Type it again**: live “The two passwords don’t match yet.” once the second field has text.
- The submit button stays disabled until the code is present, the password is 15–128 characters
  and both match. Server errors (expired or used code, rate limit) go in the banner. For an
  expired or used code, add: “Ask whoever runs the station for a new one.” Invite codes last
  24 hours and recovery codes 30 minutes (README), so say which.
- **After success** do not navigate immediately. The new session is fresh, so offer a passkey:
  “Your account is ready” / “You’re back in”, then a card “Sign in with one tap next time” with a
  “Name this device” field (default “This phone” on phones, “This computer” otherwise),
  **Add a passkey** and **Skip for now**. Adding uses the existing `passkey/register/*` endpoints.
  Then show “Passkey added” or “All set”, “Opening the order builder…”, and `replace('/')`.
  If adding fails, show the error with **Skip for now** still available. The account is already
  usable.

## `/account/`

- **Header**: the same olive header as the app, with the wordmark and nav links “Order builder”
  and “Now Scooping” (hidden below 860 px), plus a username button on the right (initial
  avatar, username, chevron) opening a menu with “Your account” and “Sign out”. Replace the loose
  “Account” links in `+page.svelte` and `queue/+page.svelte` with this same username menu.
- **Layout**: content max 1040 px. One column on phones in this order: identity, passkeys,
  password, signed-in, admin note. From 860 px use `grid-template-areas` with
  `"who keys" "sessions keys" "admin pass"` (not CSS `order`, invariant 13).
- **Identity card**: avatar initial, username, “Can take orders, print tickets and run the
  queue.”
- **Confirm it’s you**: remove the always-visible re-login form. When Add a passkey, Remove or
  Change password is pressed and `authenticatedAt` is older than 5 minutes, open a modal dialog
  (`role="dialog"`, `aria-modal`, focus trapped, Escape closes): “Confirm it’s you”, “To
  {add a passkey | remove a passkey | change your password}, confirm your identity. Changes stay
  unlocked for 5 minutes.”, **Confirm with a passkey**, “or”, “Password for {username}”, Confirm and
  Cancel. Reuse `LoginForm` with `reauthenticate` (including Turnstile) inside it. On success,
  refresh the session and continue straight into the action that was pressed.
- **Unlock pill**: while within 5 minutes of `authenticatedAt`, show “Changes unlocked · N min left”
  with **Lock now** next to the heading. Derive N from `authenticatedAt`, not a local timer
  start. “Lock now” only hides the pill and closes open forms locally (there is no server lock),
  so the next sensitive action asks again. Say so in a code comment.
- **Passkeys**: heading, **Add a passkey** (secondary, small), one-line explanation. Each row:
  key icon, name, “Added {date}” from `PasskeySummary.createdAt`, **Remove**. Remove opens an
  inline confirm “Remove “{name}”? It won’t be able to sign you in any more.” with **Remove
  passkey** (rust) and **Keep it**. Add opens an inline “Name this device” field with
  **Continue** / Cancel. Empty state: “No passkeys yet. You sign in with your password.”
- **Password**: **Change password** opens the inline form (New password with the same 15-character
  counter, Type it again, **Save new password**, Cancel). The note “Changing it signs you out on
  your other devices.” is shown while closed. Success: “Password changed. You’ve been signed out on
  your other devices.”
- **Signed in**: “You’ll stay signed in on this device until {expiresAt, local time}.”, **Sign out**
  (secondary) and **Sign out everywhere** (ghost), plus “Use “Sign out everywhere” if you left
  yourself signed in on a shared tablet.” Check what `logout-all` does to the current session
  and word the success message to match.
- **Admin note**: dashed card: “Adding staff or locked out?” / “New accounts, recovery codes and
  turning accounts off are handled on the station computer. Ask whoever runs it.” No browser
  administration.

## Optional: show the username on enroll/recover

To greet the person (“Welcome, maria”), add `POST /api/auth/code/preview` taking `{ kind, token }`
and returning `{ username, expiresAt }` for a valid, unexpired, unused code, without consuming it.

- It must be public (like the other auth endpoints), rate-limited with the same buckets as
  enroll/recover, and listed in the `http.ts` Origin/Content-Type guard (invariant 10).
- Return the same generic error for unknown, used and expired codes.
- Only do this if the owner agrees. Without it, keep the sentence about the username already
  being set.

## Labels the tests use

`tests/auth.spec.ts` finds controls by role and label. These change, so update the tests in the
same commit:

| Old | New |
| --- | --- |
| `Enrollment code` | `Invite code` (only visible when no code was in the link) |
| `Confirm password` | `Type it again` |
| `Passkey name` | `Name this device` |
| link `Account` | button `{username}` opening a menu with `Your account` |
| `Confirm password` / `Confirm with passkey` (re-auth buttons) | inside the “Confirm it’s you” dialog: `Confirm`, `Confirm with a passkey` |

Unchanged: `Username`, `Password`, `New password`, `Sign in`, `Sign in with a passkey`,
`Create account`, `Add a passkey`, `Sign out`.

Add tests for: no Turnstile token yet → pressing Sign in waits rather than failing; the passkey
offer after enrollment (add and skip); the confirm dialog appearing only when re-authentication
is older than 5 minutes and continuing into the pressed action; the code row versus the code
field depending on the URL fragment; and the account layout at 390×844 and 1280×800.

## Out of scope

- Browser account creation, disabling, listing or recovery (terminal only, invariant 14).
- Changing session length, rate limits, password rules or the Turnstile requirement.
- Email or SMS delivery of codes.
