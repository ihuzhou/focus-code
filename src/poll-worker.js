import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { Journal } from './journal.js';

// Full snapshot scans can take seconds in large worktrees. Keep them off the HTTP event loop.
if (!isMainThread) {
  parentPort.on('message', ({ id, root, directory }) => {
    let journal;
    try {
      journal = new Journal(root, directory);
      journal.poll();
      parentPort.postMessage({ id });
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
    this.worker.on('message', ({ id, error }) => {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      if (error) request.reject(new Error(error));
      else request.resolve();
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
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, root, directory });
    });
  }

  close() {
    return this.worker.terminate();
  }
}
