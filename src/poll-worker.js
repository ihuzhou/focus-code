import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { exportArchive, importArchive } from './history-archive.js';
import { clearHistory, historyInventory } from './history-store.js';
import { Journal } from './journal.js';

// Full snapshot scans can take seconds in large worktrees. Keep them off the HTTP event loop.
if (!isMainThread) {
  parentPort.on('message', ({ id, action, root, directory, projects, branch, bytes, target }) => {
    let journal;
    try {
      let result;
      if (action === 'inventory') result = historyInventory(projects);
      else if (action === 'clear') result = clearHistory(projects, branch);
      else if (action === 'export') result = exportArchive(projects[0], branch);
      else if (action === 'import') result = importArchive(bytes, directory, target);
      else {
        journal = new Journal(root, directory);
        journal.poll();
      }
      parentPort.postMessage({ id, result });
    } catch (error) {
      parentPort.postMessage({ id, error: error.message });
    } finally {
      journal?.close();
    }
  });
}

export class PollWorker {
  constructor() {
    this.worker = new Worker(new URL(import.meta.url));
    this.pending = new Map();
    this.next = 0;
    this.worker.on('message', ({ id, error, result }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve(result);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => this.fail(new Error(`Workspace scanner exited (${code})`)));
  }

  fail(error) {
    this.error = error;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  poll(root, directory) {
    return this.request({ root, directory });
  }

  request(message) {
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...message });
    });
  }

  close() {
    return this.worker.terminate();
  }
}
