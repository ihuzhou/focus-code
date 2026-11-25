import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { archiveDirectory, archiveRoot } from './history-archive.js';
import { Journal, journalPath } from './journal.js';
import { PollWorker } from './poll-worker.js';
import { stateDirectory, TrackingSettings } from './tracking.js';
import { hash, nestedWorktrees, repositoryRoot } from './repository.js';

const createCatalog = `
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, root TEXT NOT NULL, opened INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS viewer (slot INTEGER PRIMARY KEY CHECK (slot = 1), port INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS archives (id TEXT PRIMARY KEY, name TEXT NOT NULL, opened INTEGER NOT NULL);
`;

function openCatalog(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'projects.sqlite'));
  db.exec(`PRAGMA busy_timeout = 5000; ${createCatalog}`);
  return db;
}

export function rememberProject(root, directory = stateDirectory()) {
  const db = openCatalog(directory);
  const id = hash(root);
  try {
    db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, ?)').run(id, root, Date.now());
  } finally {
    db.close();
  }
  return id;
}

export function registeredRoot(id, directory = stateDirectory()) {
  if (typeof id !== 'string' || !/^[a-f\d]{64}$/.test(id)) return null;
  const db = openCatalog(directory);
  try {
    return db.prepare('SELECT root FROM projects WHERE id = ?').get(id)?.root ?? null;
  } finally {
    db.close();
  }
}

export function rememberedViewer(directory = stateDirectory()) {
  const db = openCatalog(directory);
  try {
    return db.prepare('SELECT port FROM viewer WHERE slot = 1').get()?.port;
  } finally {
    db.close();
  }
}

export class ProjectCatalog {
  constructor(initial, { demo, directory = initial && !demo ? dirname(initial.location) : stateDirectory() } = {}) {
    this.directory = directory;
    this.demo = Boolean(demo);
    this.projects = new Map();
    this.db = openCatalog(directory);
    this.tracking = new TrackingSettings(directory);
    this.initial = initial ? this.register(initial.root, { journal: initial, demo }) : null;
  }

  setViewer(port) {
    this.db.prepare('INSERT OR REPLACE INTO viewer VALUES (1, ?)').run(port);
  }

  register(root, { journal, demo = false } = {}) {
    const id = hash(root);
    const existing = this.projects.get(id);
    const project = existing ?? { id, root, demo, journal: journal ?? new Journal(root, this.directory), error: null };
    if (!demo && !existing?.demo) {
      this.db.prepare(`INSERT INTO projects VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET opened = excluded.opened`).run(id, root, Date.now());
    }
    this.projects.set(id, project);
    return project;
  }

  open(input) {
    const value = input.trim();
    const path = value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
    if (!isAbsolute(path) || path.includes('\0')) return null;
    const root = repositoryRoot(path);
    return root ? this.summary(this.register(root)) : null;
  }

  summary({ id, root, demo }) {
    return { id, name: basename(root), root: demo ? null : root, demo };
  }

  archives() {
    if (this.demo) return [];
    return this.db.prepare('SELECT id, name FROM archives ORDER BY opened DESC, name').all()
      .map(row => ({ ...row, root: null, archived: true }));
  }

  list() {
    const rows = this.db.prepare('SELECT id, root FROM projects ORDER BY opened DESC, root').all();
    return [...this.projects.values()].filter(project => project.demo).map(project => this.summary(project))
      .concat(rows.map(row => this.summary(row)), this.archives());
  }

  get(id) {
    const selected = id || this.initial?.id || this.db.prepare('SELECT id FROM projects ORDER BY opened DESC, root LIMIT 1').get()?.id
      || this.archives()[0]?.id;
    if (!selected) return null;
    if (this.projects.has(selected)) return this.projects.get(selected);
    const row = this.db.prepare('SELECT root FROM projects WHERE id = ?').get(selected);
    const archive = !row && !this.demo && this.db.prepare('SELECT name FROM archives WHERE id = ?').get(selected);
    if (!row && !archive) return null;
    const root = row?.root ?? archiveRoot(selected);
    const directory = archive ? archiveDirectory(this.directory) : this.directory;
    const project = { id: selected, root, demo: false, archived: Boolean(archive), name: archive?.name,
      journal: new Journal(root, directory), error: null };
    this.projects.set(selected, project);
    return project;
  }

  storageProjects() {
    const projects = this.list();
    if (this.demo) return projects.filter(project => project.demo).map(project => ({
      ...project, path: join(this.projects.get(project.id).journal.location, 'journal.sqlite'),
    }));
    const rows = projects.filter(project => !project.demo).map(project => ({ ...project, path: project.archived
      ? journalPath(archiveRoot(project.id), archiveDirectory(this.directory)) : journalPath(project.root, this.directory) }));
    const known = new Set(rows.map(row => row.id));
    // Older state or an interrupted hook can leave a journal without a catalog entry.
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      const id = entry.name;
      if (!entry.isDirectory() || !/^[a-f\d]{64}$/.test(id) || known.has(id)) continue;
      const path = join(this.directory, id, 'journal.sqlite');
      if (existsSync(path)) rows.push({ id, name: id.slice(0, 12), root: null, demo: false, path });
    }
    return rows;
  }

  storage(action, projects, branch) {
    return this.storageRequest({ action, projects, branch });
  }

  storageRequest(message) {
    // Archives and compaction should not block the viewer or queue behind a full workspace scan.
    this.storageWorker ??= new PollWorker();
    return this.storageWorker.request(message);
  }

  async restoreHistory(bytes, target) {
    const result = await this.storageRequest({ action: 'import', bytes, directory: this.directory, target });
    if (!result.issue && !target) {
      this.db.prepare('INSERT OR REPLACE INTO archives VALUES (?, ?, ?)').run(result.id, result.name, Date.now());
    }
    return result;
  }

  discover(project, now = Date.now()) {
    if (!project || project.demo || project.archived) return;
    if (project.discovering) return project.discovering;
    if (now < (project.nextDiscovery ?? 0)) return;
    project.nextDiscovery = now + 15_000;
    project.discovering = nestedWorktrees(project.root, this.directory).then(roots => {
      if (this.closing) return;
      // Add entries without opening their journals or displacing the explicitly opened project.
      const insert = this.db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?, 0)');
      for (const root of roots) insert.run(hash(root), root);
    }).finally(() => { project.discovering = null; });
    return project.discovering;
  }

  poll(project) {
    if (!project || project.archived || !project.journal.tracking.get(project.root).enabled) return;
    if (project.polling) return project.polling;
    this.poller ??= new PollWorker();
    project.polling = this.poller.poll(project.root, dirname(project.journal.location)).then(() => {
      project.error = null;
    }).catch(error => {
      if (!this.closing && project.error !== error.message) console.error(`Focus Code (${project.root}): ${error.message}`);
      project.error = error.message;
    }).finally(() => { project.polling = null; });
    return project.polling;
  }

  close() {
    this.closing = true;
    void this.poller?.close();
    void this.storageWorker?.close();
    for (const project of this.projects.values()) {
      project.current?.close();
      if (project !== this.initial) project.journal.close();
    }
    this.db.close();
    this.tracking.close();
  }
}
