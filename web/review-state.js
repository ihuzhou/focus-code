function key(change) {
  return change.uncommitted ? `live:${change.branch}:${change.id}` : `history:${change.id}`;
}

function revision(change) {
  return String(change.uncommitted ? change.diff_revision : change.time);
}

export function sameReviewVersion(left, right) {
  return Boolean(left && right && key(left) === key(right) && revision(left) === revision(right));
}

export class ReviewState {
  constructor(read, write) {
    this.read = read;
    this.write = write;
    this.projects = new Map();
  }

  storageKey(project) {
    return `focus-code-reviewed:${project}`;
  }

  entries(project) {
    if (!this.projects.has(project)) {
      let entries;
      try { entries = new Map(JSON.parse(this.read(this.storageKey(project))) ?? []); }
      catch { entries = new Map(); }
      this.projects.set(project, entries);
    }
    return this.projects.get(project);
  }

  has(project, change) {
    return this.entries(project).get(key(change)) === revision(change);
  }

  mark(project, change) {
    if (!project || this.has(project, change)) return false;
    const entries = this.entries(project);
    entries.set(key(change), revision(change));
    this.write(this.storageKey(project), JSON.stringify([...entries]));
    return true;
  }

  invalidate() {
    this.projects.clear();
  }
}
