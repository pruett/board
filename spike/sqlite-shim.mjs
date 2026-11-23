// node:sqlite's DatabaseSync, backed by the Durable Object's ctx.storage.sql (globalThis.__doSql).
const SKIP = /^\s*(pragma\s+(journal_mode|synchronous|busy_timeout)|begin|commit|rollback)\b/i;
const fix = (r) => { for (const k in r) if (r[k] instanceof ArrayBuffer) r[k] = new Uint8Array(r[k]); return r; };
const args = (p) => p.map((v) => (typeof v === "bigint" ? Number(v) : v === undefined ? null : v));
export class StatementSync {
  constructor(sql, text) { this.sql = sql; this.text = text; }
  run(...p) { const c = this.sql.exec(this.text, ...args(p)); c.toArray(); return { changes: c.rowsWritten, lastInsertRowid: 0 }; }
  all(...p) { return this.sql.exec(this.text, ...args(p)).toArray().map(fix); }
  get(...p) { const r = this.sql.exec(this.text, ...args(p)).toArray()[0]; return r ? fix(r) : undefined; }
  *iterate(...p) { for (const r of this.sql.exec(this.text, ...args(p))) yield fix(r); }
  setReadBigInts() {} setAllowBareNamedParameters() {}
}
export class DatabaseSync {
  constructor() { this.sql = globalThis.__doSql; if (!this.sql) throw new Error("no __doSql"); }
  exec(text) {
    if (SKIP.test(text)) { globalThis.__shimLog?.push(text.trim().slice(0, 30)); return; }
    this.sql.exec(text);
  }
  prepare(text) { return new StatementSync(this.sql, text); }
  close() {}
  get isOpen() { return true; }
  get isTransaction() { return false; }
}
export default { DatabaseSync, StatementSync };
