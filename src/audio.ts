import { writeFileSync } from 'node:fs';

export function wavFromPcm16(pcm: Buffer, sampleRate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export const rms = (pcm: Buffer): number => {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    s += v * v;
  }
  return Math.sqrt(s / n);
};

/** Collects timestamped chunks of one speaker and derives speech segments from energy. */
export class SpeakerTrack {
  private chunks: Buffer[] = [];
  readonly segments: { start: number; end: number }[] = [];
  private open: { start: number; end: number } | null = null;
  constructor(
    private readonly threshold = 0.012,
    private readonly hangoverMs = 600,
  ) {}

  push(pcm: Buffer, t: number) {
    this.chunks.push(pcm);
    const loud = rms(pcm) >= this.threshold;
    if (loud) {
      if (!this.open) {
        this.open = { start: t, end: t };
        this.segments.push(this.open);
      }
      this.open.end = t;
    } else if (this.open && t - this.open.end > this.hangoverMs) {
      this.open = null;
    }
  }

  save(path: string, sampleRate: number) {
    writeFileSync(path, wavFromPcm16(Buffer.concat(this.chunks), sampleRate));
  }
}

/** Gap from the end of each caller segment to the start of the next agent segment. */
export function responseLatencies(
  caller: { start: number; end: number }[],
  agent: { start: number; end: number }[],
): number[] {
  const out: number[] = [];
  for (const c of caller) {
    const next = agent.find((a) => a.start > c.end);
    if (next) out.push(next.start - c.end);
  }
  return out;
}

export const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
