import { describeHunk } from '../web/diff-summary.js';
import { fileDiff, hash, readHeadEntry, readWorktreeEntry, repositoryBranch, worktreeDiffPaths } from './repository.js';

function changedLines(hunk) {
  return hunk.lines.filter(line => line.startsWith('+') || line.startsWith('-'));
}

function meaningfulLines(hunks) {
  return new Set(hunks.flatMap(changedLines).filter(line => /[\p{L}\p{N}_]/u.test(line.slice(1))));
}

function sameEntry(a, b) {
  return a?.fingerprint === b?.fingerprint && a?.mode === b?.mode;
}

function fileMetadata(file) {
  const { path, status, added, removed, limitation, oldMode, newMode } = file;
  return { position: 0, path, status, added, removed, limitation, old_mode: oldMode, new_mode: newMode };
}

export class CurrentChanges {
  constructor(journal) {
    this.journal = journal;
    this.cache = new Map();
    this.items = new Map();
    this.recorded = journal.db.prepare(`
      SELECT c.id, c.time, c.source, c.tool, c.reason, c.reason_origin, f.position, f.hunks,
        f.status, f.old_mode, f.new_mode,
        (SELECT max(revision) FROM hunk_notes WHERE change_id = c.id AND position = f.position) notes_version
      FROM files f JOIN changes c ON c.id = f.change_id
      WHERE f.path = ? AND c.branch = ? ORDER BY f.change_id DESC LIMIT 12
    `);
    this.snapshot = journal.db.prepare('SELECT fingerprint, mode FROM snapshots WHERE path = ?');
  }

  refresh() {
    const { journal } = this;
    const tracking = journal.tracking.get(journal.root);
    if (!tracking.enabled) {
      this.cache.clear();
      this.items.clear();
      return { tracking, branch: journal.getMeta('branch') };
    }
    const branch = repositoryBranch(journal.root);
    const paths = worktreeDiffPaths(journal.root, journal.location);
    const pending = journal.hasActiveTools() ? journal.getMeta('batch') : null;
    const cache = new Map();
    const items = new Map();
    for (const [path, baseline] of paths) {
      const previous = this.cache.get(path);
      const after = readWorktreeEntry(journal.root, path, previous?.after);
      const sameBaseline = previous && baseline?.oid === previous.baseline?.oid && baseline?.mode === previous.baseline?.mode;
      const before = sameBaseline ? previous.before : readHeadEntry(journal.root, baseline);
      if (sameEntry(before, after)) continue;
      const entry = sameBaseline && previous.after === after ? previous : {
        baseline, before, after, file: fileDiff(path, before, after), time: after?.time ?? Date.now(),
        revision: hash(JSON.stringify([baseline, after?.signature])),
      };
      cache.set(path, entry);
      const id = hash(path);
      const attribution = this.attribution(branch, entry, pending);
      items.set(id, {
        file: entry.file, record: attribution.record,
        metadata: {
          id, time: attribution.time, source: attribution.source, tool: attribution.tool, branch,
          reason: attribution.reason, reason_origin: attribution.reasonOrigin, file_count: 1, first_path: path,
          added: entry.file.added, removed: entry.file.removed, diff_revision: entry.revision,
          history_id: attribution.record?.id ?? null, notes_version: attribution.record?.notes_version ?? null,
        },
      });
    }
    this.cache = cache;
    this.items = items;
    return { tracking, branch };
  }

  attribution(branch, entry, pending) {
    const { file, after, time } = entry;
    const snapshot = this.snapshot.get(file.path);
    if (!sameEntry(snapshot, after)) {
      return { source: pending?.source ?? 'workspace', tool: pending?.tools?.join(' · ') ?? null,
        time, reason: pending?.reason?.reason ?? null, reasonOrigin: pending?.reason ? 'agent' : null };
    }
    const lines = meaningfulLines(file.hunks);
    for (const record of this.recorded.iterate(file.path, branch)) {
      const match = lines.size
        ? JSON.parse(record.hunks).some(hunk => changedLines(hunk).some(line => lines.has(line)))
        : !file.hunks.length && record.status === file.status && record.old_mode === file.oldMode && record.new_mode === file.newMode;
      if (match) return { source: record.source, tool: record.tool, time: record.time, reason: record.reason, reasonOrigin: record.reason_origin, record };
    }
    return { source: 'workspace', tool: null, time, reason: null, reasonOrigin: null };
  }

  list({ branch, source, search } = {}) {
    const items = [...this.items.values()].map(item => item.metadata).filter(item => !branch || item.branch === branch);
    const query = search?.trim().toLowerCase();
    const changes = items.filter(item => (!source || item.source === source) &&
      (!query || [item.first_path, item.reason, item.tool].some(value => value?.toLowerCase().includes(query))));
    return {
      changes: changes.sort((a, b) => b.time - a.time || a.first_path.localeCompare(b.first_path)),
      stats: { changes: items.length, latest: null },
      hasMore: false,
    };
  }

  detail(id, language) {
    const item = this.items.get(id);
    if (!item) return null;
    const hunk = item.file.hunks.find(hunk => hunk.summary) ?? item.file.hunks[0];
    return {
      ...item.metadata, files: [fileMetadata(item.file)],
      reason_evidence: { position: 0, sample: hunk ? describeHunk(hunk, language) : null },
    };
  }

  patch(id) {
    const item = this.items.get(id);
    if (!item) return null;
    const { file, record } = item;
    if (!record) return file.hunks;
    const notes = new Map((this.journal.patch(record.id, record.position) ?? []).filter(hunk => hunk.explanation)
      .map(hunk => [JSON.stringify(changedLines(hunk)), hunk]));
    return file.hunks.map(hunk => {
      const note = notes.get(JSON.stringify(changedLines(hunk)));
      return note ? { ...hunk, explanation: note.explanation, explanation_origin: note.explanation_origin } : hunk;
    });
  }
}
