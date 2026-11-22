import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { addDiffSummaries, describeHunk } from '../web/diff-summary.js';
import { fileDiff, hash, repositoryBranch, repositoryBranches, scanFiles } from './repository.js';
import { stateDirectory, TrackingSettings } from './tracking.js';

export { stateDirectory } from './tracking.js';

const maxToolAge = 10 * 60_000;
const maxReasonAge = 20 * 60_000;
const trackingChanged = Symbol('trackingChanged');
const sources = new Set(['codex', 'claude', 'pi', 'opencode', 'gemini', 'trae', 'trae-cli', 'workspace', 'mixed']);

export function journalPath(root, directory = stateDirectory()) {
  return join(directory, hash(root), 'journal.sqlite');
}

export class Journal {
  constructor(root, directory = stateDirectory()) {
    this.root = root;
    const location = dirname(journalPath(root, directory));
    mkdirSync(location, { recursive: true, mode: 0o700 });
    this.location = realpathSync(location);
    this.db = new DatabaseSync(join(this.location, 'journal.sqlite'));
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (
        path TEXT PRIMARY KEY, signature TEXT NOT NULL, mode TEXT NOT NULL,
        fingerprint TEXT NOT NULL, text TEXT, limitation TEXT
      );
      CREATE TABLE IF NOT EXISTS changes (
        id INTEGER PRIMARY KEY, time INTEGER NOT NULL, source TEXT NOT NULL,
        session TEXT, tool TEXT, branch TEXT NOT NULL, reason TEXT, reason_origin TEXT,
        file_count INTEGER NOT NULL, added INTEGER NOT NULL, removed INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS changes_branch_id ON changes (branch, id);
      CREATE INDEX IF NOT EXISTS changes_session_id ON changes (source, session, id);
      CREATE TABLE IF NOT EXISTS files (
        change_id INTEGER NOT NULL REFERENCES changes(id), position INTEGER NOT NULL,
        path TEXT NOT NULL, status TEXT NOT NULL, added INTEGER NOT NULL, removed INTEGER NOT NULL,
        limitation TEXT, old_mode TEXT, new_mode TEXT, hunks TEXT NOT NULL,
        PRIMARY KEY (change_id, position)
      );
      CREATE INDEX IF NOT EXISTS files_path_history ON files (path, change_id);
      CREATE TABLE IF NOT EXISTS hunk_notes (
        change_id INTEGER NOT NULL, position INTEGER NOT NULL, hunk INTEGER NOT NULL,
        explanation TEXT, origin TEXT, revision INTEGER NOT NULL,
        PRIMARY KEY (change_id, position, hunk),
        FOREIGN KEY (change_id, position) REFERENCES files(change_id, position)
      );
      CREATE TABLE IF NOT EXISTS inflight (
        source TEXT NOT NULL, session TEXT NOT NULL, call_id TEXT NOT NULL, started INTEGER NOT NULL,
        PRIMARY KEY (source, session, call_id)
      );
      CREATE TABLE IF NOT EXISTS reasons (
        source TEXT NOT NULL, session TEXT NOT NULL, reason TEXT NOT NULL, time INTEGER NOT NULL,
        PRIMARY KEY (source, session)
      );
    `);
    this.tracking = new TrackingSettings(directory);
  }

  close() {
    this.db.close();
    this.tracking.close();
  }

  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  trackedTransaction(action) {
    try {
      return this.transaction(() => {
        const before = this.tracking.get(this.root);
        if (!before.enabled) return null;
        if ((this.getMeta('trackingRevision') ?? 0) !== before.revision) {
          this.db.exec('DELETE FROM inflight; DELETE FROM reasons;');
          this.setMeta('batch', null);
          this.setMeta('initialized', false);
          this.setMeta('trackingRevision', before.revision);
        }
        const result = action();
        const after = this.tracking.get(this.root);
        if (!after.enabled || after.revision !== before.revision) throw trackingChanged;
        return result;
      });
    } catch (error) {
      if (error === trackingChanged) return null;
      throw error;
    }
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  capture(batch = { source: 'workspace' }, time = Date.now()) {
    const initialized = this.getMeta('initialized');
    const previous = new Map(this.db.prepare('SELECT path, signature FROM snapshots').all().map(row => [row.path, row.signature]));
    const readPrevious = this.db.prepare('SELECT mode, fingerprint, text, limitation FROM snapshots WHERE path = ?');
    const updates = scanFiles(this.root, previous, path => readPrevious.get(path), this.location);
    const branch = repositoryBranch(this.root);
    if (branch !== this.getMeta('branch')) this.setMeta('branch', branch);
    const localBranches = repositoryBranches(this.root);
    if (localBranches && JSON.stringify(localBranches) !== JSON.stringify(this.getMeta('localBranches'))) {
      this.setMeta('localBranches', localBranches);
    }
    if (!initialized) this.setMeta('initialized', true);
    const write = this.db.prepare('INSERT OR REPLACE INTO snapshots VALUES (?, ?, ?, ?, ?, ?)');
    const remove = this.db.prepare('DELETE FROM snapshots WHERE path = ?');
    const files = [];
    for (const { path, before, after, change } of updates) {
      if (after) write.run(path, after.signature, after.mode, after.fingerprint, after.text, after.limitation);
      else remove.run(path);
      if (initialized && change) files.push(fileDiff(path, before, after));
    }
    if (files.length === 0) return null;
    files.sort((a, b) => a.path.localeCompare(b.path));
    const { source, session = null, tools = [], reason } = batch;
    const { lastInsertRowid: id } = this.db.prepare(`
      INSERT INTO changes (time, source, session, tool, branch, reason, reason_origin, file_count, added, removed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(time, source, session, tools.join(' · ') || null, branch, reason?.reason ?? null, reason ? 'agent' : null,
      files.length, files.reduce((sum, file) => sum + file.added, 0), files.reduce((sum, file) => sum + file.removed, 0));
    const insert = this.db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const [position, file] of files.entries()) {
      insert.run(id, position, file.path, file.status, file.added, file.removed, file.limitation, file.oldMode, file.newMode, JSON.stringify(file.hunks));
    }
    if (reason) this.db.prepare('DELETE FROM reasons WHERE source = ? AND session = ? AND time = ?').run(source, session, reason.time);
    return id;
  }

  hasActiveTools() {
    return Boolean(this.db.prepare('SELECT 1 FROM inflight LIMIT 1').get());
  }

  clearReason(source, session) {
    this.db.prepare('DELETE FROM reasons WHERE source = ? AND session = ?').run(source, session);
  }

  markUnattributed() {
    const batch = this.getMeta('batch');
    if (batch?.session) this.clearReason(batch.source, batch.session);
    this.setMeta('batch', { source: 'mixed' });
  }

  expireTools(now) {
    const expired = this.db.prepare('DELETE FROM inflight WHERE started < ?').run(now - maxToolAge).changes;
    if (expired) this.markUnattributed();
  }

  poll(now = Date.now()) {
    if (!this.tracking.get(this.root).enabled) return null;
    return this.trackedTransaction(() => {
      this.expireTools(now);
      if (this.hasActiveTools()) return null;
      const batch = this.getMeta('batch');
      if (batch) this.setMeta('batch', null);
      return this.capture(batch ?? undefined, now);
    });
  }

  setReason(source, session, reason, now = Date.now()) {
    this.trackedTransaction(() => {
      this.db.prepare('DELETE FROM reasons WHERE time < ?').run(now - maxReasonAge);
      this.db.prepare('INSERT OR REPLACE INTO reasons VALUES (?, ?, ?, ?)').run(source, session, reason, now);
    });
  }

  startTool(source, session, callId, tool, now = Date.now()) {
    return this.trackedTransaction(() => {
      this.expireTools(now);
      // Gemini's tool hooks expose a tool name rather than a unique call ID.
      const key = source === 'gemini' && !callId ? `${tool}:${randomUUID()}` : callId;
      if (this.db.prepare('SELECT 1 FROM inflight WHERE source = ? AND session = ? AND call_id = ?').get(source, session, key)) return;
      const batch = this.getMeta('batch');
      if (!this.hasActiveTools()) {
        this.capture(batch ?? undefined, now);
        const reason = this.db.prepare('SELECT reason, time FROM reasons WHERE source = ? AND session = ? AND time >= ?').get(source, session, now - maxReasonAge);
        this.setMeta('batch', { source, session, tools: [tool], reason });
      } else if (batch?.source === source && batch.session === session) {
        if (!batch.tools.includes(tool)) {
          batch.tools.push(tool);
          this.setMeta('batch', batch);
        }
      } else {
        this.markUnattributed();
        this.clearReason(source, session);
      }
      this.db.prepare('INSERT INTO inflight VALUES (?, ?, ?, ?)').run(source, session, key, now);
    });
  }

  endTool(source, session, callId, now = Date.now(), tool) {
    return this.trackedTransaction(() => {
      let key = callId;
      if (source === 'gemini' && !key) {
        const prefix = `${tool}:`;
        key = this.db.prepare('SELECT call_id FROM inflight WHERE source = ? AND session = ? AND substr(call_id, 1, ?) = ? ORDER BY started LIMIT 1')
          .get(source, session, prefix.length, prefix)?.call_id;
        if (!key) return null;
      }
      const ended = this.db.prepare('DELETE FROM inflight WHERE source = ? AND session = ? AND call_id = ?').run(source, session, key).changes;
      if (!ended || this.hasActiveTools()) return null;
      const id = this.capture(this.getMeta('batch') ?? undefined, now);
      this.setMeta('batch', null);
      return id;
    });
  }

  finishSession(source, session, now = Date.now()) {
    return this.trackedTransaction(() => {
      const ended = this.db.prepare('DELETE FROM inflight WHERE source = ? AND session = ?').run(source, session).changes;
      this.clearReason(source, session);
      if (ended) this.markUnattributed();
      if (this.hasActiveTools()) return null;
      const id = this.capture(this.getMeta('batch') ?? undefined, now);
      this.setMeta('batch', null);
      return id;
    });
  }

  list({ branch, source, search, before, limit = 40 } = {}) {
    const conditions = [];
    const args = [];
    if (branch) {
      conditions.push('c.branch = ?');
      args.push(branch);
    }
    if (sources.has(source)) {
      conditions.push('c.source = ?');
      args.push(source);
    }
    if (search?.trim()) {
      const query = search.trim().toLowerCase();
      conditions.push(`(instr(lower(c.reason), ?) OR instr(lower(c.tool), ?) OR EXISTS (
        SELECT 1 FROM files f WHERE f.change_id = c.id AND instr(lower(f.path), ?)
      ) OR EXISTS (SELECT 1 FROM hunk_notes n WHERE n.change_id = c.id AND instr(lower(n.explanation), ?)))`);
      args.push(query, query, query, query);
    }
    if (before) {
      conditions.push('c.id < ?');
      args.push(before);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const changes = this.db.prepare(`
      SELECT c.*, (SELECT path FROM files WHERE change_id = c.id ORDER BY position LIMIT 1) first_path,
        (SELECT max(revision) FROM hunk_notes WHERE change_id = c.id) notes_version
      FROM changes c ${where} ORDER BY c.id DESC LIMIT ?
    `).all(...args, limit + 1);
    const hasMore = changes.length > limit;
    if (hasMore) changes.pop();
    const scope = branch ? 'WHERE branch = ?' : '';
    const stats = this.db.prepare(`
      SELECT count(*) changes, count(DISTINCT CASE WHEN session IS NOT NULL THEN source END) agents, max(id) latest
      FROM changes ${scope}
    `).get(...(branch ? [branch] : []));
    return {
      repository: this.repository(),
      stats,
      changes,
      hasMore,
    };
  }

  repository(current = this.getMeta('branch')) {
    const branches = new Set(this.getMeta('localBranches') ?? []);
    for (const item of this.db.prepare('SELECT DISTINCT branch FROM changes').all()) branches.add(item.branch);
    if (current) branches.add(current);
    return { root: this.root, name: basename(this.root), branch: current, branches: [...branches].sort() };
  }

  isFirstChange(id, source, session) {
    return this.db.prepare('SELECT min(id) id FROM changes WHERE source = ? AND session = ?').get(source, session).id === id;
  }

  detail(id, { includeReasonEvidence = false, language = 'zh-CN' } = {}) {
    const change = this.db.prepare(`
      SELECT c.*, (SELECT max(revision) FROM hunk_notes WHERE change_id = c.id) notes_version
      FROM changes c WHERE c.id = ?
    `).get(id);
    if (!change) return null;
    const files = this.db.prepare(`
      SELECT position, path, status, added, removed, limitation, old_mode, new_mode
      FROM files WHERE change_id = ? ORDER BY position
    `).all(id);
    const reasonEvidence = includeReasonEvidence && !change.reason ? this.reasonEvidence(id, files, language) : undefined;
    return { ...change, files, ...(reasonEvidence ? { reason_evidence: reasonEvidence } : {}) };
  }

  reasonEvidence(id, files, language) {
    const notes = this.db.prepare(`
      SELECT explanation FROM hunk_notes
      WHERE change_id = ? AND explanation IS NOT NULL
      GROUP BY explanation ORDER BY min(position), min(hunk) LIMIT 2
    `).all(id).map(note => note.explanation);
    if (notes.length) return { notes };

    const relevant = files.reduce((current, file) => !current || file.added + file.removed > current.added + current.removed ? file : current, null);
    if (!relevant) return {};
    const file = this.db.prepare('SELECT hunks FROM files WHERE change_id = ? AND position = ?').get(id, relevant.position);
    const hunks = addDiffSummaries(JSON.parse(file.hunks));
    const sample = hunks.find(hunk => hunk.summary) ?? hunks[0];
    return { position: relevant.position, sample: sample ? describeHunk(sample, language) : null };
  }

  patch(id, position) {
    const file = this.db.prepare('SELECT hunks FROM files WHERE change_id = ? AND position = ?').get(id, position);
    if (!file) return null;
    const notes = new Map(this.db.prepare('SELECT hunk, explanation, origin FROM hunk_notes WHERE change_id = ? AND position = ?').all(id, position)
      .filter(note => note.explanation).map(note => [note.hunk, note]));
    return addDiffSummaries(JSON.parse(file.hunks)).map((hunk, index) => {
      const note = notes.get(index);
      return note ? { ...hunk, explanation: note.explanation, explanation_origin: note.origin } : hunk;
    });
  }

  reviewHunks(id, source, session, offset = 0) {
    if (!this.tracking.get(this.root).enabled) return null;
    const change = this.db.prepare('SELECT source, session FROM changes WHERE id = ?').get(id);
    if (change?.source !== source || change.session !== session) return null;
    const files = this.db.prepare('SELECT position, path, hunks FROM files WHERE change_id = ? ORDER BY position').iterate(id);
    const segments = [];
    const limit = 6;
    let seen = 0;
    for (const file of files) {
      for (const [index, hunk] of JSON.parse(file.hunks).entries()) {
        if (seen++ < offset) continue;
        segments.push({ position: file.position, path: file.path, index, hunk });
        if (segments.length === limit) return segments;
      }
    }
    return segments;
  }

  saveHunkNotes(id, notes, actor = null) {
    return this.saveExplanations(id, { notes, actor })?.notesSaved ?? null;
  }

  saveExplanations(id, { notes, actor, reason }) {
    const save = () => {
      if (actor) {
        const owner = this.db.prepare('SELECT source, session FROM changes WHERE id = ?').get(id);
        if (owner?.source !== actor.source || owner.session !== actor.session) return null;
      }
      const patches = new Map();
      for (const [position, index] of notes) {
        if (!patches.has(position)) patches.set(position, this.patch(id, position));
        if (!patches.get(position)?.[index]) return null;
      }
      const reasonSaved = Boolean(actor && reason && this.db.prepare(`
        UPDATE changes SET reason = ?, reason_origin = 'agent' WHERE id = ? AND reason IS NULL
      `).run(reason, id).changes);
      if (!notes.length) return { notesSaved: 0, reasonSaved };
      const { revision } = this.db.prepare('SELECT coalesce(max(revision), 0) + 1 revision FROM hunk_notes WHERE change_id = ?').get(id);
      const write = this.db.prepare(`
        INSERT INTO hunk_notes VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (change_id, position, hunk) DO UPDATE SET
          explanation = excluded.explanation, origin = excluded.origin, revision = excluded.revision
        WHERE excluded.origin IS NOT 'agent' OR hunk_notes.origin IS NOT 'user'
      `);
      let saved = 0;
      for (const [position, index, text] of notes) {
        const explanation = text.trim() || null;
        saved += Number(write.run(id, position, index, explanation, explanation ? (actor ? 'agent' : 'user') : null, revision).changes);
      }
      return { notesSaved: saved, reasonSaved };
    };
    return actor ? this.trackedTransaction(save) : this.transaction(save);
  }

  editReason(id, reason) {
    const text = reason.trim();
    return Boolean(this.db.prepare('UPDATE changes SET reason = ?, reason_origin = ? WHERE id = ?').run(text || null, text ? 'user' : null, id).changes);
  }
}
