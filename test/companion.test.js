'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('../companion/src/core');
const { ReminderStore } = require('../companion/src/store');
const { Scheduler } = require('../companion/src/scheduler');
const { createServer } = require('../companion/src/server');

const EXT_ORIGIN = 'chrome-extension://' + 'a'.repeat(32);
const MIN = 60 * 1000;

function tmpStore(now) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remindme-'));
  return new ReminderStore(path.join(dir, 'reminders.json'), { now }).load();
}

test('store persists, merges and applies actions', () => {
  let clock = Date.parse('2026-01-05T09:00:00Z');
  const store = tmpStore(() => clock);
  const r = core.createReminder({ title: 'Meeting', dueAt: clock + 5 * MIN }, clock);
  store.sync([r]);
  assert.equal(store.all().length, 1);

  clock += 6 * MIN;
  const snoozed = store.act(r.id, 'snooze', 5);
  assert.equal(snoozed.snoozedUntil, clock + 5 * MIN);

  const reloaded = new ReminderStore(store.filePath, { now: () => clock }).load();
  assert.equal(reloaded.get(r.id).snoozedUntil, clock + 5 * MIN);
  assert.equal(store.act('missing', 'dismiss'), null);
});

test('scheduler rings due reminders and stops them after an action', () => {
  let clock = Date.parse('2026-01-05T09:00:00Z');
  const store = tmpStore(() => clock);
  const rang = [];
  const stopped = [];
  const scheduler = new Scheduler(store, {
    now: () => clock,
    onRing: (r) => rang.push(r.id),
    onStop: (id) => stopped.push(id),
  });
  const r = core.createReminder({ title: 'Due', dueAt: clock + MIN }, clock);
  store.sync([r]);
  scheduler.start();
  assert.deepEqual(rang, []);

  clock += MIN;
  scheduler.check();
  assert.deepEqual(rang, [r.id]);
  scheduler.check(); // still ringing: no duplicate window
  assert.deepEqual(rang, [r.id]);

  store.act(r.id, 'complete');
  assert.deepEqual(stopped, [r.id]);
  assert.equal(store.get(r.id).status, 'completed');

  // Paused: nothing rings.
  const r2 = core.createReminder({ title: 'Later', dueAt: clock + MIN }, clock);
  store.sync([r2]);
  scheduler.setPaused(true);
  clock += 2 * MIN;
  scheduler.check();
  assert.deepEqual(rang, [r.id]);
  scheduler.setPaused(false);
  assert.deepEqual(rang, [r.id, r2.id]);
  scheduler.stop();
});

async function withServer(options, fn) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const extHeaders = { Origin: EXT_ORIGIN, 'X-RemindMe-Client': 'extension', 'Content-Type': 'application/json' };

test('server: health, sync and access control', async () => {
  const store = tmpStore(Date.now);
  let tests = 0;
  await withServer({ store, version: '1.0.0', onTest: () => tests++ }, async (base) => {
    let res = await fetch(base + '/api/health', { headers: extHeaders });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), EXT_ORIGIN);
    assert.equal((await res.json()).ok, true);

    const r = core.createReminder({ title: 'Synced', dueAt: Date.now() + 60 * MIN });
    res = await fetch(base + '/api/sync', { method: 'POST', headers: extHeaders, body: JSON.stringify({ reminders: [r] }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reminders[0].title, 'Synced');
    assert.equal(store.get(r.id).title, 'Synced');

    res = await fetch(base + '/api/test', { method: 'POST', headers: extHeaders, body: '{}' });
    assert.equal(res.status, 200);
    assert.equal(tests, 1);

    // Web pages (non-extension origins) are rejected.
    res = await fetch(base + '/api/reminders', { headers: Object.assign({}, extHeaders, { Origin: 'https://evil.example' }) });
    assert.equal(res.status, 403);
    // Missing origin (e.g. curl) is rejected.
    res = await fetch(base + '/api/reminders', { headers: { 'X-RemindMe-Client': 'x' } });
    assert.equal(res.status, 403);
    // Missing custom header is rejected.
    res = await fetch(base + '/api/reminders', { headers: { Origin: EXT_ORIGIN } });
    assert.equal(res.status, 403);
    // Preflight is answered for the extension.
    res = await fetch(base + '/api/sync', { method: 'OPTIONS', headers: { Origin: EXT_ORIGIN } });
    assert.equal(res.status, 204);
    // Bad JSON
    res = await fetch(base + '/api/sync', { method: 'POST', headers: extHeaders, body: '{nope' });
    assert.equal(res.status, 400);
  });
});

test('server: extension ID allow-list', async () => {
  const store = tmpStore(Date.now);
  await withServer({ store, version: '1', allowedExtensionIds: ['b'.repeat(32)] }, async (base) => {
    const res = await fetch(base + '/api/health', { headers: extHeaders });
    assert.equal(res.status, 403);
    const ok = await fetch(base + '/api/health', {
      headers: Object.assign({}, extHeaders, { Origin: 'chrome-extension://' + 'b'.repeat(32) }),
    });
    assert.equal(ok.status, 200);
  });
});
