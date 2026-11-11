import fs from 'node:fs';
import path from 'node:path';

/**
 * Tiny JSON-file store so the game runs with zero setup.
 * All reads are in-memory; writes are debounced and atomic (tmp file + rename).
 * To move to Postgres/Redis later, replace this class and the few call sites in index.js.
 */
export class Store {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = {};
    }
    this.data.users ??= {};
    this.data.sessions ??= {};
    this.timer = null;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
  }

  flush() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
