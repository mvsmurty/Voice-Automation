import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { SpeakerTrack, percentile, responseLatencies } from './audio.js';
import { env, loadCountry, loadScenario, scenarioSchema } from './config.js';
import { GeminiCaller } from './gemini.js';
import { Platform } from './platform.js';

const scenarioPath = process.argv[2];
if (!scenarioPath) throw new Error('Usage: npm run call -- scenarios/<file>.yaml  (or a .json job file from the UI)');
let scenario: ReturnType<typeof loadScenario>;
let country: string | undefined;
let connectionId: string;
let callMode: 'studio' | 'phone' = 'studio';
let callerNumber = '';
let metaPath = scenarioPath;
if (scenarioPath.endsWith('.json')) {
  // Job file written by the UI server: scenario already merged with country defaults.
  const job = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  scenario = scenarioSchema.parse(job.scenario);
  country = job.country;
  metaPath = job.scenarioPath ?? scenarioPath;
  connectionId = job.connectionId || env('CONNECTION_ID');
  callMode = job.callMode === 'phone' ? 'phone' : 'studio';
  callerNumber = /^\+\d{6,15}$/.test(job.callerNumber ?? '') ? job.callerNumber : '';
} else {
  scenario = loadScenario(scenarioPath);
  const c = loadCountry(scenarioPath);
  country = c.country;
  connectionId = c.config.connectionId || env('CONNECTION_ID');
}

const platform = new Platform(env('PLATFORM_ORIGIN', 'https://de-agents.kore.ai'), env('VM_BEARER_TOKEN'));
const projectId = env('PROJECT_ID');
const [cfg, target] = await Promise.all([
  platform.softphoneConfig(),
  platform.callTarget(projectId, connectionId, callMode),
]);

const outDir = join('runs', `${new Date().toISOString().replace(/[:.]/g, '-')}_${scenario.id}_${randomUUID().slice(0, 4)}`);
mkdirSync(outDir, { recursive: true });
console.log(`[${scenario.id}] ${scenario.language} -> ${outDir}`);
console.log(`RUN_DIR ${outDir}`);

const agentTrack = new SpeakerTrack();
const callerTrack = new SpeakerTrack();
const events: { t: number; event: string; detail?: string }[] = [];
const note = (event: string, detail?: string) => {
  events.push({ t: Date.now(), event, detail });
  console.log(`  ${event}${detail ? `: ${detail}` : ''}`);
};

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
let page: Page | undefined;
let caller: GeminiCaller | undefined;
let endReason = 'unknown';
const startedAt = Date.now();
let sipTrace: unknown[] = [];
const CONNECT_TIMEOUT_S = Number(process.env.CONNECT_TIMEOUT_S ?? 60);
const sipUser = `vm_${randomUUID().replaceAll('-', '')}`;

