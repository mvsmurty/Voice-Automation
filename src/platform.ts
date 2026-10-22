// Same bootstrap calls Studio's softphone makes. Remote origins use the /api/runtime/v1 prefix.
const isRemote = (origin: string) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(origin);

export interface TestTarget {
  connectionId: string;
  kind: string;
  number: string;
  channelName?: string;
  channelType?: string;
  [k: string]: unknown;
}

export class Platform {
  constructor(
    readonly origin: string,
    private readonly token: string,
  ) {}

  private voice(suffix: string) {
    return `${this.origin.replace(/\/$/, '')}${isRemote(this.origin) ? '/api/runtime/v1/voice' : '/api/v1/voice'}${suffix}`;
  }

  private async get(url: string): Promise<Record<string, unknown>> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, redirect: 'error' });
    if (!res.ok) {
      const hint = res.status === 401 ? ' (bearer token expired or wrong: copy a fresh one from the Studio UI)' : '';
      throw new Error(`GET ${url} -> HTTP ${res.status}${hint}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    return (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
  }

  async softphoneConfig(): Promise<{ sipDomain: string; wsServers: string[] }> {
    const c = await this.get(this.voice('/softphone-config'));
    if (typeof c.sipDomain !== 'string' || !Array.isArray(c.wsServers) || !c.wsServers.length)
      throw new Error('Platform returned an invalid softphone configuration');
    return { sipDomain: c.sipDomain, wsServers: c.wsServers as string[] };
  }

  async targets(projectId: string): Promise<TestTarget[]> {
    const r = await this.get(this.voice(`/softphone-numbers/${encodeURIComponent(projectId)}`));
    return (Array.isArray(r.numbers) ? r.numbers : []) as TestTarget[];
  }

  /** The dialable target for a channel: its Studio test-call alias, or its real phone number. */
  async callTarget(projectId: string, connectionId: string, mode: 'studio' | 'phone'): Promise<string> {
    const kind = mode === 'phone' ? 'phone_number' : 'studio_test_call';
    const rows = (await this.targets(projectId)).filter((t) => t.kind === kind && t.connectionId === connectionId && /^[^@\s<>]+$/.test(t.number));
    if (rows.length !== 1)
      throw new Error(`Expected exactly one ${kind} target for connection ${connectionId}, found ${rows.length}.`);
    return rows[0].number;
  }

  async studioTarget(projectId: string, connectionId: string): Promise<string> {
    const rows = (await this.targets(projectId)).filter(
      (t) => t.kind === 'studio_test_call' && t.connectionId === connectionId && /^[^@\s<>]+$/.test(t.number),
    );
    if (rows.length !== 1)
      throw new Error(
        `Expected exactly one studio_test_call target for connection ${connectionId}, found ${rows.length}. Run: npm run targets`,
      );
    return rows[0].number;
  }
}
