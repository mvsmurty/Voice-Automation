import { GoogleGenAI, Modality, type LiveServerMessage, type Session } from '@google/genai';
import type { Scenario } from './config.js';

export interface TranscriptLine {
  t: number; // epoch ms when the line was completed
  who: 'agent' | 'caller';
  text: string;
}

export interface CallerHandlers {
  onAudio(base64Pcm16: string, sampleRate: number): void;
  onInterrupted(): void;
  /** Return a message to refuse the hang-up (the caller is told to keep waiting). */
  onEndCall(reason: string): string | void;
  onClose(): void;
  onLine?(line: TranscriptLine): void;
  /** The caller wanted to answer a hold phrase; its reply was dropped instead of played. */
  onHeldBack?(text: string): void;
  onError(e: unknown): void;
}

export function callerPrompt(s: Scenario): string {
  const facts = Object.entries(s.facts)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return [
    `You are a customer making a phone call to a company's voice assistant. You are NOT an assistant yourself.`,
    `Speak ONLY in the language with BCP-47 code ${s.language}. Never switch language unless the scenario says so.`,
    `Who you are: ${s.persona}`,
    `What you want: ${s.goal}`,
    facts ? `Details you may give when asked (do not volunteer them all at once):\n${facts}` : '',
    Object.keys(s.answers).length
      ? `If the agent asks about any of these topics, reply with the given answer (in your own natural words, in ${s.language}):\n${Object.entries(s.answers).map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
      : '',
    s.steps.length
      ? `Follow this script IN ORDER, one step at a time, reacting to what the agent actually says (do not skip ahead, do not say a later step early):\n${s.steps.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      : '',
    s.behaviour ? `How you behave: ${s.behaviour}` : '',
    `Rules: keep every turn short and natural like a real phone caller. Wait for the agent to finish. Answer only what is asked.`,
    `Hold phrases: when the agent says things like "one moment", "please wait", "I am checking", "I am looking at available days", "I am finalizing", "einen Moment", it is NOT asking you anything. Say NOTHING and wait silently for its next turn. Never answer a hold phrase with "okay", "yes" or "I'll wait".`,
    `Do not invent details that are not listed; if asked for something unknown, say you don't know.`,
    `When your goal is achieved, or the agent clearly cannot help, or the call is stuck in a loop after 2 attempts, say a brief goodbye and then call the end_call tool with a short reason.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

const HOLD =
  /(one moment|just a moment|a moment please|please wait|hold on|bear with me|let me (check|look)|i am (currently )?(checking|looking|finali[sz]ing|working)|still working|einen (kleinen )?moment|augenblick|bitte warten|ich (prüfe|schaue|bearbeite)|noch einen moment|un moment|un instant|un attimo|chvíli|chvilku|et øyeblikk)/i;

/** True when the agent's latest turn is only a stall ("one moment…") and asks nothing. */
export function isHoldPhrase(text: string): boolean {
  const t = text.trim();
  return !!t && HOLD.test(t) && !t.includes('?');
}

export class GeminiCaller {
  private endRequested = false; // a hang-up was already asked for (tool call or text form)
  private holdTurn: boolean | null = null; // decided once per model turn
  private held = '';
  private session!: Session;
  readonly transcript: TranscriptLine[] = [];
  private buf = { agent: '', caller: '' };

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly scenario: Scenario,
    private readonly h: CallerHandlers,
  ) {}

  async connect(): Promise<void> {
    const ai = new GoogleGenAI({ apiKey: this.apiKey });
    this.session = await ai.live.connect({
      model: this.model,
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: callerPrompt(this.scenario),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [
          {
            functionDeclarations: [
              {
                name: 'end_call',
                description: 'Hang up the call once the goal is done or the call cannot progress.',
                parametersJsonSchema: {
                  type: 'object',
                  properties: { reason: { type: 'string' } },
                  required: ['reason'],
                },
              },
            ],
          },
        ],
      },
      callbacks: {
        onmessage: (m: LiveServerMessage) => this.onMessage(m),
        onerror: (e) => this.h.onError(e),
        onclose: () => this.h.onClose(),
      },
    });
  }

  /** Agent speech (16 kHz PCM16 mono) heard on the call. */
  sendAgentAudio(base64Pcm16: string): void {
    this.session.sendRealtimeInput({ audio: { data: base64Pcm16, mimeType: 'audio/pcm;rate=16000' } });
  }

  /** Everything the agent has said so far, including the line still being transcribed. */
  agentSaid(): string {
    return [...this.transcript.filter((l) => l.who === 'agent').map((l) => l.text), this.buf.agent].join(' ');
  }

  close(): void {
    this.flush('agent');
    this.flush('caller');
    try {
      this.session.close();
    } catch {
      /* already closed */
    }
  }

  private flush(who: 'agent' | 'caller') {
    let text = this.buf[who].trim();
    this.buf[who] = '';
    if (who === 'caller') {
      // The caller model sometimes writes its hang-up as plain text (call:end_call(reason="..."))
      // inside <prompts> markup instead of making the tool call. Treat that as the hang-up it meant.
      const m = /call:end_call\(\s*reason\s*=\s*"?([^")]*)/.exec(text);
      if (m && !this.endRequested) {
        this.endRequested = true;
        if (this.h.onEndCall(m[1].trim())) this.endRequested = false; // refused by the guard; allow a later attempt
      }
      text = text.replace(/<\/?prompts?>/gi, ' ').replace(/call:\w+\([\s\S]*$/, '').replace(/\s+/g, ' ').trim();
    }
    if (!text || /^<no speech>(\{pause\})?$/.test(text)) return;
    const line = { t: Date.now(), who, text };
    this.transcript.push(line);
    this.h.onLine?.(line);
  }

  private onMessage(m: LiveServerMessage): void {
    const sc = m.serverContent;
    if (sc?.interrupted) {
      this.flush('caller');
      this.holdTurn = null;
      this.held = '';
      this.h.onInterrupted();
    }
    if (this.holdTurn === null && (sc?.modelTurn?.parts?.length || sc?.outputTranscription?.text)) {
      const lastAgent = this.buf.agent.trim() || [...this.transcript].reverse().find((l) => l.who === 'agent')?.text || '';
      this.holdTurn = isHoldPhrase(lastAgent);
    }
    for (const p of sc?.modelTurn?.parts ?? []) {
      if (p.inlineData?.data && !this.holdTurn) this.h.onAudio(p.inlineData.data, 24000);
    }
    if (sc?.inputTranscription?.text) {
      this.flush('caller');
      this.buf.agent += sc.inputTranscription.text;
    }
    if (sc?.outputTranscription?.text) {
      this.flush('agent');
      if (this.holdTurn) this.held += sc.outputTranscription.text;
      else this.buf.caller += sc.outputTranscription.text;
    }
    if (sc?.turnComplete) {
      this.flush('caller');
      if (this.holdTurn && this.held.trim()) this.h.onHeldBack?.(this.held.trim());
      this.holdTurn = null;
      this.held = '';
    }
    for (const fc of m.toolCall?.functionCalls ?? []) {
      if (fc.name === 'end_call') {
        this.endRequested = true;
        const refusal = this.h.onEndCall(String((fc.args as { reason?: string } | undefined)?.reason ?? ''));
        if (refusal) this.endRequested = false;
        this.session.sendToolResponse({
          functionResponses: [{ id: fc.id, name: fc.name, response: refusal ? { ok: false, message: refusal } : { ok: true } }],
        });
      }
    }
  }
}
