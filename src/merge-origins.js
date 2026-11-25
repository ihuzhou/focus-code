import { applyPatch } from 'diff';
import { firstParentMerges, mergeBlobs, mergeDiffPaths, mergeTip } from './repository.js';

const maxMergeFiles = 128;

function matchesFile(file, changes, blobs) {
  const change = changes.get(file.path);
  if (!change || change.before?.mode !== (file.old_mode ?? undefined) || change.after?.mode !== (file.new_mode ?? undefined)) return false;
  const before = blobs.get(change.before?.oid);
  const after = blobs.get(change.after?.oid);
  if ((after?.fingerprint ?? null) !== file.fingerprint) return false;
  return applyPatch(before?.text ?? '', { hunks: JSON.parse(file.hunks) }, { fuzzFactor: 0 }) === (after?.text ?? '');
}

export class MergeOrigins {
  constructor(journal) {
    this.root = journal.root;
    this.branches = new Map();
    this.matches = new Map();
    this.bases = journal.db.prepare(`SELECT change_id id, base FROM timeline_pending
      WHERE base IS NOT NULL AND change_id IN (SELECT value FROM json_each(?))`);
    this.files = journal.db.prepare(`SELECT f.path, f.old_mode, f.new_mode, f.hunks, f.limitation, a.fingerprint
      FROM files f JOIN timeline_after a ON a.change_id = f.change_id AND a.position = f.position
      WHERE f.change_id = ?`);
  }

  async branchMerges(branch) {
    const head = await mergeTip(this.root, branch);
    const cached = this.branches.get(branch);
    if (cached?.head === head) return cached.merges;
    const merges = firstParentMerges(this.root, head);
    if (this.branches.size >= 16) this.branches.delete(this.branches.keys().next().value);
    this.branches.set(branch, { head, merges });
    try { return await merges; }
    catch (error) {
      if (this.branches.get(branch)?.merges === merges) this.branches.delete(branch);
      throw error;
    }
  }

  match(record, merge) {
    const key = `${merge.commit}:${record.id}:${record.time}`;
    if (this.matches.has(key)) return this.matches.get(key);
    if (this.matches.size >= 1024) this.matches.delete(this.matches.keys().next().value);
    const lookup = this.verify(record, merge).catch(() => {
      this.matches.delete(key);
      return false;
    });
    this.matches.set(key, lookup);
    return lookup;
  }

  async verify(record, merge) {
    merge.paths ??= mergeDiffPaths(this.root, merge.base, merge.commit)
      .then(paths => paths.size <= maxMergeFiles ? paths : null)
      .catch(error => {
        merge.paths = null;
        throw error;
      });
    const paths = await merge.paths;
    if (paths?.size !== record.file_count) return false;
    const files = this.files.all(record.id);
    if (files.length !== paths.size || files.some(file => file.limitation || !paths.has(file.path))) return false;
    const blobs = await mergeBlobs(this.root, paths);
    return Boolean(blobs && files.every(file => matchesFile(file, paths, blobs)));
  }

  async annotate(records) {
    const eligible = records.filter(record => record.file_count > 0 && record.file_count <= maxMergeFiles);
    if (!eligible.length) return records;
    const bases = new Map(this.bases.all(JSON.stringify(eligible.map(record => record.id))).map(row => [row.id, row.base]));
    const byBranch = new Map();
    for (const record of eligible) {
      if (!bases.has(record.id)) continue;
      if (!byBranch.has(record.branch)) byBranch.set(record.branch, []);
      byBranch.get(record.branch).push(record);
    }
    const labels = new Map();
    // Matching requires the same first-parent base, every path, and the stored patch/result.
    // Missing refs, large/binary files, and mixed local edits leave the original card untouched.
    await Promise.all([...byBranch].map(async ([branch, rows]) => {
      const merges = await this.branchMerges(branch).catch(() => null);
      if (!merges) return;
      for (const row of rows) {
        const merge = merges.get(bases.get(row.id));
        if (merge && await this.match(row, merge)) labels.set(row.id, merge.commit);
      }
    }));
    return records.map(row => labels.has(row.id) ? { ...row, merge_commit: labels.get(row.id) } : row);
  }
}
