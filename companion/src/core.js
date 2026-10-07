/*
 * RemindMe core: reminder model, recurrence maths and sync/merge rules.
 *
 * This file is shared verbatim by the Chrome extension (loaded with
 * importScripts / <script>) and the desktop companion (require()).
 * The canonical copy lives in extension/lib/core.js; run `npm run sync-core`
 * to copy it to companion/src/core.js. A test fails if the two drift apart.
 *
 * All times are epoch milliseconds. Recurrence is evaluated in the local time
 * zone of the machine, which is the same for the extension and the companion.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.RemindMeCore = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const TOMBSTONE_TTL = 30 * DAY;

  const FREQUENCIES = ['none', 'minutely', 'hourly', 'daily', 'weekly', 'monthly', 'yearly'];
  const STATUSES = ['active', 'completed', 'dismissed'];
  const ACTIONS = ['snooze', 'dismiss', 'complete'];
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ---------------------------------------------------------------------------
  // Recurrence
  // ---------------------------------------------------------------------------

  function normalizeRecurrence(rec) {
    const freq = rec && FREQUENCIES.includes(rec.freq) ? rec.freq : 'none';
    if (freq === 'none') return { freq: 'none' };
    let interval = Math.floor(Number(rec.interval) || 1);
    if (interval < 1) interval = 1;
    if (interval > 1000) interval = 1000;
    const out = { freq, interval };
    if (freq === 'weekly') {
      const days = Array.isArray(rec.days)
        ? [...new Set(rec.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
        : [];
      if (days.length) out.days = days;
    }
    return out;
  }

  function isRecurring(rec) {
    return !!rec && rec.freq !== 'none' && FREQUENCIES.includes(rec.freq);
  }

  // Same wall-clock time as `start`, shifted by whole calendar days (DST safe).
  function addDays(start, n) {
    const d = new Date(start);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n,
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
  }

  // Shift by whole months, clamping the day (Jan 31 -> Feb 28/29 -> Mar 31).
  function addMonthsClamped(start, n) {
    const d = new Date(start);
    const target = new Date(d.getFullYear(), d.getMonth() + n, 1,
      d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
    const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(d.getDate(), daysInMonth));
    return target.getTime();
  }

  /**
   * First occurrence of the series anchored at `startAt` that is strictly
   * later than `after`. Returns null for non-recurring rules.
   */
  function nextOccurrence(recurrence, startAt, after) {
    const rec = normalizeRecurrence(recurrence);
    if (!isRecurring(rec)) return null;
    if (after < startAt) return startAt;
    const { interval } = rec;

    switch (rec.freq) {
      case 'minutely':
      case 'hourly': {
        const step = interval * (rec.freq === 'minutely' ? MINUTE : HOUR);
        return startAt + (Math.floor((after - startAt) / step) + 1) * step;
      }
      case 'daily': {
        const approxDays = Math.floor((after - startAt) / DAY);
        let k = Math.max(0, Math.floor(approxDays / interval) - 1);
        for (;;) {
          const t = addDays(startAt, k * interval);
          if (t > after) return t;
          k++;
        }
      }
      case 'weekly': {
        const startDow = new Date(startAt).getDay();
        const days = rec.days || [startDow];
        const approxDays = Math.max(0, Math.floor((after - startAt) / DAY) - 1);
        // Scan at most one full cycle of `interval` weeks (plus slack).
        for (let off = approxDays; off <= approxDays + 7 * interval + 8; off++) {
          const weekIndex = Math.floor((startDow + off) / 7);
          if (weekIndex % interval !== 0) continue;
          const t = addDays(startAt, off);
          if (t > after && days.includes(new Date(t).getDay())) return t;
        }
        return null; // unreachable with a valid rule
      }
      case 'monthly':
      case 'yearly': {
        const step = rec.freq === 'monthly' ? interval : interval * 12;
        const s = new Date(startAt);
        const a = new Date(after);
        const monthsApart = (a.getFullYear() - s.getFullYear()) * 12 + (a.getMonth() - s.getMonth());
        let k = Math.max(0, Math.floor(monthsApart / step) - 1);
        for (;;) {
          const t = addMonthsClamped(startAt, k * step);
          if (t > after) return t;
          k++;
        }
      }
      default:
        return null;
    }
  }

  function describeRecurrence(recurrence, startAt) {
    const rec = normalizeRecurrence(recurrence);
    const n = rec.interval;
    const every = (unit) => (n === 1 ? 'Every ' + unit : 'Every ' + n + ' ' + unit + 's');
    switch (rec.freq) {
      case 'minutely': return every('minute');
      case 'hourly': return every('hour');
      case 'daily': return n === 1 ? 'Daily' : every('day');
      case 'weekly': {
        const days = rec.days || (startAt != null ? [new Date(startAt).getDay()] : []);
        const isWeekdays = days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d));
        const label = isWeekdays ? 'weekdays' : days.map((d) => WEEKDAY_NAMES[d]).join(', ');
        if (n === 1) return isWeekdays ? 'Every weekday (Mon–Fri)' : 'Weekly on ' + label;
        return 'Every ' + n + ' weeks on ' + label;
      }
      case 'monthly': return n === 1 ? 'Monthly' : every('month');
      case 'yearly': return n === 1 ? 'Yearly' : every('year');
      default: return 'Does not repeat';
    }
  }

  // ---------------------------------------------------------------------------
  // Reminder model
  // ---------------------------------------------------------------------------

  function newId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function clampText(value, max) {
    return String(value == null ? '' : value).slice(0, max);
  }

  function toTime(value) {
    const n = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Sanitize a reminder received from storage or over the wire.
   * Returns null if it is unusable.
   */
  function normalizeReminder(input) {
    if (!input || typeof input !== 'object') return null;
    const id = clampText(input.id, 100);
    if (!id) return null;
    const updatedAt = toTime(input.updatedAt) || 0;
    if (input.deleted) return { id, deleted: true, updatedAt };

    const dueAt = toTime(input.dueAt);
    if (dueAt == null) return null;
    const startAt = toTime(input.startAt);
    const snoozedUntil = toTime(input.snoozedUntil);
    return {
      id,
      title: clampText(input.title, 200).trim() || 'Reminder',
      message: clampText(input.message, 2000),
      startAt: startAt == null ? dueAt : startAt,
      dueAt,
      recurrence: normalizeRecurrence(input.recurrence),
      snoozedUntil: snoozedUntil == null ? null : snoozedUntil,
      status: STATUSES.includes(input.status) ? input.status : 'active',
      lastActionAt: toTime(input.lastActionAt),
      completedCount: Math.max(0, Math.floor(Number(input.completedCount) || 0)),
      createdAt: toTime(input.createdAt) || updatedAt,
      updatedAt,
    };
  }

  // Validate the schedule part of user input. A recurring series whose first
  // occurrence is in the past starts at its next occurrence instead of
  // ringing immediately.
  function scheduleFromFields(fields, now) {
    const startAt = toTime(fields.dueAt);
    if (startAt == null) throw new Error('A valid date and time is required.');
    const recurrence = normalizeRecurrence(fields.recurrence);
    let dueAt = startAt;
    if (isRecurring(recurrence)) {
      if (startAt <= now) dueAt = nextOccurrence(recurrence, startAt, now);
    } else if (startAt <= now - MINUTE) {
      throw new Error('Please choose a time in the future.');
    }
    return { startAt, dueAt, recurrence };
  }

  /** Create a brand-new reminder from user input. */
  function createReminder(fields, now) {
    now = now == null ? Date.now() : now;
    return normalizeReminder(Object.assign({
      id: newId(),
      title: fields.title,
      message: fields.message,
      snoozedUntil: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    }, scheduleFromFields(fields, now)));
  }

  /** Apply an edit made by the user; rescheduling resets snooze/status. */
  function editReminder(reminder, fields, now) {
    now = now == null ? Date.now() : now;
    return normalizeReminder(Object.assign({}, reminder, {
      title: fields.title,
      message: fields.message,
      snoozedUntil: null,
      status: 'active',
      updatedAt: now,
    }, scheduleFromFields(fields, now)));
  }

  function deleteReminder(reminder, now) {
    return { id: reminder.id, deleted: true, updatedAt: now == null ? Date.now() : now };
  }

  /** When the reminder should (next) appear on screen. */
  function fireTime(reminder) {
    return reminder.snoozedUntil != null ? reminder.snoozedUntil : reminder.dueAt;
  }

  function isActive(reminder) {
    return !!reminder && !reminder.deleted && reminder.status === 'active';
  }

  /** A "ringing" reminder must stay on screen until the user acts on it. */
  function isRinging(reminder, now) {
    return isActive(reminder) && fireTime(reminder) <= (now == null ? Date.now() : now);
  }

  /**
   * Apply a user action from a notification/overlay.
   *  - snooze:   hide for `minutes`, then ring again.
   *  - dismiss:  acknowledge this occurrence (one-off reminders are closed).
   *  - complete: mark done (recurring reminders advance to the next occurrence).
   */
  function applyAction(reminder, action, now, minutes) {
    if (!ACTIONS.includes(action)) throw new Error('Unknown action: ' + action);
    if (!isActive(reminder)) return reminder;
    now = now == null ? Date.now() : now;
    const r = Object.assign({}, reminder, { updatedAt: now, lastActionAt: now });

    if (action === 'snooze') {
      const m = Math.min(7 * 24 * 60, Math.max(1, Math.floor(Number(minutes) || 10)));
      r.snoozedUntil = now + m * MINUTE;
      return r;
    }

    r.snoozedUntil = null;
    if (action === 'complete') r.completedCount = (r.completedCount || 0) + 1;
    if (isRecurring(r.recurrence)) {
      // Skip any occurrences missed while the computer was off/asleep.
      r.dueAt = nextOccurrence(r.recurrence, r.startAt, Math.max(now, r.dueAt));
    } else {
      r.status = action === 'complete' ? 'completed' : 'dismissed';
    }
    return r;
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  /**
   * Merge two reminder lists (last write wins per id, deletions are kept as
   * tombstones so they propagate). Old tombstones are purged.
   */
  function mergeReminders(local, remote, now) {
    now = now == null ? Date.now() : now;
    const byId = new Map();
    for (const list of [local || [], remote || []]) {
      for (const raw of list) {
        const r = normalizeReminder(raw);
        if (!r) continue;
        const existing = byId.get(r.id);
        if (!existing || r.updatedAt > existing.updatedAt) byId.set(r.id, r);
      }
    }
    return [...byId.values()].filter((r) => !(r.deleted && now - r.updatedAt > TOMBSTONE_TTL));
  }

  /** Earliest future fire time among active reminders (null if none). */
  function nextFireTime(reminders, now) {
    let best = null;
    for (const r of reminders) {
      if (!isActive(r)) continue;
      const t = fireTime(r);
      if (t > now && (best == null || t < best)) best = t;
    }
    return best;
  }

  return {
    MINUTE, HOUR, DAY, WEEKDAY_NAMES, FREQUENCIES, ACTIONS,
    normalizeRecurrence, isRecurring, nextOccurrence, describeRecurrence,
    normalizeReminder, createReminder, editReminder, deleteReminder,
    fireTime, isActive, isRinging, applyAction, mergeReminders, nextFireTime,
  };
});
