/* RemindMe service worker: storage, scheduling, companion sync and the Chrome-only fallback. */
importScripts('lib/core.js');

const core = self.RemindMeCore;

const DEFAULT_SETTINGS = {
  companionUrl: 'http://127.0.0.1:47321',
  defaultSnooze: 10,
  // When the desktop companion is not reachable, show reminders using
  // Chrome's own notification + a focused popup window instead.
  chromeFallback: true,
};
const HEARTBEAT = 'heartbeat';
const NEXT = 'next-reminder';
const NOTIFICATION_PREFIX = 'remindme:';

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getState() {
  const { reminders = [], settings = {}, companion = {} } =
    await chrome.storage.local.get(['reminders', 'settings', 'companion']);
  return { reminders, settings: Object.assign({}, DEFAULT_SETTINGS, settings), companion };
}

async function getShown() {
  const { shown = {} } = await chrome.storage.session.get('shown');
  return shown;
}

// All state changes run one at a time so concurrent messages/alarms can't clobber each other.
let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Companion bridge
// ---------------------------------------------------------------------------

async function companionFetch(settings, path, options = {}) {
  const base = settings.companionUrl.replace(/\/+$/, '');
  const res = await fetch(base + path, Object.assign({}, options, {
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-RemindMe-Client': 'extension' }, options.headers),
    signal: AbortSignal.timeout(3000),
  }));
  if (!res.ok) throw new Error('Companion responded with HTTP ' + res.status);
  return res.json();
}

async function syncCompanion() {
  const { reminders, settings } = await getState();
  try {
    const data = await companionFetch(settings, '/api/sync', {
      method: 'POST',
      body: JSON.stringify({ reminders }),
    });
    const merged = core.mergeReminders(reminders, data.reminders || []);
    await chrome.storage.local.set({
      reminders: merged,
      companion: { online: true, lastSyncAt: Date.now(), error: null },
    });
  } catch (err) {
    await chrome.storage.local.set({
      companion: { online: false, lastCheckAt: Date.now(), error: String(err && err.message || err) },
    });
  }
}

// ---------------------------------------------------------------------------
// Chrome-only fallback display
// ---------------------------------------------------------------------------

function formatWhen(ms) {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

async function openFallback(reminder, settings) {
  const entry = {};
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL('reminder.html?id=' + encodeURIComponent(reminder.id)),
      type: 'popup',
      width: 460,
      height: 360,
      focused: true,
    });
    entry.windowId = win.id;
    await chrome.windows.update(win.id, { drawAttention: true });
  } catch (err) {
    console.warn('Could not open reminder window', err);
  }
  try {
    await chrome.notifications.create(NOTIFICATION_PREFIX + reminder.id, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: reminder.title,
      message: reminder.message || 'Reminder',
      contextMessage: 'Due ' + formatWhen(reminder.dueAt),
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: 'Snooze ' + settings.defaultSnooze + ' min' }, { title: 'Complete' }],
    });
  } catch (err) {
    console.warn('Could not create notification', err);
  }
  return entry;
}

