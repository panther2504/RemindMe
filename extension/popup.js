'use strict';

const core = window.RemindMeCore;
const $ = (id) => document.getElementById(id);
const WEEKDAYS = [1, 2, 3, 4, 5];

let state = { reminders: [], settings: {}, companion: {} };
let editingId = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function send(type, payload = {}) {
  const res = await chrome.runtime.sendMessage(Object.assign({ type }, payload));
  if (!res || !res.ok) throw new Error((res && res.error) || 'Unexpected error');
  return res.value;
}

const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const toTimeInput = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function relative(ms) {
  const diff = ms - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const text = mins < 60 ? mins + ' min' : mins < 2880 ? Math.round(mins / 60) + ' h' : Math.round(mins / 1440) + ' days';
  if (mins < 1) return 'now';
  return diff > 0 ? 'in ' + text : text + ' ago';
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

function buildDayPicker() {
  const wrap = $('daysWrap');
  core.WEEKDAY_NAMES.forEach((name, i) => {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = String(i);
    box.name = 'day';
    label.append(box, ' ' + name);
    wrap.append(label);
  });
}

function selectedDays() {
  return [...document.querySelectorAll('#daysWrap input:checked')].map((b) => Number(b.value));
}

function setSelectedDays(days) {
  for (const box of document.querySelectorAll('#daysWrap input')) box.checked = days.includes(Number(box.value));
}

function updateRepeatUi() {
  const repeat = $('repeat').value;
  $('intervalWrap').hidden = !['minutely', 'hourly', 'daily', 'weekly', 'monthly'].includes(repeat);
  $('daysWrap').hidden = repeat !== 'weekly';
  if (repeat === 'weekly' && selectedDays().length === 0) {
    const date = new Date($('date').value + 'T00:00');
    setSelectedDays([Number.isNaN(date.getTime()) ? new Date().getDay() : date.getDay()]);
  }
  if (repeat === 'minutely' && Number($('interval').value) < 5) $('interval').value = '30';
}

function recurrenceFromForm() {
  const repeat = $('repeat').value;
  const interval = Number($('interval').value) || 1;
  switch (repeat) {
    case 'none': return { freq: 'none' };
    case 'weekdays': return { freq: 'weekly', interval: 1, days: WEEKDAYS };
    case 'weekly': return { freq: 'weekly', interval, days: selectedDays() };
    case 'yearly': return { freq: 'yearly', interval: 1 };
    default: return { freq: repeat, interval };
  }
}

function recurrenceToForm(rec, startAt) {
  rec = core.normalizeRecurrence(rec);
  $('interval').value = String(rec.interval || 1);
  if (rec.freq === 'weekly') {
    const days = rec.days || [new Date(startAt).getDay()];
    const weekdays = rec.interval === 1 && days.length === 5 && WEEKDAYS.every((d) => days.includes(d));
    $('repeat').value = weekdays ? 'weekdays' : 'weekly';
    setSelectedDays(days);
  } else {
    $('repeat').value = rec.freq;
    setSelectedDays([]);
  }
  updateRepeatUi();
}

function resetForm() {
  editingId = null;
  $('form').reset();
  const d = new Date(Date.now() + 15 * 60000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  $('date').value = toDateInput(d);
  $('time').value = toTimeInput(d);
  setSelectedDays([]);
  updateRepeatUi();
  $('formHeading').textContent = 'New reminder';
  $('submit').textContent = 'Add reminder';
  $('cancelEdit').hidden = true;
  $('formError').hidden = true;
}

function startEdit(r) {
  editingId = r.id;
  $('title').value = r.title;
  $('message').value = r.message || '';
  const start = new Date(r.startAt);
  $('date').value = toDateInput(start);
  $('time').value = toTimeInput(start);
  recurrenceToForm(r.recurrence, r.startAt);
  $('formHeading').textContent = 'Edit reminder';
  $('submit').textContent = 'Save changes';
  $('cancelEdit').hidden = false;
  $('formError').hidden = true;
  $('title').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function submitForm(e) {
  e.preventDefault();
  $('formError').hidden = true;
  const recurrence = recurrenceFromForm();
  if (recurrence.freq === 'weekly' && !recurrence.days.length) {
    $('formError').textContent = 'Pick at least one day of the week.';
    $('formError').hidden = false;
    return;
  }
  const fields = {
    title: $('title').value.trim(),
    message: $('message').value.trim(),
    dueAt: new Date($('date').value + 'T' + $('time').value).getTime(),
    recurrence,
  };
  try {
    await send('save', { id: editingId, fields });
    resetForm();
  } catch (err) {
    $('formError').textContent = err.message;
    $('formError').hidden = false;
  }
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

function button(label, onClick, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await onClick(); } catch (err) { alert(err.message); } finally { b.disabled = false; }
  });
  return b;
}

function renderItem(r, kind) {
  const li = $('itemTemplate').content.firstElementChild.cloneNode(true);
  li.querySelector('.item-title').textContent = r.title;
  const when = li.querySelector('.item-when');
  const meta = [core.describeRecurrence(r.recurrence, r.startAt)];
  if (r.message) meta.unshift(r.message.length > 80 ? r.message.slice(0, 80) + '…' : r.message);

  if (kind === 'done') {
    when.textContent = (r.status === 'completed' ? 'Completed ' : 'Dismissed ')
      + (r.lastActionAt ? formatWhen(r.lastActionAt) : '');
  } else if (r.snoozedUntil) {
    when.textContent = 'Snoozed until ' + formatWhen(r.snoozedUntil) + ' (' + relative(r.snoozedUntil) + ')';
  } else {
    when.textContent = formatWhen(r.dueAt) + ' (' + relative(r.dueAt) + ')';
  }
  li.querySelector('.item-meta').textContent = meta.join(' · ');

  const actions = li.querySelector('.item-actions');
  const snoozeMins = state.settings.defaultSnooze || 10;
  if (kind === 'ringing') {
    actions.append(
      button('Snooze ' + snoozeMins + 'm', () => send('act', { id: r.id, action: 'snooze', minutes: snoozeMins })),
      button('Dismiss', () => send('act', { id: r.id, action: 'dismiss' })),
      button('Complete', () => send('act', { id: r.id, action: 'complete' }), 'primary'),
    );
  } else if (kind === 'upcoming') {
    actions.append(
      button('Edit', () => startEdit(r)),
      button(core.isRecurring(r.recurrence) ? 'Skip' : 'Done', () => send('act', { id: r.id, action: 'complete' })),
      button('Delete', () => confirm('Delete "' + r.title + '"?') && send('delete', { id: r.id })),
    );
  } else {
    actions.append(
      button('Reschedule', () => startEdit(r)),
      button('Delete', () => send('delete', { id: r.id })),
    );
  }
  return li;
}

function render() {
  const now = Date.now();
  const live = state.reminders.filter((r) => !r.deleted);
  const ringing = live.filter((r) => core.isRinging(r, now)).sort((a, b) => core.fireTime(a) - core.fireTime(b));
  const upcoming = live.filter((r) => core.isActive(r) && !core.isRinging(r, now))
    .sort((a, b) => core.fireTime(a) - core.fireTime(b));
  const done = live.filter((r) => !core.isActive(r)).sort((a, b) => (b.lastActionAt || 0) - (a.lastActionAt || 0));

  $('ringingSection').hidden = ringing.length === 0;
  $('ringingList').replaceChildren(...ringing.map((r) => renderItem(r, 'ringing')));
  $('upcomingList').replaceChildren(...upcoming.map((r) => renderItem(r, 'upcoming')));
  $('upcomingEmpty').hidden = upcoming.length > 0;
  $('doneList').replaceChildren(...done.slice(0, 50).map((r) => renderItem(r, 'done')));
  $('doneCount').textContent = String(done.length);

  const c = state.companion || {};
  const status = $('status');
  status.className = 'status ' + (c.online ? 'online' : c.lastCheckAt ? 'offline' : '');
  status.textContent = c.online ? 'Companion connected' : c.lastCheckAt ? 'Companion offline' : 'Checking…';
  status.title = c.online ? 'Always-on-top reminders are active.' : (c.error || '');
  $('companionHint').hidden = !(c.lastCheckAt && !c.online);
}

function renderSettings() {
  const s = state.settings;
  $('companionUrl').value = s.companionUrl || 'http://127.0.0.1:47321';
  $('defaultSnooze').value = String(s.defaultSnooze || 10);
  $('chromeFallback').checked = s.chromeFallback !== false;
}

async function loadState() {
  const data = await chrome.storage.local.get(['reminders', 'settings', 'companion']);
  state = {
    reminders: data.reminders || [],
    settings: Object.assign({ companionUrl: 'http://127.0.0.1:47321', defaultSnooze: 10, chromeFallback: true }, data.settings),
    companion: data.companion || {},
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  if (new URLSearchParams(location.search).has('tab')) document.body.classList.add('tab');
  buildDayPicker();
  resetForm();
  await loadState();
  renderSettings();
  render();

  $('repeat').addEventListener('change', updateRepeatUi);
  $('form').addEventListener('submit', submitForm);
  $('cancelEdit').addEventListener('click', resetForm);
  $('clearDone').addEventListener('click', () => send('clearFinished'));
  $('openTab').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?tab=1') });
    window.close();
  });
  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('settingsMsg');
    try {
      await send('saveSettings', {
        settings: {
          companionUrl: $('companionUrl').value,
          defaultSnooze: $('defaultSnooze').value,
          chromeFallback: $('chromeFallback').checked,
        },
      });
      msg.textContent = 'Saved.';
    } catch (err) {
      msg.textContent = err.message;
    }
    msg.hidden = false;
  });
  $('test').addEventListener('click', async () => {
    const msg = $('settingsMsg');
    try {
      const result = await send('test');
      msg.textContent = result.via === 'companion'
        ? 'Test reminder sent to the desktop companion.'
        : 'Companion not reachable — showed a Chrome notification instead.';
    } catch (err) {
      msg.textContent = err.message;
    }
    msg.hidden = false;
  });

  chrome.storage.onChanged.addListener(async (_changes, area) => {
    if (area !== 'local') return;
    await loadState();
    render();
  });
  setInterval(render, 15000);
  setInterval(() => send('refresh').catch(() => {}), 15000);
  send('refresh').catch(() => {});
}

init();