try {
  const context = await browser.newContext({ permissions: ['microphone'] });
  page = await context.newPage();
  const url = 'https://vm-automation.local/';
  await page.route('**/*', (route) =>
    route.request().url() === url
      ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>vm</title>' })
      : route.abort(),
  );
  await page.goto(url);
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') console.log(`  [browser ${m.type()}] ${m.text()}`);
  });

  // Browser -> Node: agent audio (16 kHz PCM16). Feed the track and the realtime caller.
  await page.exposeFunction('__agentAudio', (b64: string, t: number) => {
    agentTrack.push(Buffer.from(b64, 'base64'), t);
    caller?.sendAgentAudio(b64);
  });
  // Caller segments come from actual playback into the call, not from when the model generated audio.
  const callerSegs: { start: number; end: number }[] = [];
  await page.exposeFunction('__callerPlayback', (ev: 'start' | 'end', t: number) => {
    note(`caller-${ev}`, String(Math.round(t)));
    if (ev === 'start') callerSegs.push({ start: t, end: t });
    else if (callerSegs.length) callerSegs[callerSegs.length - 1].end = t;
  });
  await page.addScriptTag({ content: readFileSync('dist/phone.js', 'utf8') });

  const p = page;
  await p.evaluate(
    (o) => window.phone.start(o),
    { sipDomain: cfg.sipDomain, wsServers: cfg.wsServers, target, user: sipUser, callerNumber },
  );

  // Wait for the call to connect.
  const connectDeadline = Date.now() + CONNECT_TIMEOUT_S * 1000;
  for (;;) {
    const s = await p.evaluate(() => window.phone.state());
    if (s.connected) break;
    if (s.failed || s.ended) throw new Error(`Call did not connect: ${s.failReason || 'ended'}`);
    if (Date.now() > connectDeadline) throw new Error(`Call connect timeout (${CONNECT_TIMEOUT_S}s)`);
    await p.waitForTimeout(100);
  }
  note('call-connected');

  let endRefusals = 0;
  let finished!: (r: string) => void;
  const done = new Promise<string>((r) => (finished = r));

  caller = new GeminiCaller(env('GEMINI_API_KEY'), env('GEMINI_LIVE_MODEL', 'gemini-3.8-live'), scenario, {
    onAudio: (b64, rate) => {
      // Record what we say (24 kHz) so the WAV matches playback.
      callerTrack.push(Buffer.from(b64, 'base64'), Date.now());
      void p.evaluate(([d, r]) => window.phone.pushCaller(d as string, r as number), [b64, rate]);
    },
    onInterrupted: () => {
      note('caller-interrupted');
      void p.evaluate(() => window.phone.flushCaller());
    },
    onEndCall: (reason) => {
      // Guard: don't let the caller hang up mid-booking (e.g. while the agent is still finalizing).
      const said = caller!.agentSaid();
      const ready = !scenario.endRequires.length || scenario.endRequires.some((r) => new RegExp(r, 'i').test(said));
      if (!ready && ++endRefusals <= 3) {
        note('caller-end_call-refused', reason);
        return 'Do not hang up yet: the agent has not finished. Stay silent and keep listening until the agent announces the booking or order number, then say goodbye.';
      }
      if (!ready) note('caller-end_call-forced', 'agent never announced the expected result');
      note('caller-end_call', reason);
      // Let the goodbye finish playing before hanging up.
      setTimeout(() => finished(`caller_ended: ${reason}`), 4000);
    },
    onClose: () => finished('gemini_closed'),
    onHeldBack: (text) => note('caller-held-back', text),
    onLine: (l) => console.log(`LINE ${JSON.stringify(l)}`),
    onError: (e) => {
      note('gemini-error', e instanceof Error ? e.message : String(e));
      finished('gemini_error');
    },
  });
  await caller.connect();
  note('caller-ready');

  // Stop conditions: caller hangs up, agent hangs up, time limit.
  const watch = (async () => {
    while (Date.now() - startedAt < scenario.maxSeconds * 1000) {
      const s = await p.evaluate(() => window.phone.state());
      if (s.ended || s.failed) return `call_${s.ended ? 'ended_by_agent' : 'failed'}`;
      await p.waitForTimeout(250);
    }
    return 'max_duration';
  })();
  endReason = await Promise.race([done, watch]);
  note('stopping', endReason);

  const sipCallId = (await p.evaluate(() => window.phone.state())).sipCallId;
  const sipLog = await p.evaluate(() => window.phone.sipLog());
  sipTrace = await p.evaluate(() => window.phone.wsLog());
  await p.evaluate(() => window.phone.hangup());

  caller.close();
  agentTrack.save(join(outDir, 'agent.wav'), 16000);
  callerTrack.save(join(outDir, 'caller.wav'), 24000);

  const lat = responseLatencies(callerSegs, agentTrack.segments);
  const report = {
    scenario,
    meta: { country, scenarioPath: metaPath, startedAt },
    platform: { origin: platform.origin, projectId, connectionId, callMode, callerNumber, target },
    sipCallId,
    sipUser,
    sipLog,
    sipTrace,
    endReason,
    durationMs: Date.now() - startedAt,
    transcript: caller.transcript,
    latencyMs: { samples: lat.length, p50: percentile(lat, 50), p95: percentile(lat, 95), all: lat },
    events,
    note: 'Latency is measured from audio energy timestamps in the browser (caller segment end -> next agent segment start); it includes the caller model delay.',
  };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\nDone: ${endReason}. Turns: ${caller.transcript.length}. Latency p50=${report.latencyMs.p50}ms. See ${outDir}`);
} catch (err) {
  // Keep what we know about a failed call (SIP replies etc.) so the UI can show why.
  const msg = err instanceof Error ? err.message : String(err);
  let sipLog: unknown[] = [];
  let phoneState: unknown = null;
  try {
    sipLog = await page!.evaluate(() => window.phone.sipLog());
    sipTrace = await page!.evaluate(() => window.phone.wsLog());
    phoneState = await page!.evaluate(() => window.phone.state());
  } catch {
    /* page already gone */
  }
  writeFileSync(
    join(outDir, 'report.json'),
    JSON.stringify(
      {
        scenario,
        meta: { country, scenarioPath: metaPath, startedAt },
        platform: { origin: platform.origin, projectId, connectionId, callMode, callerNumber, target },
        sipUser,
        sipLog,
        sipTrace,
        phoneState,
        endReason: `error: ${msg}`,
        error: msg,
        durationMs: Date.now() - startedAt,
        transcript: caller?.transcript ?? [],
        latencyMs: { samples: 0, p50: null, p95: null, all: [] },
        events,
      },
      null,
      2,
    ),
  );
  throw err;
} finally {
  caller?.close();
  await browser.close();
}
