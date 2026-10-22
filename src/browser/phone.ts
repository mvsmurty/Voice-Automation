// Runs inside headless Chromium. Places the same SIP-over-WSS call Studio's web-voice widget places,
// and exposes the audio on both sides to Node so a realtime model can play the caller.
import JsSIP from 'jssip';

// Record the raw SIP messages crossing the WebSocket so failed calls can be diagnosed.
const wsLog: { t: number; dir: 'send' | 'recv'; msg: string }[] = [];
const NativeWS = window.WebSocket;
window.WebSocket = class extends NativeWS {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    const push = (dir: 'send' | 'recv', d: unknown) => {
      if (wsLog.length < 300 && typeof d === 'string') wsLog.push({ t: Date.now(), dir, msg: d.slice(0, 1800) });
    };
    this.addEventListener('message', (e) => push('recv', e.data));
    const send = this.send.bind(this);
    this.send = (d: any) => {
      push('send', d);
      send(d);
    };
  }
} as typeof WebSocket;

declare global {
  interface Window {
    __agentAudio: (base64Pcm16: string, tMs: number) => void;
    __callerPlayback: (event: 'start' | 'end', tMs: number) => void;
    phone: typeof phone;
  }
}

// 16 kHz context: remote audio arrives at 16 kHz mono floats (no manual downsampling) and the
// 24 kHz model audio is resampled by the browser when played.
const ctx = new AudioContext({ sampleRate: 16000 });
const mic = ctx.createMediaStreamDestination();
const remoteEl = document.createElement('audio');
remoteEl.autoplay = true;
document.body.append(remoteEl);

const sipLog: { event: string; status?: number; headers: Record<string, string[]>; body?: string }[] = [];
const headersOf = (m: any): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(m?.headers ?? {})) out[k] = (v as any[]).map((h) => String(h?.raw ?? h));
  return out;
};
const logSip = (event: string, m: any) =>
  sipLog.push({ event, status: m?.status_code, headers: headersOf(m), body: typeof m?.body === 'string' ? m.body.slice(0, 500) : undefined });

const state = { registered: false, connected: false, ended: false, failed: false, sipCallId: '', failReason: '' };
let ua: any;
let session: any;
let nextPlayAt = 0;
const live = new Set<AudioBufferSourceNode>();

function pcm16Base64(f32: Float32Array): string {
  const bytes = new Uint8Array(f32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function attachRemote(track: MediaStreamTrack): void {
  if (track.kind !== 'audio') return;
  const stream = new MediaStream([track]);
  // Chromium's WebRTC receiver must be attached to a playing element or the track stays silent.
  remoteEl.srcObject = stream;
  remoteEl.play().catch((e) => console.warn('remote audio element play() rejected', e));
  const src = ctx.createMediaStreamSource(stream);
  const tap = ctx.createScriptProcessor(2048, 1, 1);
  tap.onaudioprocess = (e) => {
    window.__agentAudio(pcm16Base64(e.inputBuffer.getChannelData(0)), Date.now());
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(tap);
  tap.connect(mute);
  mute.connect(ctx.destination);
}

const phone = {
  state: () => ({ ...state }),
  sipLog: () => sipLog,
  wsLog: () => wsLog,
  async start(o: { sipDomain: string; wsServers: string[]; target: string; user: string; callerNumber?: string }) {
    await ctx.resume();
    ua = new JsSIP.UA({
      sockets: o.wsServers.map((u) => new JsSIP.WebSocketInterface(u)),
      uri: `sip:${o.user}@${o.sipDomain}`,
      password: o.user,
      register: true,
      register_expires: 600,
      user_agent: 'VMAutomationCaller',
    });
    ua.on('registrationFailed', (e: any) => {
      state.failed = true;
      state.failReason = `registrationFailed:${e?.cause ?? ''}`;
    });
    ua.on('disconnected', () => {
      if (!state.ended) {
        state.failed = true;
        state.failReason ||= 'ws-disconnected';
      }
    });
    ua.on('registered', () => {
      if (session) return;
      state.registered = true;
      session = ua.call(`sip:${o.target}@${o.sipDomain}`, {
        // Present a real phone number as the caller (From user part), while registration keeps the vm_ user.
        ...(o.callerNumber ? { fromUserName: o.callerNumber, fromDisplayName: o.callerNumber } : {}),
        mediaStream: mic.stream,
        mediaConstraints: { audio: true, video: false },
        eventHandlers: {
          sending: ({ request }: any) => (state.sipCallId = request.call_id),
          peerconnection: ({ peerconnection }: any) =>
            peerconnection.addEventListener('track', ({ track }: RTCTrackEvent) => attachRemote(track)),
          progress: ({ response }: any) => logSip('progress', response),
          accepted: ({ response }: any) => logSip('accepted', response),
          newInfo: ({ request }: any) => logSip('info', request),
          confirmed: () => (state.connected = true),
          failed: (e: any) => {
            logSip(`failed:${e?.cause ?? ''}`, e?.response ?? e?.message);
            state.failed = true;
            state.failReason = `call-failed:${e?.cause ?? ''}`;
          },
          ended: () => (state.ended = true),
        },
      });
    });
    ua.on('newMessage', ({ request }: any) => logSip('message', request));
    ua.start();
  },
  /** Queue model speech (PCM16 little-endian mono) into the call's microphone. */
  pushCaller(base64Pcm16: string, sampleRate: number) {
    if (state.ended || state.failed) return;
    const bin = atob(base64Pcm16);
    const n = bin.length >> 1;
    const f32 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = bin.charCodeAt(i * 2);
      const hi = bin.charCodeAt(i * 2 + 1);
      let v = (hi << 8) | lo;
      if (v & 0x8000) v -= 0x10000;
      f32[i] = v / 0x8000;
    }
    const buf = ctx.createBuffer(1, n, sampleRate);
    buf.copyToChannel(f32, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(mic);
    const at = Math.max(ctx.currentTime + 0.02, nextPlayAt);
    if (live.size === 0) window.__callerPlayback('start', Date.now() + (at - ctx.currentTime) * 1000);
    node.start(at);
    nextPlayAt = at + buf.duration;
    live.add(node);
    node.onended = () => {
      live.delete(node);
      if (live.size === 0) window.__callerPlayback('end', Date.now());
    };
  },
  /** Caller was interrupted (barge-in): drop queued speech immediately. */
  flushCaller() {
    for (const n of live) {
      try {
        n.stop();
      } catch (e) {
        console.warn('flushCaller: source already stopped', e);
      }
    }
    live.clear();
    nextPlayAt = 0;
    window.__callerPlayback('end', Date.now());
  },
  hangup() {
    if (session && !session.isEnded()) session.terminate();
    ua?.stop();
  },
};
window.phone = phone;
