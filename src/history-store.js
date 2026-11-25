import { existsSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));

function size(path) {
  return ['', '-wal', '-shm'].reduce((bytes, suffix) => bytes + (statSync(path + suffix, { throwIfNoEntry: false })?.size ?? 0), 0);
}

function inventory(path) {
  let branches = [];
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      if (hasTable(db, 'changes')) {
        branches = db.prepare('SELECT branch, count(*) records FROM changes GROUP BY branch ORDER BY branch').all();
      }
    } finally { db.close(); }
  }
  return { branches, records: branches.reduce((total, row) => total + row.records, 0), bytes: size(path) };
}

export function historyInventory(projects) {
  const rows = projects.map(({ path, ...project }) => ({ ...project, ...inventory(path) }));
  return {
    projects: rows,
    records: rows.reduce((total, row) => total + row.records, 0),
    bytes: rows.reduce((total, row) => total + row.bytes, 0),
  };
}

function removeHistory(path, branch) {
  if (!existsSync(path)) return { deleted: 0, reclaimPending: false };
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    if (!hasTable(db, 'changes')) return { deleted: 0, reclaimPending: false };
    const params = branch === undefined ? [] : [branch];
    const condition = branch === undefined ? '' : 'WHERE branch = ?';
    let deleted;
    db.exec('BEGIN IMMEDIATE');
    try {
      // IDs are also browser review keys and agent note targets. Never reuse an erased ID.
      const { id } = db.prepare('SELECT max(id) id FROM changes').get();
      for (const table of ['hunk_notes', 'timeline_after', 'timeline_confirmed', 'timeline_deletions', 'timeline_pending', 'files']) {
        if (hasTable(db, table)) {
          db.prepare(`DELETE FROM ${table}${condition ? ' WHERE change_id IN (SELECT id FROM changes WHERE branch = ?)' : ''}`).run(...params);
        }
      }
      deleted = db.prepare(`DELETE FROM changes ${condition}`).run(...params).changes;
      if (deleted) db.prepare(`INSERT INTO meta VALUES ('lastClearedChangeId', ?)
        ON CONFLICT(key) DO UPDATE SET value = CAST(max(CAST(meta.value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`)
        .run(String(id));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    // Deletion is committed above. A busy reader or low disk space may prevent immediate compaction.
    try {
      if (deleted || db.prepare('PRAGMA freelist_count').get().freelist_count) db.exec('VACUUM');
      return { deleted, reclaimPending: Boolean(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) };
    } catch (error) {
      console.error(`Focus Code: could not compact history (${error.message})`);
      return { deleted, reclaimPending: true };
    }
  } finally { db.close(); }
}

export function clearHistory(projects, branch) {
  let deleted = 0;
  let reclaimPending = false;
  const failed = [];
  for (const { id, path } of projects) {
    try {
      const result = removeHistory(path, branch);
      deleted += result.deleted;
      reclaimPending ||= result.reclaimPending;
    } catch (error) {
      console.error(`Focus Code: could not clear history (${error.message})`);
      failed.push(id);
    }
  }
  return { deleted, reclaimPending, failed };
}
