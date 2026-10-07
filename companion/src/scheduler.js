'use strict';

const core = require('./core');

// Never sleep longer than this, so clock changes / sleep-resume are picked up.
const MAX_WAIT = 30 * 1000;

/**
 * Watches the store and reports which reminders are "ringing".
 *  - onRing(reminder):    a reminder became due (or changed while ringing)
 *  - onStop(id):          a reminder is no longer ringing (acted on, edited, deleted)
 */
class Scheduler {
  constructor(store, { onRing, onStop, now = Date.now } = {}) {
    this.store = store;
    this.onRing = onRing || (() => {});
    this.onStop = onStop || (() => {});
    this.now = now;
    this.ringing = new Map(); // id -> JSON snapshot of the reminder on screen
    this.timer = null;
    this.paused = false;
    this.check = this.check.bind(this);
    store.on('change', this.check);
  }

  start() {
    this.check();
    return this;
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.store.removeListener('change', this.check);
  }

  setPaused(paused) {
    this.paused = paused;
    this.check();
  }

  check() {
    clearTimeout(this.timer);
    const now = this.now();
    const reminders = this.store.all();
    const due = this.paused ? [] : reminders.filter((r) => core.isRinging(r, now));
    const dueIds = new Set(due.map((r) => r.id));

    for (const id of [...this.ringing.keys()]) {
      if (!dueIds.has(id)) {
        this.ringing.delete(id);
        this.onStop(id);
      }
    }
    for (const r of due) {
      const snapshot = JSON.stringify(r);
      if (this.ringing.get(r.id) !== snapshot) {
        this.ringing.set(r.id, snapshot);
        this.onRing(r);
      }
    }

    const next = core.nextFireTime(reminders, now);
    const wait = next == null ? MAX_WAIT : Math.min(MAX_WAIT, Math.max(0, next - now) + 50);
    this.timer = setTimeout(this.check, wait);
    if (this.timer.unref) this.timer.unref();
  }

  upcoming(limit = 10) {
    return this.store.all()
      .filter(core.isActive)
      .sort((a, b) => core.fireTime(a) - core.fireTime(b))
      .slice(0, limit);
  }
}

module.exports = { Scheduler };
