import 'dotenv/config';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { basename, join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { parse, stringify } from 'yaml';
import { scenarioSchema } from '../config.js';
import { Platform } from '../platform.js';
import { computeChecks } from './checks.js';
import { db, getSetting, setSetting } from './db.js';

const ROOT = process.cwd();
const PORT = Number(process.env.UI_PORT ?? 4173);
const ENV_FILE = join(ROOT, '.env');
const SCEN = join(ROOT, 'scenarios');
const RUNS = join(ROOT, 'runs');
mkdirSync(SCEN, { recursive: true });
mkdirSync(RUNS, { recursive: true });
const JOBS_DIR = join(ROOT, 'data', 'jobs');
mkdirSync(JOBS_DIR, { recursive: true });

// ---------- .env helpers (token/keys are managed from the UI; never returned to the browser) ----------
const readEnv = () => (existsSync(ENV_FILE) ? dotenv.parse(readFileSync(ENV_FILE)) : {});
function writeEnv(updates: Record<string, string>) {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  for (const [k, v] of Object.entries(updates)) {
    if (/[\r\n]/.test(v)) throw new Error(`Invalid value for ${k}`);
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => `${k}=${v}`) : `${text.replace(/\n*$/, '\n')}${k}=${v}\n`;
  }
  writeFileSync(ENV_FILE, text, { mode: 0o600 });
}
function jwtExpiry(token?: string): number | null {
  try {
    const p = JSON.parse(Buffer.from(token!.split('.')[1], 'base64url').toString());
    return typeof p.exp === 'number' ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}
const platform = () => {
  const e = readEnv();
  if (!e.VM_BEARER_TOKEN) throw new Error('No bearer token set. Add one in Settings.');
  return new Platform(e.PLATFORM_ORIGIN || 'https://de-agents.kore.ai', e.VM_BEARER_TOKEN);
};

// ---------- scenarios (SQLite is the source of truth; YAML under scenarios/ is only the first-run seed) ----------
const RE_COUNTRY = /^[A-Za-z]{2}$/;
const RE_LANG = /^[a-z]{2,3}-[A-Z]{2}$/;
const RE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const callerNo = (v: unknown) => {
  const n = String(v ?? '').replace(/[\s-]/g, '');
  if (n && !/^\+\d{6,15}$/.test(n)) throw new Error('Caller number must be E.164, e.g. +4915112345678');
  return n;
};
const J = (x: unknown) => JSON.stringify(x ?? {});
const P = (x: unknown) => JSON.parse(String(x ?? '{}'));
const scenarioKey = (c: string, l: string, id: string) => {
  if (!RE_COUNTRY.test(c) || !RE_LANG.test(l) || !RE_ID.test(id)) throw new Error('Invalid country, language or id');
  return `${c.toUpperCase()}/${l}/${id}.yaml`;
};
const readYaml = (f: string) => (parse(readFileSync(f, 'utf8')) ?? {}) as Record<string, any>;

function seedFromYaml() {
  if ((db.prepare('SELECT COUNT(*) n FROM countries').get() as any).n > 0 || !existsSync(SCEN)) return;
  for (const c of readdirSync(SCEN, { withFileTypes: true }).filter((d) => d.isDirectory() && RE_COUNTRY.test(d.name))) {
    const cdir = join(SCEN, c.name);
    const cf = join(cdir, 'country.yaml');
    const cfg = existsSync(cf) ? readYaml(cf) : {};
    db.prepare('INSERT OR REPLACE INTO countries (code, name, connection_id, facts, answers) VALUES (?,?,?,?,?)').run(c.name, cfg.name ?? c.name, cfg.connectionId ?? '', J(cfg.facts), J(cfg.answers));
    for (const l of readdirSync(cdir, { withFileTypes: true }).filter((d) => d.isDirectory() && RE_LANG.test(d.name))) {
      db.prepare('INSERT OR IGNORE INTO languages (country, language) VALUES (?,?)').run(c.name, l.name);
      for (const f of readdirSync(join(cdir, l.name)).filter((x) => x.endsWith('.yaml'))) {
        const id = basename(f, '.yaml');
        db.prepare('INSERT OR REPLACE INTO scenarios (path, country, language, id, data, updated_at) VALUES (?,?,?,?,?,?)').run(`${c.name}/${l.name}/${f}`, c.name, l.name, id, J(readYaml(join(cdir, l.name, f))), Date.now());
      }
    }
  }
}

function tree() {
  const countries = db.prepare('SELECT * FROM countries ORDER BY code').all() as any[];
  return countries.map((c) => {
    const langs = (db.prepare('SELECT language FROM languages WHERE country = ? ORDER BY language').all(c.code) as any[]).map((l) => ({
      language: l.language,
      scenarios: (db.prepare('SELECT path, id, data FROM scenarios WHERE country = ? AND language = ? ORDER BY id').all(c.code, l.language) as any[]).map((s) => ({ id: s.id, goal: P(s.data).goal ?? '', path: s.path })),
    }));
    return { code: c.code, name: c.name, connectionId: c.connection_id, callMode: c.call_mode ?? 'studio', callerNumber: c.caller_number ?? '', facts: P(c.facts), answers: P(c.answers), languages: langs };
  });
}
const getScenario = (path: string) => {
  const r = db.prepare('SELECT data FROM scenarios WHERE path = ?').get(path) as any;
  if (!r) throw new Error('Scenario not found');
  return P(r.data);
};

// ---------- runs ----------
/** Overall verdict: booking scenarios pass only when every stage check passes; others pass when the call ended normally. */
function verdictOf(r: any): 'pass' | 'fail' | 'cancelled' | null {
  if (r.status === 'cancelled') return 'cancelled';
  if (r.status === 'queued' || r.status === 'running') return null;
  if (r.status === 'failed' && !r.end_reason) return 'fail';
  const end = String(r.end_reason ?? '');
  if (/^error|max_duration|gemini_error|call_failed/.test(end)) return 'fail';
  if (r.checks_total != null) return r.checks_passed === r.checks_total ? 'pass' : 'fail';
  return /^(caller_ended|call_ended_by_agent)/.test(end) ? 'pass' : 'fail';
}
const rowToRun = (r: any) => ({
  verdict: verdictOf(r),
  id: r.id, status: r.status, scenarioId: r.scenario_id, scenarioPath: r.scenario_path, country: r.country, language: r.language,
  endReason: r.end_reason, error: r.error, durationMs: r.duration_ms, p50: r.p50, p95: r.p95, turns: r.turns, sipCallId: r.sip_call_id, sipUser: r.sip_user, platformSessionId: r.platform_session_id, callSid: r.call_sid, traceId: r.trace_id, checksPassed: r.checks_passed, checksTotal: r.checks_total,
  runDir: r.run_dir, queuedAt: r.queued_at, startedAt: r.started_at ?? r.queued_at, endedAt: r.ended_at,
});
const listRuns = () => (db.prepare('SELECT * FROM runs ORDER BY queued_at DESC LIMIT 500').all() as any[]).map(rowToRun);

/** The platform returns its trace/session id and call sid as headers on the INVITE's 200 OK. */
function sipIds(r: any): { sessionId: string | null; callSid: string | null } {
  let sessionId: string | null = null;
  let callSid: string | null = null;
  for (const m of r.sipLog ?? []) {
    const h = m.headers ?? {};
    const trace = String(h['X-Trace-Id']?.[0] ?? '').trim();
    const sid = String(h['X-Call-Sid']?.[0] ?? '').trim();
    if (/^[0-9a-f]{32}$/i.test(trace)) sessionId = trace;
    if (sid) callSid = sid;
  }
  return { sessionId, callSid };
}

function ingestReport(id: string, dir: string, status: 'done' | 'failed' = 'done') {
  const f = join(RUNS, dir, 'report.json');
  if (!existsSync(f)) return false;
  const r = JSON.parse(readFileSync(f, 'utf8'));
  const ids = sipIds(r);
  db.prepare('UPDATE runs SET trace_id=?, call_sid=? WHERE id=?').run(ids.sessionId, ids.callSid, id);
  const ck = computeChecks(r);
  db.prepare('UPDATE runs SET checks_passed=?, checks_total=? WHERE id=?').run(ck.applicable ? ck.passed : null, ck.applicable ? ck.total : null, id);
  db.prepare(
    `UPDATE runs SET status=?, end_reason=?, duration_ms=?, p50=?, p95=?, turns=?, sip_call_id=?, sip_user=?, run_dir=?, report=?,
       scenario_id=COALESCE(scenario_id,?), language=COALESCE(language,?), country=COALESCE(country,?), scenario_path=COALESCE(scenario_path,?) WHERE id=?`,
  ).run(status, r.endReason ?? null, r.durationMs ?? null, r.latencyMs?.p50 ?? null, r.latencyMs?.p95 ?? null, r.transcript?.length ?? 0, r.sipCallId ?? null, r.sipUser ?? null, dir, JSON.stringify(r), r.scenario?.id ?? null, r.scenario?.language ?? null, r.meta?.country ?? null, r.meta?.scenarioPath ?? null, id);
  return true;
}
function importOldRuns() {
  for (const dir of readdirSync(RUNS).filter((d) => /^\d{4}-/.test(d))) {
    if (db.prepare('SELECT 1 FROM runs WHERE id = ? OR run_dir = ?').get(dir, dir)) continue;
    if (!existsSync(join(RUNS, dir, 'report.json'))) continue;
    const r = JSON.parse(readFileSync(join(RUNS, dir, 'report.json'), 'utf8'));
    const ts = r.meta?.startedAt ?? Date.parse(dir.slice(0, 24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z')) ?? Date.now();
    db.prepare('INSERT INTO runs (id, status, queued_at, started_at) VALUES (?,?,?,?)').run(dir, 'done', ts, ts);
    ingestReport(dir, dir);
  }
}

// ---------- scheduler: runs several calls in parallel, up to the "max concurrent calls" setting ----------
const MAX_CAP = 10;
const maxConcurrent = () => Math.min(MAX_CAP, Math.max(1, Number(getSetting('maxConcurrent', '3')) || 3));
const children = new Map<string, ChildProcess>();
const seqs = new Map<string, { line: number; log: number }>();

function enqueue(rel: string, repeat = 1) {
  const scenario = getScenario(rel);
  const [country, language] = rel.split('/');
  const ids: string[] = [];
  for (let i = 0; i < repeat; i++) {
    const id = String(Date.now()) + Math.random().toString(36).slice(2, 6);
    db.prepare('INSERT INTO runs (id, scenario_path, country, language, scenario_id, status, queued_at) VALUES (?,?,?,?,?,?,?)').run(id, rel, country, language, scenario.id, 'queued', Date.now());
    ids.push(id);
  }
  pump();
  return ids;
}

function pump() {
  while (children.size < maxConcurrent()) {
    const row = db.prepare("SELECT * FROM runs WHERE status = 'queued' ORDER BY queued_at LIMIT 1").get() as any;
    if (!row) return;
    start(row);
  }
}

function start(row: any) {
  const id = row.id as string;
  let jobFile = '';
  try {
    const scenario = getScenario(row.scenario_path);
    const c = db.prepare('SELECT * FROM countries WHERE code = ?').get(row.country) as any;
    scenario.facts = { ...P(c?.facts), ...(scenario.facts ?? {}) };
    scenario.answers = { ...P(c?.answers), ...(scenario.answers ?? {}) };
    scenario.language = row.language;
    jobFile = join(JOBS_DIR, `${id}.json`);
    writeFileSync(jobFile, JSON.stringify({ scenario, country: row.country, connectionId: scenario.connectionId || c?.connection_id || '', callMode: scenario.callMode || c?.call_mode || 'studio', callerNumber: scenario.callerNumber || c?.caller_number || getSetting('callerNumber', ''), scenarioPath: row.scenario_path }), { mode: 0o600 });
  } catch (e) {
    db.prepare("UPDATE runs SET status='failed', error=?, ended_at=? WHERE id=?").run(e instanceof Error ? e.message : String(e), Date.now(), id);
    return;
  }
  db.prepare("UPDATE runs SET status='running', started_at=? WHERE id=?").run(Date.now(), id);
  const child = spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/run.ts', jobFile], { cwd: ROOT, env: { ...process.env, ...readEnv() } });
  children.set(id, child);
  seqs.set(id, { line: 0, log: 0 });
  const tail: string[] = [];
  let runDir = '';
  const onData = (chunk: Buffer) => {
    const q = seqs.get(id)!;
    for (const line of chunk.toString().split('\n')) {
      if (!line.trim()) continue;
      if (line.startsWith('RUN_DIR ')) {
        runDir = basename(line.slice(8).trim());
        db.prepare('UPDATE runs SET run_dir=? WHERE id=?').run(runDir, id);
      } else if (line.startsWith('LINE ')) {
        try {
          const l = JSON.parse(line.slice(5));
          db.prepare('INSERT INTO run_lines (run_id, seq, t, who, text) VALUES (?,?,?,?,?)').run(id, q.line++, l.t, l.who, l.text);
        } catch {
          /* ignore malformed */
        }
      } else {
        tail.push(line.trimEnd());
        if (tail.length > 40) tail.shift();
        db.prepare('INSERT INTO run_log (run_id, seq, line) VALUES (?,?,?)').run(id, q.log++, line.trimEnd().slice(0, 500));
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('close', (code) => {
    children.delete(id);
    seqs.delete(id);
    try {
      rmSync(jobFile, { force: true });
    } catch {
      /* ignore */
    }
    const cancelled = (db.prepare('SELECT status FROM runs WHERE id=?').get(id) as any)?.status === 'cancelled';
    if (!cancelled) {
      const ok = code === 0 && runDir && ingestReport(id, runDir);
      if (!ok && runDir && ingestReport(id, runDir, 'failed')) {
        const rep = JSON.parse(readFileSync(join(RUNS, runDir, 'report.json'), 'utf8'));
        db.prepare('UPDATE runs SET error=? WHERE id=?').run(String(rep.error ?? rep.endReason ?? 'failed').slice(0, 400), id);
      } else if (!ok) {
        const err = tail.filter((l) => /error|HTTP|timeout|Expected/i.test(l)).slice(-2).join(' | ') || `exited with code ${code}`;
        db.prepare("UPDATE runs SET status='failed', error=? WHERE id=?").run(err, id);
      }
    }
    db.prepare('UPDATE runs SET ended_at=? WHERE id=?').run(Date.now(), id);
    pump();
  });
}

function cancel(id: string) {
  const r = db.prepare('SELECT status FROM runs WHERE id=?').get(id) as any;
  if (!r) throw new Error('Run not found');
  if (r.status === 'queued') db.prepare("UPDATE runs SET status='cancelled', ended_at=? WHERE id=?").run(Date.now(), id);
  else if (r.status === 'running') {
    db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(id);
    children.get(id)?.kill('SIGTERM');
  }
}

// ---------- HTTP ----------
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<any>((ok, bad) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 1_000_000) bad(new Error('Body too large'));
    });
    req.on('end', () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch (e) {
        bad(e);
      }
    });
  });

const server = createServer(async (req, res) => {
  try {
    const host = req.headers.host ?? '';
    if (!new RegExp(`^(localhost|127\\.0\\.0\\.1):${PORT}$`).test(host)) return send(res, 403, { error: 'Bad host' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    const p = url.pathname;
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    if (mutating && req.headers['x-vm-ui'] !== '1') return send(res, 403, { error: 'Missing UI header' });

    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(readFileSync(join(ROOT, 'src/ui/index.html')));
    }

    if (p === '/api/settings' && req.method === 'GET') {
      const e = readEnv();
      return send(res, 200, {
        origin: e.PLATFORM_ORIGIN ?? '',
        projectId: e.PROJECT_ID ?? '',
        hasToken: !!e.VM_BEARER_TOKEN,
        tokenExpiresAt: jwtExpiry(e.VM_BEARER_TOKEN),
        hasGeminiKey: !!e.GEMINI_API_KEY,
        liveModel: e.GEMINI_LIVE_MODEL ?? '',
        judgeModel: e.GEMINI_JUDGE_MODEL ?? '',
        authFailed: !!db.prepare("SELECT 1 FROM runs WHERE status='failed' AND error LIKE '%HTTP 401%' AND error NOT LIKE '%(retried)' AND queued_at > ? LIMIT 1").get(Date.now() - 6 * 3600_000),
        callerNumber: getSetting('callerNumber', ''),
        maxConcurrent: maxConcurrent(),
        maxConcurrentCap: MAX_CAP,
      });
    }
    if (p === '/api/settings' && req.method === 'PUT') {
      const b = await readBody(req);
      const map: Record<string, string> = { origin: 'PLATFORM_ORIGIN', projectId: 'PROJECT_ID', token: 'VM_BEARER_TOKEN', geminiKey: 'GEMINI_API_KEY', liveModel: 'GEMINI_LIVE_MODEL', judgeModel: 'GEMINI_JUDGE_MODEL' };
      const upd: Record<string, string> = {};
      for (const [k, envKey] of Object.entries(map)) if (typeof b[k] === 'string' && b[k].trim()) upd[envKey] = b[k].trim();
      if (upd.PLATFORM_ORIGIN && !/^https:\/\/[\w.-]+(:\d+)?$/.test(upd.PLATFORM_ORIGIN)) throw new Error('Platform origin must be an https origin');
      writeEnv(upd);
      if (b.callerNumber !== undefined) setSetting('callerNumber', callerNo(b.callerNumber));
      if (b.maxConcurrent !== undefined) {
        const n = Number(b.maxConcurrent);
        if (!Number.isInteger(n) || n < 1 || n > MAX_CAP) throw new Error(`Max concurrent calls must be 1 to ${MAX_CAP}`);
        setSetting('maxConcurrent', String(n));
        pump();
      }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/token' && req.method === 'POST') {
      const b = await readBody(req);
      const token = String(b.token ?? '').trim();
      if (!token || /\s/.test(token)) throw new Error('Paste the bearer token (no spaces)');
      writeEnv({ VM_BEARER_TOKEN: token });
      let retried = 0;
      if (b.retry !== false) {
        const failed = db.prepare("SELECT id, scenario_path FROM runs WHERE status='failed' AND error LIKE '%HTTP 401%' AND error NOT LIKE '%(retried)' AND queued_at > ? AND scenario_path IS NOT NULL").all(Date.now() - 6 * 3600_000) as any[];
        for (const r of failed) {
          try {
            enqueue(r.scenario_path);
            db.prepare("UPDATE runs SET error = error || ' (retried)' WHERE id = ?").run(r.id);
            retried++;
          } catch {
            /* scenario deleted since */
          }
        }
      }
      return send(res, 200, { ok: true, retried });
    }
    if (p === '/api/settings/test' && req.method === 'POST') {
      const pf = platform();
      const cfg = await pf.softphoneConfig();
      const rows = await pf.targets(readEnv().PROJECT_ID);
      return send(res, 200, { ok: true, sipDomain: cfg.sipDomain, targets: rows.length });
    }
    if (p === '/api/channels' && req.method === 'GET') {
      const rows = await platform().targets(readEnv().PROJECT_ID);
      const by = new Map<string, { connectionId: string; name: string; type: string; phone: string; studio: boolean }>();
      for (const r of rows) {
        const c = by.get(r.connectionId) ?? { connectionId: r.connectionId, name: '', type: '', phone: '', studio: false };
        if (r.channelName) c.name = r.channelName;
        if (r.channelType) c.type = r.channelType;
        if (r.kind === 'phone_number') c.phone = r.number;
        if (r.kind === 'studio_test_call') c.studio = true;
        by.set(r.connectionId, c);
      }
      return send(res, 200, [...by.values()]);
    }

    if (p === '/api/tree' && req.method === 'GET') return send(res, 200, tree());
    if (p === '/api/country' && req.method === 'PUT') {
      const b = await readBody(req);
      if (!RE_COUNTRY.test(b.code ?? '')) throw new Error('Country code must be 2 letters');
      const code = b.code.toUpperCase();
      db.prepare('INSERT INTO countries (code, name, connection_id, call_mode, caller_number, facts, answers) VALUES (?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name, connection_id=excluded.connection_id, call_mode=excluded.call_mode, caller_number=excluded.caller_number, facts=excluded.facts, answers=excluded.answers').run(code, b.name || code, b.connectionId ?? '', b.callMode === 'phone' ? 'phone' : 'studio', callerNo(b.callerNumber), J(b.facts), J(b.answers));
      return send(res, 200, { ok: true });
    }
    if (p === '/api/language' && req.method === 'POST') {
      const b = await readBody(req);
      if (!RE_COUNTRY.test(b.country ?? '') || !RE_LANG.test(b.language ?? '')) throw new Error('Invalid country or language');
      db.prepare('INSERT OR IGNORE INTO languages (country, language) VALUES (?,?)').run(b.country.toUpperCase(), b.language);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/scenario' && req.method === 'GET') return send(res, 200, getScenario(url.searchParams.get('path') ?? ''));
    if (p === '/api/scenario' && req.method === 'PUT') {
      const b = await readBody(req);
      const key = scenarioKey(b.country, b.language, b.data?.id ?? '');
      const data = scenarioSchema.parse({ ...b.data, language: b.language });
      const c = b.country.toUpperCase();
      db.prepare('INSERT OR IGNORE INTO languages (country, language) VALUES (?,?)').run(c, b.language);
      db.prepare('INSERT INTO scenarios (path, country, language, id, data, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at').run(key, c, b.language, data.id, J(data), Date.now());
      return send(res, 200, { ok: true, path: key });
    }
    if (p === '/api/scenario' && req.method === 'DELETE') {
      db.prepare('DELETE FROM scenarios WHERE path = ?').run(url.searchParams.get('path') ?? '');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const b = await readBody(req);
      const paths: string[] = Array.isArray(b.paths) ? b.paths : [];
      const repeat = Math.min(20, Math.max(1, Number(b.repeat) || 1));
      if (!paths.length || paths.length * repeat > 100) throw new Error('Pick up to 100 runs in total');
      return send(res, 200, paths.flatMap((x) => enqueue(x, repeat)));
    }
    const ms = /^\/api\/runs\/([\w.-]+)\/session$/.exec(p);
    if (ms && req.method === 'PUT') {
      const b = await readBody(req);
      const sid = String(b.sessionId ?? '').trim();
      if (sid && !/^[A-Za-z0-9_-]{8,64}$/.test(sid)) throw new Error('Session id looks wrong (expected a 32-character id)');
      db.prepare('UPDATE runs SET platform_session_id=? WHERE id=?').run(sid || null, ms[1]);
      return send(res, 200, { ok: true });
    }
    const mc = /^\/api\/run\/([\w.-]+)\/cancel$/.exec(p);
    if (mc && req.method === 'POST') {
      cancel(mc[1]);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/jobs' && req.method === 'GET') {
      const rows = db.prepare("SELECT * FROM runs WHERE status IN ('queued','running') OR queued_at > ? ORDER BY queued_at DESC LIMIT 30").all(Date.now() - 6 * 3600_000) as any[];
      return send(res, 200, {
        max: maxConcurrent(),
        jobs: rows.map((r) => ({
          ...rowToRun(r),
          lines: r.status === 'running' ? (db.prepare('SELECT t, who, text FROM run_lines WHERE run_id=? ORDER BY seq DESC LIMIT 6').all(r.id) as any[]).reverse() : [],
        })),
      });
    }

    if (p === '/api/runs' && req.method === 'GET') return send(res, 200, listRuns());
    const m = /^\/api\/runs\/([\w.-]+)(?:\/(agent|caller)\.wav)?$/.exec(p);
    if (m) {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(m[1]) as any;
      if (!row) return send(res, 404, { error: 'Not found' });
      const dir = row.run_dir ? join(RUNS, row.run_dir) : '';
      if (!m[2]) {
        if (req.method === 'DELETE') {
          if (row.status === 'running' || row.status === 'queued') throw new Error('Cancel the run first');
          db.prepare('DELETE FROM run_lines WHERE run_id=?').run(m[1]);
          db.prepare('DELETE FROM run_log WHERE run_id=?').run(m[1]);
          db.prepare('DELETE FROM runs WHERE id=?').run(m[1]);
          if (dir && resolve(dir).startsWith(RUNS + '/')) rmSync(dir, { recursive: true, force: true });
          return send(res, 200, { ok: true });
        }
        return send(res, 200, {
          run: rowToRun(row),
          report: row.report ? JSON.parse(row.report) : null,
          checks: row.report ? computeChecks(JSON.parse(row.report)) : null,
          lines: db.prepare('SELECT t, who, text FROM run_lines WHERE run_id=? ORDER BY seq').all(m[1]),
          log: (db.prepare('SELECT line FROM run_log WHERE run_id=? ORDER BY seq DESC LIMIT 25').all(m[1]) as any[]).map((x) => x.line).reverse(),
        });
      }
      const file = dir ? join(dir, `${m[2]}.wav`) : '';
      if (!file || !existsSync(file)) return send(res, 404, { error: 'No audio' });
      const size = statSync(file).size;
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        res.writeHead(206, { 'content-type': 'audio/wav', 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
        return createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': size });
      return createReadStream(file).pipe(res);
    }
    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
});

db.prepare("UPDATE runs SET status='failed', error='Server restarted while running', ended_at=? WHERE status IN ('running','queued')").run(Date.now());
seedFromYaml();
importOldRuns();
for (const r of db.prepare('SELECT id, report FROM runs WHERE report IS NOT NULL').all() as any[]) {
  const ck = computeChecks(JSON.parse(r.report));
  db.prepare('UPDATE runs SET checks_passed=?, checks_total=? WHERE id=?').run(ck.applicable ? ck.passed : null, ck.applicable ? ck.total : null, r.id);
}
spawnSync('node', ['scripts/build-browser.mjs'], { cwd: ROOT, stdio: 'inherit' });
server.listen(PORT, '127.0.0.1', () => console.log(`VM_Automation UI: http://localhost:${PORT}`));
