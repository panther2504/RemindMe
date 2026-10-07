'use strict';

// Recurrence maths is local-time based; pin a zone with DST for determinism.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const core = require('../extension/lib/core');

const at = (s) => new Date(s).getTime(); // local time when no offset is given
const MIN = 60 * 1000;

test('companion copy of core.js matches the extension copy', () => {
  const root = path.join(__dirname, '..');
  assert.equal(
    fs.readFileSync(path.join(root, 'companion/src/core.js'), 'utf8'),
    fs.readFileSync(path.join(root, 'extension/lib/core.js'), 'utf8'),
    'Run `npm run sync-core` after editing extension/lib/core.js',
  );
});

test('non-recurring rules have no next occurrence', () => {
  assert.equal(core.nextOccurrence({ freq: 'none' }, at('2026-01-01T09:00'), at('2026-01-02T00:00')), null);
});

test('returns the start when it is still in the future', () => {
  const start = at('2026-01-05T09:00');
  assert.equal(core.nextOccurrence({ freq: 'daily', interval: 1 }, start, start - 1), start);
});

test('minutely / hourly', () => {
  const start = at('2026-01-01T09:00');
  assert.equal(core.nextOccurrence({ freq: 'minutely', interval: 15 }, start, start), start + 15 * MIN);
  assert.equal(core.nextOccurrence({ freq: 'minutely', interval: 15 }, start, start + 16 * MIN), start + 30 * MIN);
  assert.equal(core.nextOccurrence({ freq: 'hourly', interval: 2 }, start, at('2026-01-01T12:30')), at('2026-01-01T13:00'));
});

test('daily keeps wall-clock time across DST', () => {
  const start = at('2026-03-07T09:00'); // DST starts 2026-03-08 in New York
  assert.equal(core.nextOccurrence({ freq: 'daily', interval: 1 }, start, start), at('2026-03-08T09:00'));
  assert.equal(core.nextOccurrence({ freq: 'daily', interval: 1 }, start, at('2026-03-08T09:00')), at('2026-03-09T09:00'));
  assert.equal(core.nextOccurrence({ freq: 'daily', interval: 3 }, start, at('2026-03-20T10:00')), at('2026-03-22T09:00'));
});

test('weekdays skip the weekend', () => {
  const rec = { freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] };
  const start = at('2026-01-05T08:30'); // Monday
  assert.equal(core.nextOccurrence(rec, start, at('2026-01-09T09:00')), at('2026-01-12T08:30')); // Fri after -> Mon
  assert.equal(core.nextOccurrence(rec, start, at('2026-01-07T08:00')), at('2026-01-07T08:30'));
});

test('every 2 weeks on Tue/Thu', () => {
  const rec = { freq: 'weekly', interval: 2, days: [2, 4] };
  const start = at('2026-01-06T10:00'); // Tuesday
  assert.equal(core.nextOccurrence(rec, start, start), at('2026-01-08T10:00'));
  assert.equal(core.nextOccurrence(rec, start, at('2026-01-08T10:00')), at('2026-01-20T10:00'));
  assert.equal(core.nextOccurrence(rec, start, at('2026-01-21T00:00')), at('2026-01-22T10:00'));
});

test('weekly defaults to the weekday of the start date', () => {
  const start = at('2026-01-07T10:00'); // Wednesday
  assert.equal(core.nextOccurrence({ freq: 'weekly', interval: 1 }, start, start), at('2026-01-14T10:00'));
});

test('monthly clamps short months without drifting', () => {
  const rec = { freq: 'monthly', interval: 1 };
  const start = at('2026-01-31T09:00');
  assert.equal(core.nextOccurrence(rec, start, start), at('2026-02-28T09:00'));
  assert.equal(core.nextOccurrence(rec, start, at('2026-02-28T09:00')), at('2026-03-31T09:00'));
});

test('yearly handles Feb 29', () => {
  const start = at('2028-02-29T09:00');
  assert.equal(core.nextOccurrence({ freq: 'yearly', interval: 1 }, start, start), at('2029-02-28T09:00'));
  assert.equal(core.nextOccurrence({ freq: 'yearly', interval: 1 }, start, at('2031-06-01T00:00')), at('2032-02-29T09:00'));
});

