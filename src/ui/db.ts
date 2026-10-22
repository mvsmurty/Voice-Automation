import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

mkdirSync(join(process.cwd(), 'data'), { recursive: true });
export const db = new DatabaseSync(join(process.cwd(), 'data', 'vm.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec(`
CREATE TABLE IF NOT EXISTS countries (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, connection_id TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL DEFAULT '{}', answers TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS languages (
  country TEXT NOT NULL, language TEXT NOT NULL, PRIMARY KEY (country, language)
);
CREATE TABLE IF NOT EXISTS scenarios (
  path TEXT PRIMARY KEY, country TEXT NOT NULL, language TEXT NOT NULL, id TEXT NOT NULL,
  data TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scenario_path TEXT, country TEXT, language TEXT, scenario_id TEXT,
  status TEXT NOT NULL,            -- queued | running | done | failed | cancelled
  end_reason TEXT, error TEXT,
  queued_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER,
  duration_ms INTEGER, p50 INTEGER, p95 INTEGER, turns INTEGER,
  sip_call_id TEXT, run_dir TEXT,
  report TEXT                      -- full report.json once the call has finished
);
CREATE INDEX IF NOT EXISTS runs_started ON runs (queued_at DESC);
CREATE TABLE IF NOT EXISTS run_lines (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, t INTEGER NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS run_log (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL, line TEXT NOT NULL, PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

export const getSetting = (k: string, d: string) =>
  ((db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? d);
export const setSetting = (k: string, v: string) =>
  void db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

for (const col of ['platform_session_id', 'sip_user', 'call_sid', 'trace_id', 'checks_passed INTEGER', 'checks_total INTEGER']) {
  try {
    db.exec(`ALTER TABLE runs ADD COLUMN ${col.includes(' ') ? col : col + ' TEXT'}`);
  } catch {
    /* column already exists */
  }
}

try {
  db.exec("ALTER TABLE countries ADD COLUMN call_mode TEXT NOT NULL DEFAULT 'studio'");
} catch {
  /* column already exists */
}

try {
  db.exec("ALTER TABLE countries ADD COLUMN caller_number TEXT NOT NULL DEFAULT ''");
} catch {
  /* column already exists */
}
