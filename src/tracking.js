import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const trackingModes = ['inherit', 'on', 'off'];

export function stateDirectory() {
  return resolve(process.env.FOCUS_HOME || join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'focus-code'));
}

export class TrackingSettings {
  constructor(directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'tracking.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS defaults (
        id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, revision INTEGER NOT NULL, clock INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO defaults VALUES (1, 1, 0, 0);
      CREATE TABLE IF NOT EXISTS overrides (root TEXT PRIMARY KEY, mode TEXT NOT NULL, revision INTEGER NOT NULL);
    `);
  }

  get(root = null) {
    const row = this.db.prepare(`
      SELECT d.enabled, d.revision default_revision, o.mode, o.revision override_revision
      FROM defaults d LEFT JOIN overrides o ON o.root = ? WHERE d.id = 1
    `).get(root);
    const defaultEnabled = Boolean(row.enabled);
    const mode = row.mode ?? 'inherit';
    return {
      defaultEnabled,
      mode,
      enabled: mode === 'inherit' ? defaultEnabled : mode === 'on',
      revision: mode === 'inherit' ? Math.max(row.default_revision, row.override_revision ?? 0) : row.override_revision,
    };
  }

  update({ defaultEnabled, root, mode }) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.get(root);
      const globalChanged = defaultEnabled !== undefined && defaultEnabled !== previous.defaultEnabled;
      const overrideChanged = mode !== undefined && mode !== previous.mode;
      if (globalChanged || overrideChanged) {
        const { clock: revision } = this.db.prepare('UPDATE defaults SET clock = clock + 1 WHERE id = 1 RETURNING clock').get();
        if (globalChanged) this.db.prepare('UPDATE defaults SET enabled = ?, revision = ? WHERE id = 1').run(Number(defaultEnabled), revision);
        if (overrideChanged) {
          const enabled = mode === 'inherit' ? (defaultEnabled ?? previous.defaultEnabled) : mode === 'on';
          const baseline = enabled === previous.enabled ? previous.revision : revision;
          // Keep inherited entries so OFF -> inherit still invalidates the old baseline.
          this.db.prepare('INSERT OR REPLACE INTO overrides VALUES (?, ?, ?)').run(root, mode, baseline);
        }
      }
      const current = this.get(root);
      this.db.exec('COMMIT');
      return current;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

export function trackingEnabled(root) {
  if (!root) return false;
  const settings = new TrackingSettings();
  try { return settings.get(root).enabled; }
  finally { settings.close(); }
}
