import { adminDocument } from './admin-page';
import { maxChoiceDescription, maxChoiceName } from '../src/lib/tickets/menu';

const sections = [
  { category: 'flavor', title: 'Flavors', one: 'flavor' },
  { category: 'container', title: 'Containers', one: 'container' },
  { category: 'topping', title: 'Toppings', one: 'topping' },
] as const;

/** The tailnet menu editor: every change names the revision it saw and runs once. */
export function menuPage(nonce: string, host: string) {
  return adminDocument({
    nonce,
    host,
    title: 'Menu',
    body: `<main>
<div class="column">
<section class="card" aria-labelledby="menu-title">
<div class="top">
<span id="badge" class="badge">Checking</span>
<button type="button" class="link" id="refresh"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>Check again</button>
</div>
<div class="status" role="status">
<h2 id="menu-title">Menu choices</h2>
<p class="detail">Order pads pick up changes within a few seconds. Printed tickets and the queue keep the names they were printed with.</p>
<p class="small" id="checked"></p>
</div>
<div class="actions"><button type="button" class="primary large" id="retry" hidden>Try again</button></div>
</section>
<p class="note notice" id="notice" hidden></p>
<section class="alert" id="alert" role="alert" hidden>
<span class="alert-title"><svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/></svg><span id="alert-title"></span></span>
<p class="body" id="alert-text"></p>
<button type="button" class="danger-solid" id="check-status">Check the menu</button>
</section>
<section class="card" id="add-card" aria-labelledby="add-title" hidden>
<h2 class="eyebrow" id="add-title">Add a choice</h2>
<form class="add" id="add-form" novalidate>
<div class="field"><label for="add-category">Category</label>
<select id="add-category">${sections.map((s) => `<option value="${s.category}">${s.title.slice(0, -1)}</option>`).join('')}</select></div>
<div class="field"><label for="add-name">Name</label>
<input id="add-name" type="text" maxlength="${maxChoiceName}" autocomplete="off" aria-describedby="name-hint"></div>
<div class="field"><label for="add-description">Description <span class="small">(optional)</span></label>
<textarea id="add-description" maxlength="${maxChoiceDescription}"></textarea></div>
<p class="small" id="name-hint">Names print on tickets exactly as written, up to ${maxChoiceName} characters. New choices go to the end of their list.</p>
<button type="submit" class="primary large" id="add" disabled>Add choice</button>
</form>
</section>
${sections
  .map(
    (
      s,
    ) => `<section class="card" id="${s.category}-card" aria-labelledby="${s.category}-title" hidden>
<div class="top">
<h2 class="eyebrow" id="${s.category}-title">${s.title}</h2>
<span id="${s.category}-count" class="badge">None</span>
</div>
<ul class="items" id="${s.category}-list"></ul>
<p class="small" id="${s.category}-empty">No ${s.title.toLowerCase()} on the menu.</p>
</section>`,
  )
  .join('\n')}
<p class="footnote"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>Only admin-tagged devices on the station’s tailnet can open this page. Each change runs once and is never retried. Removing a choice asks first.</p>
</div>
</main>
<dialog id="edit" aria-labelledby="edit-title">
<form method="dialog" id="edit-form" novalidate>
<h2 id="edit-title">Edit choice</h2>
<div class="field"><label for="edit-name">Name</label>
<input id="edit-name" type="text" maxlength="${maxChoiceName}" autocomplete="off"></div>
<div class="field"><label for="edit-description">Description <span class="small">(optional)</span></label>
<textarea id="edit-description" maxlength="${maxChoiceDescription}"></textarea></div>
<p class="small">A new name applies to orders started from now on. Printed tickets keep the old one.</p>
<div class="row">
<button type="button" class="ghost" id="edit-cancel">Cancel</button>
<button type="submit" class="primary" id="edit-save">Save</button>
</div>
</form>
</dialog>
<dialog id="confirm" aria-labelledby="confirm-title">
<form method="dialog">
<h2 id="confirm-title"></h2>
<p class="detail">It disappears from every order pad within a few seconds. Orders already being built with it still print, and printed tickets keep it.</p>
<div class="row">
<button type="button" class="ghost" id="cancel">Cancel</button>
<button type="button" class="danger-solid" id="go">Remove</button>
</div>
</form>
</dialog>
`,
    script: `const $ = (id) => document.getElementById(id);
const sections = ${JSON.stringify(sections)};
const icons = {
  check: '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};
const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
const clock = (date) => date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const element = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const lost = 'The change may already have happened. Nothing was retried. Check the menu before trying again.';
let state = { kind: 'loading' };
let busy = false;
let editing;
let removing;
function render() {
  const s = state;
  const ready = s.kind === 'ready';
  const badge = $('badge');
  badge.className = 'badge' + (busy ? ' busy' : ready ? ' active' : s.kind === 'unavailable' ? ' unavailable' : '');
  badge.textContent = busy ? 'Saving' : ready ? plural(s.choices.length, 'choice') : s.kind === 'unavailable' ? 'Can’t reach the station' : 'Checking';
  $('checked').textContent = busy ? 'Wait for the result. Don’t close this page.'
    : s.kind === 'unavailable' ? s.error
    : s.checkedAt ? 'Checked ' + clock(s.checkedAt) + '.' : '';
  $('retry').hidden = s.kind !== 'unavailable';
  $('add-card').hidden = !ready;
  $('add').disabled = busy || !ready || !$('add-name').value.trim();
  for (const id of ['refresh', 'retry', 'check-status', 'edit-save', 'go']) $(id).disabled = busy;
  for (const id of ['add-category', 'add-name', 'add-description']) $(id).disabled = busy || !ready;
  for (const section of sections) {
    $(section.category + '-card').hidden = !ready;
    if (!ready) continue;
    const items = s.choices.filter((c) => c.category === section.category);
    $(section.category + '-count').textContent = items.length ? String(items.length) : 'None';
    $(section.category + '-empty').hidden = items.length > 0;
    $(section.category + '-list').replaceChildren(...items.map((choice, index) => row(section, choice, index, items.length)));
  }
}
function row(section, choice, index, count) {
  const name = choice.data.displayName;
  const item = element('li', 'item');
  const who = element('span', 'who');
  who.append(element('span', 'name', name));
  if (choice.data.description) who.append(element('span', 'desc', choice.data.description));
  const buttons = element('span', 'choice-buttons');
  const button = (label, className, text, action, disabled) => {
    const b = element('button', className, text);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.disabled = busy || disabled;
    b.addEventListener('click', action);
    return b;
  };
  buttons.append(
    button('Move ' + name + ' up', 'secondary icon', '↑', () => change({ command: 'move', id: choice.id, direction: 'up' }, name + ' moved up.'), index === 0),
    button('Move ' + name + ' down', 'secondary icon', '↓', () => change({ command: 'move', id: choice.id, direction: 'down' }, name + ' moved down.'), index === count - 1),
    button('Edit ' + name, 'secondary', 'Edit', () => edit(choice), false),
    button('Remove ' + name, 'danger', 'Remove', () => ask(section, choice), section.category !== 'topping' && count === 1),
  );
  item.append(who, buttons);
  return item;
}
async function refresh() {
  if (busy) return;
  try {
    const response = await fetch('/api/admin/menu', { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '');
    accept(body);
  } catch (error) {
    state = { kind: 'unavailable', error: error.message || 'Check that the station and its database are running, then check again.' };
  }
  state.checkedAt = new Date();
  render();
}
function accept(body) {
  if (!body || !Number.isSafeInteger(body.revision) || !Array.isArray(body.choices)) throw new Error('The station sent an unexpected menu. Check again.');
  state = { kind: 'ready', revision: body.revision, choices: body.choices };
}
function showAlert(title, text) {
  $('alert-title').textContent = title;
  $('alert-text').textContent = text;
  $('alert').hidden = false;
}
function edit(choice) {
  if (busy || state.kind !== 'ready') return;
  editing = choice;
  $('edit-name').value = choice.data.displayName;
  $('edit-description').value = choice.data.description || '';
  $('edit').showModal();
}
function ask(section, choice) {
  if (busy || state.kind !== 'ready') return;
  removing = choice;
  $('confirm-title').textContent = 'Remove ' + choice.data.displayName + '?';
  $('go').textContent = 'Remove ' + section.one;
  $('confirm').showModal();
}
async function change(payload, done) {
  if (busy || state.kind !== 'ready') return false;
  busy = true;
  $('notice').hidden = true;
  $('alert').hidden = true;
  render();
  let ok = false;
  try {
    const response = await fetch('/api/admin/menu', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, revision: state.revision, requestId: crypto.randomUUID() }),
      signal: AbortSignal.timeout(30000),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!body || (!response.ok && typeof body.error !== 'string')) showAlert('The station didn’t answer', lost);
    else if (!response.ok) showAlert('Check before trying again', body.error);
    else {
      accept(body);
      state.checkedAt = new Date();
      $('notice').innerHTML = icons.check;
      $('notice').append(element('span', '', done));
      $('notice').hidden = false;
      ok = true;
    }
  } catch {
    showAlert('The station didn’t answer', lost);
  }
  busy = false;
  render();
  if (!ok) refresh();
  return ok;
}
$('add-name').addEventListener('input', render);
$('add-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const displayName = $('add-name').value.trim();
  if (!displayName) return;
  const category = $('add-category').value;
  if (await change({ command: 'add', category, displayName, description: $('add-description').value }, displayName + ' added.')) {
    $('add-name').value = '';
    $('add-description').value = '';
    render();
  }
});
$('edit-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const choice = editing;
  const displayName = $('edit-name').value.trim();
  if (!choice || !displayName) return;
  $('edit').close();
  editing = undefined;
  change({ command: 'edit', id: choice.id, displayName, description: $('edit-description').value }, displayName + ' saved.');
});
$('edit-cancel').addEventListener('click', () => { editing = undefined; $('edit').close(); });
$('cancel').addEventListener('click', () => { removing = undefined; $('confirm').close(); });
$('go').addEventListener('click', () => {
  const choice = removing;
  removing = undefined;
  $('confirm').close();
  if (choice) change({ command: 'remove', id: choice.id }, choice.data.displayName + ' removed.');
});
for (const id of ['refresh', 'retry', 'check-status'])
  $(id).addEventListener('click', () => { $('alert').hidden = true; refresh(); });
render();
refresh();
// Changes from another admin device show up without a tap while the page is open.
setInterval(() => {
  if (document.visibilityState === 'visible' && !busy && !$('confirm').open && !$('edit').open) refresh();
}, 10000);
`,
  });
}
