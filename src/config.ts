import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing ${name}. Set it in .env (see .env.example).`);
  return v;
}

export const scenarioSchema = z.object({
  id: z.string().min(1),
  language: z.string().min(2), // BCP-47, e.g. de-DE
  persona: z.string().min(1), // who the caller is
  goal: z.string().min(1), // what the caller wants to achieve
  facts: z.record(z.string()).default({}), // data the caller may give (names, numbers, dates)
  behaviour: z.string().default(''), // optional quirks: interrupts, unclear answers, etc.
  answers: z.record(z.string()).default({}), // topic -> reply for questions the agent may ask
  steps: z.array(z.string()).default([]), // ordered script the caller follows, one entry per beat
  callerNumber: z.string().regex(/^\+\d{6,15}$/, 'Use E.164, e.g. +4915112345678').optional().or(z.literal('')), // caller id the agent sees
  callMode: z.enum(['studio', 'phone']).optional(), // dial the Studio test target or the channel's phone number
  connectionId: z.string().optional(), // voice channel override; defaults to the country's channel
  endRequires: z.array(z.string()).default([]), // regexes; the caller may only hang up once the agent has said one of them
  maxSeconds: z.number().int().min(20).max(600).default(360),
  expect: z.array(z.string()).default([]), // plain-language expectations for the judge (phase 2)
});
export type Scenario = z.infer<typeof scenarioSchema>;

export interface CountryConfig {
  code?: string;
  name?: string;
  connectionId?: string;
  facts?: Record<string, string>;
  answers?: Record<string, string>;
}

/** scenarios/<COUNTRY>/<lang>/<id>.yaml -> scenarios/<COUNTRY>/country.yaml (if present). */
export function loadCountry(scenarioPath: string): { country?: string; config: CountryConfig } {
  const rel = relative('scenarios', scenarioPath).split(sep);
  if (rel.length < 3 || rel[0] === '..') return { config: {} };
  const file = join('scenarios', rel[0], 'country.yaml');
  const config = existsSync(file) ? ((parse(readFileSync(file, 'utf8')) ?? {}) as CountryConfig) : {};
  return { country: rel[0], config };
}

export function loadScenario(path: string): Scenario {
  const raw = (parse(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
  const { config } = loadCountry(path);
  raw.facts = { ...(config.facts ?? {}), ...((raw.facts as object) ?? {}) };
  raw.answers = { ...(config.answers ?? {}), ...((raw.answers as object) ?? {}) };
  return scenarioSchema.parse(raw);
}
