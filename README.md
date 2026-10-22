# VM_Automation

Automated voice-agent testing for Kore.ai Agent Platform projects. A realtime Gemini model plays the customer, calls your voice agent, holds a full conversation in the scenario's language, and records everything. You get a transcript, both-side audio, response-latency numbers and pass/fail stage checks for every call, without dialing a phone by hand.

It calls the agent through the same Studio web-voice test target the Studio dial pad uses (SIP over WebSocket / WebRTC), so no phone number or SIM is needed. It can also dial the channel's real phone number.

## What you get per call

Each call writes a folder under `runs/<time>_<scenario>_<id>/`:

| File | Contents |
|---|---|
| `report.json` | Scenario, SIP call ID, why the call ended, duration, full transcript of both sides, response latency (p50 / p95), event timeline |
| `agent.wav` | What the agent said |
| `caller.wav` | What the simulated customer said |

The web console (below) shows the same data, plus automatic stage checks for booking-style flows.

## Prerequisites

- **Node.js 22.13 or newer** (the console uses Node's built-in SQLite). Check with `node -v`.
- **A Gemini API key** with access to a Gemini Live model (default `gemini-3.8-live`). The same key is used for the caller.
- **A bearer token** for the platform environment, copied from the Studio UI (see "Bearer token" below).
- **Access to the platform project** you want to test, with a deployed voice channel.
- macOS, Linux or Windows. The first install downloads headless Chromium (about 100 MB).

## Quick start

```bash
git clone <repo-url> && cd VM_Automation      # or open the folder you were given
npm install
npx playwright install chromium
cp .env.example .env
npm run ui
```

Open **http://localhost:4173**, then:

1. **Settings** (top right): enter the platform origin, project ID, bearer token, Gemini key and models. Click **Test connection**. The values are saved to your local `.env`.
2. Pick a **voice channel** for your country (the line the caller dials).
3. Open a scenario, click **Run**, and watch the live transcript. When it finishes, open it under **Runs** to read the transcript and play both audio tracks.

You can also fill in `.env` by hand instead of using Settings (see "Configuration").

## Configuration

`.env` lives in the project folder and is read at start-up. It is gitignored. Never commit it, and never put real values in `.env.example`.

| Variable | Meaning |
|---|---|
| `PLATFORM_ORIGIN` | Platform base URL, for example `https://de-agents.kore.ai` |
| `PROJECT_ID` | Project (from the project URL) whose voice channels you test |
| `CONNECTION_ID` | Default voice channel to dial. Countries can override it. List channels with `npm run targets`. |
| `VM_BEARER_TOKEN` | Short-lived login token from Studio. Replace it when calls fail with HTTP 401. |
| `GEMINI_API_KEY` | Gemini key |
| `GEMINI_LIVE_MODEL` | Realtime caller model, default `gemini-3.8-live`. Avoid the `-extended-thinking` variant: it adds delay. |
| `GEMINI_JUDGE_MODEL` | Reserved for the automatic judge (not built yet). Use a normal text model such as `gemini-2.5-flash`. |
| `UI_PORT` | Optional. Console port, default `4173` |

### Bearer token

1. Sign in to Studio on the same environment.
2. Copy your access token from the browser (the one Studio sends as `Authorization: Bearer ...`).
3. Paste it into **Settings -> Bearer token** (or `VM_BEARER_TOKEN` in `.env`).

Tokens are short-lived, roughly an hour. The console shows how many minutes are left. If runs fail with HTTP 401, paste a fresh token and use **Save and retry failed runs** to re-queue them.

## Using the console

- **Scenarios**: organised as Country -> Language -> Scenario. Create, edit, duplicate and delete here.
- **Country settings**: voice channel, default dial mode, shared caller details (`facts`) and shared `answers` that apply to every scenario in the country.
- **Run / Run all**: run one scenario, or all in a language or country. You can repeat a run (up to 20 times) and queue up to 100 runs in total.
- **Max concurrent calls**: set in Settings. Each call runs its own headless browser and a Gemini Live session, so raise it carefully.
- **Runs**: history with duration, end reason, latency, stage checks, transcripts and audio. You can attach the platform session ID to a run so it is easy to find in the platform's own session view.
- **Cancel** stops a call in progress.

The console only listens on `127.0.0.1` and rejects requests with a different Host header. Do not expose it to a network.

## Command line

```bash
npm run targets                                            # list the project's voice channels and their connection IDs
npm run call -- scenarios/DE/de-DE/smoke-opening-hours.yaml   # run one scenario
npm run typecheck                                          # TypeScript check
```

`npm run call` writes the same `runs/` folder as the console but does not use the console's queue or database.

## Writing a scenario

A scenario describes who is calling and what they want. Example:

```yaml
id: book-wheel-change-en
language: en-US                      # language the caller speaks
persona: A polite customer calling a tyre shop. Speaks clear English.
goal: Book an appointment for a wheel change.
facts:                               # details the caller may give when asked
  full_name: "Max Mustermann"
  licence_plate: "H-SR 1605"
steps:                               # ordered script, one entry per beat
  - Listen to the greeting, then say "Let's talk in English, please."
  - When asked for your name, say "Max Mustermann".
  - Confirm the booking details if they are correct, then end the call.
behaviour: Short natural sentences. Never volunteer information before it is asked.
answers: {}                          # topic -> reply, for questions the agent may ask
endRequires: []                      # regexes; caller may hang up only after the agent says one
maxSeconds: 300                      # hard stop (20 to 600)
expect:                              # plain-language expectations (for review, and the future judge)
  - The agent reads back the licence plate and waits for confirmation.
```

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Letters, digits, `_` and `-` |
| `language` | yes | BCP-47 code, for example `de-DE`, `fr-FR`, `it-IT`, `cs-CZ`, `sk-SK`, `nb-NO` |
| `persona`, `goal` | yes | Who the caller is and what they want |
| `facts` | no | Merged over the country's shared `facts` |
| `steps` | no | The more specific the steps, the more repeatable the call |
| `answers` | no | Merged over the country's shared `answers` |
| `behaviour` | no | Tone and quirks, for example interrupts or unclear answers |
| `callerNumber` | no | Caller ID the agent sees, in E.164 (`+4915112345678`) |
| `callMode` | no | `studio` (default) dials the Studio test target; `phone` dials the channel's phone number |
| `connectionId` | no | Overrides the country's voice channel |
| `endRequires` | no | The caller will not hang up until the agent has said one of these patterns |
| `maxSeconds` | no | Default 360 |
| `expect` | no | Human-readable expected outcomes |

### Country defaults

`scenarios/<COUNTRY>/country.yaml` holds the defaults for every scenario in that country:

```yaml
code: DE
name: Germany
connectionId: <voice channel connection id>
facts:
  mobile_number: "+49 123456789"
answers: {}
```

The folder layout is `scenarios/<COUNTRY>/<language>/<scenario-id>.yaml`. Scenarios are stored in the console's local database. The YAML files seed that database at start-up, so after the first run treat the console as the place to edit scenarios.

## How it works

```
scenario -> headless Chromium + JsSIP -> SIP/WSS call to the channel's test target
              agent audio (16 kHz) -> Node -> Gemini Live (plays the caller)
              caller audio (24 kHz) <- Node <- Gemini Live
              -> runs/<time>_<scenario>/  report.json, agent.wav, caller.wav
```

- Latency is the gap from the end of the caller's speech to the start of the agent's reply, measured from audio energy. It includes the caller model's own delay, so use it to compare runs, not as an absolute figure.
- Transcripts are Gemini's transcription of the call audio, so wording can differ slightly from what was said.
- Stage checks are deterministic pattern checks on the agent's lines (for example date offered, time offered, read-back, booking reference). They are lenient and mark flows they do not apply to as not applicable.

## Project layout

```
src/run.ts            one call end to end
src/gemini.ts         Gemini Live caller (prompt, transcription, end_call tool)
src/browser/phone.ts  browser-side SIP call and audio bridge
src/platform.ts       platform bootstrap calls (softphone config, channel targets)
src/audio.ts          WAV writing, speech segments, latency maths
src/config.ts         scenario schema and country defaults
src/list-targets.ts   channel lister behind `npm run targets`
src/ui/               web console (server, database, checks, page)
scenarios/            seed scenarios and country defaults
data/                 console database and job files (gitignored)
runs/                 call output (gitignored)
```

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `HTTP 401` on any call | Bearer token expired. Paste a new one in Settings, then **Save and retry failed runs**. |
| `Missing <VAR>` | A value is not set in `.env` or Settings. |
| `Expected exactly one ... target for connection ...` | The channel has no test target, or `CONNECTION_ID` is wrong. Run `npm run targets` and pick one from the list. |
| `Call did not connect` / connect timeout | The channel is not deployed or active on this environment, or the environment is unreachable from your network. |
| Console will not start, mentions `node:sqlite` | Node is too old. Install Node 22.13 or newer. |
| Port 4173 already in use | A console is already running. Stop it, or set `UI_PORT` to another port. |
| Browser fails to launch | Run `npx playwright install chromium` again. |
| Caller talks over the agent or loops | Make `steps` more explicit, add `endRequires`, and lower `maxSeconds`. Tell the maintainer, since barge-in handling is still being tuned. |

## Security

- `.env` holds your bearer token and Gemini key. It is gitignored and the console writes it with owner-only permissions. Keep real secrets out of `.env.example`, scenarios and screenshots.
- Recordings and transcripts in `runs/` and `data/` can contain whatever the agent said. Treat them as sensitive and do not commit them.
- If a token or key was ever pasted into a shared file, chat or commit, revoke it and create a new one.
- Each call uses paid Gemini Live minutes. Check **Max concurrent calls**, repeat counts and `maxSeconds` before running large batches.

## Status and limits

- Working: calling, realtime caller, recording, transcripts, latency, stage checks, scenario management, queued and concurrent runs, token handling in the console.
- Not built yet: the automatic judge (scoring `expect` with an LLM and checking platform traces), HTML summary reports across a whole language matrix, scheduled/nightly runs.
- The harness has only been run against the German staging channel so far. Other countries and languages need their own channel and scenarios.
