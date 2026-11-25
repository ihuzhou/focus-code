import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Journal } from './journal.js';
import { hash } from './repository.js';

export const archiveLimit = 32 * 1024 * 1024;
export const archiveRoot = id => `archive:${id}`;
export const archiveDirectory = directory => join(directory, 'review-archives');
const format = 'focus-code-history';
const version = 1;
const sources = new Set(['codex', 'claude', 'pi', 'opencode', 'gemini', 'trae', 'trae-cli', 'workspace', 'mixed']);
const origins = new Set(['agent', 'user']);
const statuses = new Set(['added', 'modified', 'deleted']);
const limitations = new Set(['binary', 'large', 'complex']);
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0');
const nullable = (value, max) => value === null || text(value, max);
const mode = value => value === null || (typeof value === 'string' && /^[0-7]{6}$/.test(value));
const pathName = value => text(value, 4096) && value.split('/').every(part => part && part !== '.' && part !== '..');
const hunkFields = ({ oldStart, oldLines, newStart, newLines, lines }) => ({ oldStart, oldLines, newStart, newLines, lines });
const withoutNotes = ({ notes, ...file }) => file;
const identity = ({ time, source, tool, branch, files }) => hash(JSON.stringify([time, source, tool, branch, files.map(withoutNotes)]));

function validHunk(hunk) {
  return hunk && [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(value => integer(value, 2 ** 31)) &&
    Array.isArray(hunk.lines) && hunk.lines.every(line => text(line, 262145) && /^[ +\-\\]/.test(line));
}

function validFile(file) {
  return file && pathName(file.path) && statuses.has(file.status) && (file.limitation === null || limitations.has(file.limitation)) &&
    mode(file.old_mode) && mode(file.new_mode) && Array.isArray(file.hunks) && file.hunks.every(validHunk) &&
    Array.isArray(file.notes) && file.notes.every(note => note && integer(note.hunk, file.hunks.length - 1) &&
      text(note.explanation, 1000) && origins.has(note.origin)) && new Set(file.notes.map(note => note.hunk)).size === file.notes.length;
}

function validRecord(record) {
  return record && integer(record.time, 8_640_000_000_000_000) && sources.has(record.source) && nullable(record.tool, 8192) &&
    text(record.branch, 1024) && record.branch && nullable(record.reason, 1000) &&
    (record.reason_origin === null || origins.has(record.reason_origin)) &&
    Array.isArray(record.files) && record.files.length > 0 && record.files.every(validFile);
}

function archiveFile({ path, status, limitation, old_mode, new_mode, hunks, notes }) {
  return { path, status, limitation, old_mode, new_mode, hunks: hunks.map(hunkFields),
    notes: notes.map(({ hunk, explanation, origin }) => ({ hunk, explanation, origin })).sort((a, b) => a.hunk - b.hunk) };
}

function archiveRecord({ time, source, tool, branch, reason, reason_origin, files }) {
  return { time, source, tool, branch, reason, reason_origin, files: files.map(archiveFile) };
}

function readFiles(db) {
  const files = db.prepare('SELECT position, path, status, limitation, old_mode, new_mode, hunks FROM files WHERE change_id = ? ORDER BY position');
  const notes = db.prepare(`SELECT hunk, explanation, origin FROM hunk_notes
    WHERE change_id = ? AND position = ? AND explanation IS NOT NULL ORDER BY hunk`);
  return (id, includeNotes) => files.all(id).map(({ position, hunks, ...file }) => archiveFile({
    ...file, hunks: JSON.parse(hunks), notes: includeNotes ? notes.all(id, position) : [],
  }));
}

export function exportArchive(project, branch) {
  if (!existsSync(project.path)) return { issue: 'emptyArchive' };
  const db = new DatabaseSync(project.path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000; BEGIN;');
    const withBranch = branch === undefined ? '' : 'WHERE branch = ?';
    const rows = db.prepare(`SELECT id, time, source, tool, branch, reason, reason_origin FROM changes ${withBranch} ORDER BY id`);
    const read = readFiles(db);
    const header = JSON.stringify({ format, version, name: project.name }).slice(0, -1) + ',"records":[';
    const parts = [header];
    let bytes = Buffer.byteLength(header) + 2;
    for (const { id, ...record } of rows.iterate(...(branch === undefined ? [] : [branch]))) {
      const body = JSON.stringify({ ...record, files: read(id, true) });
      bytes += Buffer.byteLength(body) + (parts.length > 1 ? 1 : 0);
      if (bytes > archiveLimit) return { issue: 'archiveTooLarge' };
      if (parts.length > 1) parts.push(',');
      parts.push(body);
    }
    if (parts.length === 1) return { issue: 'emptyArchive' };
    return { data: parts.join('') + ']}' };
  } finally { db.close(); }
}

function mergeRecords(journal, records) {
  return journal.transaction(() => {
    const db = journal.db;
    const matching = db.prepare('SELECT id, tool FROM changes WHERE time = ? AND source = ? AND branch = ?');
    const read = readFiles(db);
    let last = Math.max(journal.getMeta('lastClearedChangeId') ?? 0, db.prepare('SELECT coalesce(max(id), 0) id FROM changes').get().id);
    const change = db.prepare(`INSERT INTO changes (id, time, source, tool, branch, reason, reason_origin, file_count, added, removed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const file = db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const note = db.prepare('INSERT INTO hunk_notes VALUES (?, ?, ?, ?, ?, 1)');
    let imported = 0;
    for (const row of records) {
      const { time, source, tool, branch, reason, reason_origin, files } = row;
      const key = identity(row);
      if (matching.all(time, source, branch).some(saved => saved.tool === tool &&
        key === identity({ ...row, files: read(saved.id, false) }))) continue;
      const id = ++last;
      const deltas = files.map(item => {
        let added = 0, removed = 0;
        for (const hunk of item.hunks) for (const line of hunk.lines) {
          if (line[0] === '+') added++;
          if (line[0] === '-') removed++;
        }
        return { added, removed };
      });
      change.run(id, time, source, tool, branch, reason, reason_origin, files.length,
        deltas.reduce((sum, item) => sum + item.added, 0), deltas.reduce((sum, item) => sum + item.removed, 0));
      for (const [position, item] of files.entries()) {
        const { added, removed } = deltas[position];
        file.run(id, position, item.path, item.status, added, removed, item.limitation, item.old_mode, item.new_mode, JSON.stringify(item.hunks));
        for (const entry of item.notes) note.run(id, position, entry.hunk, entry.explanation, entry.origin);
      }
      imported++;
    }
    return imported;
  });
}

export function importArchive(bytes, directory, target) {
  if (bytes.byteLength > archiveLimit) return { issue: 'archiveTooLarge' };
  let input;
  try { input = JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { return { issue: 'invalidArchive' }; }
  if (input?.format !== format || input.version !== version || !text(input.name, 255) || !input.name.trim() ||
    !Array.isArray(input.records) || !input.records.length || !input.records.every(validRecord)) return { issue: 'invalidArchive' };
  const name = input.name.trim();
  const records = input.records.map(archiveRecord);
  const id = target?.id ?? hash(JSON.stringify([name, records]));
  const journal = target ? new Journal(target.root, directory) : new Journal(archiveRoot(id), archiveDirectory(directory));
  try {
    const imported = mergeRecords(journal, records);
    return { id, name, imported, skipped: records.length - imported };
  } finally { journal.close(); }
}
