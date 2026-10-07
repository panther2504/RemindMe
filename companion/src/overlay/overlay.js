'use strict';

const $ = (id) => document.getElementById(id);
let chimed = false;

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function relative(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return mins + ' min overdue';
  const hours = Math.round(mins / 60);
  if (hours < 48) return hours + ' h overdue';
  return Math.round(hours / 24) + ' days overdue';
}

function chime() {
  try {
    const ctx = new AudioContext();
    [0, 0.25, 0.5].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = [880, 1175, 1568][i];
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.4);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch { /* audio unavailable */ }
}

let current = null;

function render() {
  if (!current) return;
  const r = current.reminder;
  document.title = 'Reminder: ' + r.title;
  $('title').textContent = r.title;
  $('message').textContent = r.message || '';
  $('when').textContent = formatWhen(r.dueAt) + ' · ' + relative(r.dueAt);
  $('when').classList.toggle('overdue', Date.now() - r.dueAt > 60000);
  const meta = [r.recurrenceText];
  if (r.snoozedUntil) meta.push('Snoozed until ' + formatWhen(r.snoozedUntil));
  if (current.isTest) meta.push('Test reminder');
  $('meta').textContent = meta.filter(Boolean).join(' · ');
}

window.remindme.onUpdate((payload) => {
  current = payload;
  render();
  if (payload.playSound && !chimed) {
    chimed = true;
    chime();
  }
});
setInterval(render, 30000);

async function act(action) {
  for (const b of document.querySelectorAll('button')) b.disabled = true;
  try {
    await window.remindme.act(action, Number($('snoozeMinutes').value));
  } finally {
    for (const b of document.querySelectorAll('button')) b.disabled = false;
  }
}

$('snooze').addEventListener('click', () => act('snooze'));
$('dismiss').addEventListener('click', () => act('dismiss'));
$('complete').addEventListener('click', () => act('complete'));
