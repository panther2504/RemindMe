'use strict';

const core = window.RemindMeCore;
const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
let reminder = null;

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function render() {
  if (!reminder) return;
  document.title = '⏰ ' + reminder.title;
  $('title').textContent = reminder.title;
  $('message').textContent = reminder.message || '';
  $('when').textContent = formatWhen(reminder.dueAt);
  $('when').classList.toggle('overdue', Date.now() - reminder.dueAt > 60000);
  const meta = [core.describeRecurrence(reminder.recurrence, reminder.startAt)];
  if (reminder.snoozedUntil) meta.push('Snoozed until ' + formatWhen(reminder.snoozedUntil));
  $('meta').textContent = meta.join(' · ');
}

async function load() {
  const { reminders = [], settings = {} } = await chrome.storage.local.get(['reminders', 'settings']);
  reminder = reminders.find((r) => r.id === id && !r.deleted) || null;
  if (!reminder || !core.isRinging(reminder)) {
    window.close();
    return;
  }
  const select = $('snoozeMinutes');
  if (!select.dataset.init) {
    select.dataset.init = '1';
    const def = String(settings.defaultSnooze || 10);
    if (![...select.options].some((o) => o.value === def)) select.add(new Option(def + ' min', def));
    select.value = def;
  }
  render();
}

function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1175, 1568].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = ctx.currentTime + i * 0.25;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  } catch { /* autoplay blocked */ }
}

async function act(action) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  const res = await chrome.runtime.sendMessage({
    type: 'act', id, action, minutes: Number($('snoozeMinutes').value),
  });
  if (res && res.ok) window.close();
  else for (const b of document.querySelectorAll('button')) b.disabled = false;
}

$('snooze').addEventListener('click', () => act('snooze'));
$('dismiss').addEventListener('click', () => act('dismiss'));
$('complete').addEventListener('click', () => act('complete'));
chrome.storage.onChanged.addListener((_c, area) => { if (area === 'local') load(); });
setInterval(render, 30000);
load().then(chime);