test('createReminder rejects past one-off times and rolls recurring ones forward', () => {
  const now = at('2026-01-05T10:00');
  assert.throws(() => core.createReminder({ title: 'x', dueAt: at('2026-01-05T09:00') }, now), /future/);
  const r = core.createReminder({
    title: 'Stand-up', dueAt: at('2026-01-05T09:00'), recurrence: { freq: 'daily', interval: 1 },
  }, now);
  assert.equal(r.startAt, at('2026-01-05T09:00'));
  assert.equal(r.dueAt, at('2026-01-06T09:00'));
  assert.equal(core.isRinging(r, now), false);
});

test('snooze, dismiss and complete', () => {
  const now = at('2026-01-05T09:00');
  const once = core.createReminder({ title: 'Call', dueAt: now }, now - MIN);
  assert.ok(core.isRinging(once, now));

  const snoozed = core.applyAction(once, 'snooze', now, 10);
  assert.equal(snoozed.snoozedUntil, now + 10 * MIN);
  assert.ok(!core.isRinging(snoozed, now + 9 * MIN));
  assert.ok(core.isRinging(snoozed, now + 10 * MIN));

  assert.equal(core.applyAction(snoozed, 'dismiss', now + 11 * MIN).status, 'dismissed');
  const done = core.applyAction(once, 'complete', now);
  assert.equal(done.status, 'completed');
  assert.equal(done.completedCount, 1);
  assert.ok(!core.isRinging(done, now + 1e9));
});

test('completing a recurring reminder advances it, skipping missed occurrences', () => {
  const start = at('2026-01-05T09:00');
  const r = core.createReminder({ title: 'Pills', dueAt: start, recurrence: { freq: 'daily', interval: 1 } }, start - MIN);
  // Computer was off for three days; reminder acknowledged on Jan 8 at 12:00.
  const next = core.applyAction(r, 'complete', at('2026-01-08T12:00'));
  assert.equal(next.status, 'active');
  assert.equal(next.dueAt, at('2026-01-09T09:00'));
  assert.equal(next.snoozedUntil, null);
});

test('merge is last-write-wins and keeps tombstones', () => {
  const now = at('2026-01-05T09:00');
  const a = core.createReminder({ title: 'A', dueAt: now + 60 * MIN }, now);
  const edited = Object.assign({}, a, { title: 'A2', updatedAt: now + 5 });
  const deleted = core.deleteReminder(a, now + 10);

  assert.equal(core.mergeReminders([a], [edited], now)[0].title, 'A2');
  assert.equal(core.mergeReminders([edited], [a], now)[0].title, 'A2');
  const merged = core.mergeReminders([edited], [deleted], now);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].deleted, true);
  // old tombstones are purged
  assert.equal(core.mergeReminders([deleted], [], now + 31 * core.DAY).length, 0);
});

test('normalizeReminder drops garbage', () => {
  assert.equal(core.normalizeReminder(null), null);
  assert.equal(core.normalizeReminder({ id: 'x' }), null);
  const r = core.normalizeReminder({ id: 'x', dueAt: 5, title: '  ', status: 'weird', recurrence: { freq: 'bogus' } });
  assert.equal(r.title, 'Reminder');
  assert.equal(r.status, 'active');
  assert.deepEqual(r.recurrence, { freq: 'none' });
});

test('describeRecurrence', () => {
  assert.equal(core.describeRecurrence({ freq: 'none' }), 'Does not repeat');
  assert.equal(core.describeRecurrence({ freq: 'weekly', interval: 1, days: [1, 2, 3, 4, 5] }), 'Every weekday (Mon–Fri)');
  assert.equal(core.describeRecurrence({ freq: 'minutely', interval: 30 }), 'Every 30 minutes');
  assert.equal(core.describeRecurrence({ freq: 'weekly', interval: 2, days: [2, 4] }), 'Every 2 weeks on Tue, Thu');
});
