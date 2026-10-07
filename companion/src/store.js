'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const core = require('./core');

/**
 * Persistent reminder store for the companion. Holds its own copy of every
 * reminder so reminders keep firing even when Chrome is not running.
 * Emits 'change' whenever the set of reminders changes.
 */
class ReminderStore extends EventEmitter {
  constructor(filePath, { now = Date.now } = {}) {
    super();
    this.filePath = filePath;
    this.now = now;
    this.reminders = [];
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.reminders = core.mergeReminders([], data.reminders || [], this.now());
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[store] could not read', this.filePath, err.message);
      this.reminders = [];
    }
    return this;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, reminders: this.reminders }, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  all() {
    return this.reminders.slice();
  }

  get(id) {
    return this.reminders.find((r) => r.id === id && !r.deleted) || null;
  }

  /** Merge reminders pushed by the extension and return the merged list. */
  sync(incoming) {
    const merged = core.mergeReminders(this.reminders, incoming, this.now());
    const changed = JSON.stringify(merged) !== JSON.stringify(this.reminders);
    this.reminders = merged;
    if (changed) {
      this.save();
      this.emit('change');
    }
    return this.all();
  }

  /** Apply snooze / dismiss / complete coming from an overlay window. */
  act(id, action, minutes) {
    const idx = this.reminders.findIndex((r) => r.id === id && !r.deleted);
    if (idx === -1) return null;
    const updated = core.applyAction(this.reminders[idx], action, this.now(), minutes);
    this.reminders[idx] = updated;
    this.save();
    this.emit('change');
    return updated;
  }
}

module.exports = { ReminderStore };