async function closeFallback(id, entry) {
  if (entry && entry.windowId != null) {
    try { await chrome.windows.remove(entry.windowId); } catch { /* already closed */ }
  }
  try { await chrome.notifications.clear(NOTIFICATION_PREFIX + id); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function refresh() {
  await syncCompanion();
  const { reminders, settings, companion } = await getState();
  const now = Date.now();
  const ringing = reminders.filter((r) => core.isRinging(r, now));
  const ringingIds = new Set(ringing.map((r) => r.id));
  // If the companion is running it owns the always-on-top overlay; Chrome stays quiet.
  const useFallback = !companion.online && settings.chromeFallback;

  const shown = await getShown();
  for (const id of Object.keys(shown)) {
    if (!useFallback || !ringingIds.has(id)) {
      await closeFallback(id, shown[id]);
      delete shown[id];
    }
  }
  if (useFallback) {
    for (const r of ringing) {
      if (!shown[r.id]) shown[r.id] = await openFallback(r, settings);
    }
  }
  await chrome.storage.session.set({ shown });

  const next = core.nextFireTime(reminders, now);
  if (next != null) await chrome.alarms.create(NEXT, { when: next });
  else await chrome.alarms.clear(NEXT);

  await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
  await chrome.action.setBadgeText({ text: ringing.length ? String(ringing.length) : '' });
}

function scheduleRefresh() {
  return serialized(refresh);
}

async function mutate(fn) {
  return serialized(async () => {
    const { reminders } = await getState();
    const result = fn(reminders);
    await chrome.storage.local.set({ reminders: result.reminders });
    await refresh();
    return result.value;
  });
}

function replaceReminder(reminders, updated) {
  return reminders.map((r) => (r.id === updated.id ? updated : r));
}

function findReminder(reminders, id) {
  const r = reminders.find((x) => x.id === id && !x.deleted);
  if (!r) throw new Error('Reminder not found');
  return r;
}

async function act(id, action, minutes) {
  const { settings } = await getState();
  return mutate((reminders) => {
    const updated = core.applyAction(findReminder(reminders, id), action, Date.now(),
      minutes == null ? settings.defaultSnooze : minutes);
    return { reminders: replaceReminder(reminders, updated), value: updated };
  });
}

async function sendTest() {
  const { settings, companion } = await getState();
  try {
    await companionFetch(settings, '/api/test', { method: 'POST', body: '{}' });
    return { via: 'companion' };
  } catch {
    await chrome.notifications.create(NOTIFICATION_PREFIX + 'test', {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: 'RemindMe test',
      message: 'The desktop companion is not running, so this Chrome notification is used instead.',
      priority: 2,
      requireInteraction: true,
    });
    return { via: 'chrome', companionOnline: !!companion.online };
  }
}

const handlers = {
  async refresh() {
    await scheduleRefresh();
  },
  async save({ id, fields }) {
    return mutate((reminders) => {
      if (!String(fields.title || '').trim()) throw new Error('Title is required.');
      if (id) {
        const updated = core.editReminder(findReminder(reminders, id), fields);
        return { reminders: replaceReminder(reminders, updated), value: updated };
      }
      const created = core.createReminder(fields);
      return { reminders: reminders.concat(created), value: created };
    });
  },
  async delete({ id }) {
    return mutate((reminders) => {
      const tomb = core.deleteReminder(findReminder(reminders, id));
      return { reminders: replaceReminder(reminders, tomb), value: null };
    });
  },
  async clearFinished() {
    return mutate((reminders) => ({
      reminders: reminders.map((r) => (!r.deleted && r.status !== 'active' ? core.deleteReminder(r) : r)),
      value: null,
    }));
  },
  async act({ id, action, minutes }) {
    return act(id, action, minutes);
  },
  async saveSettings({ settings }) {
    const current = (await getState()).settings;
    const next = Object.assign({}, current, {
      companionUrl: String(settings.companionUrl || DEFAULT_SETTINGS.companionUrl).trim(),
      defaultSnooze: Math.max(1, Math.min(1440, Math.floor(Number(settings.defaultSnooze) || 10))),
      chromeFallback: !!settings.chromeFallback,
    });
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(next.companionUrl)) {
      throw new Error('Companion URL must be http://127.0.0.1:<port> or http://localhost:<port>.');
    }
    await chrome.storage.local.set({ settings: next });
    await scheduleRefresh();
    return next;
  },
  async test() {
    return sendTest();
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg && handlers[msg.type];
  if (!handler) return false;
  handler(msg)
    .then((value) => sendResponse({ ok: true, value }))
    .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
  return true; // async response
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

chrome.alarms.onAlarm.addListener(() => { scheduleRefresh(); });

chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
  if (!notificationId.startsWith(NOTIFICATION_PREFIX) || notificationId === NOTIFICATION_PREFIX + 'test') return;
  const id = notificationId.slice(NOTIFICATION_PREFIX.length);
  act(id, buttonIndex === 0 ? 'snooze' : 'complete').catch((err) => console.warn(err));
});

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const id = notificationId.slice(NOTIFICATION_PREFIX.length);
  const shown = await getShown();
  if (shown[id] && shown[id].windowId != null) {
    try { await chrome.windows.update(shown[id].windowId, { focused: true, drawAttention: true }); } catch { /* gone */ }
  }
});

// A reminder window closed without an action is reopened on the next tick:
// reminders stay visible until they are snoozed, dismissed or completed.
chrome.windows.onRemoved.addListener((windowId) => serialized(async () => {
  const shown = await getShown();
  for (const [id, entry] of Object.entries(shown)) {
    if (entry.windowId === windowId) delete shown[id];
  }
  await chrome.storage.session.set({ shown });
}));

async function init() {
  await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 });
  await scheduleRefresh();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
