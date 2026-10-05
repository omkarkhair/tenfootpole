import { DurableObject } from 'cloudflare:workers';

/**
 * Per-sandbox record of outbound network attempts, fed by the sandbox's
 * outbound handlers (src/sandbox.ts) and read by the "Network watch" tab.
 *
 * One instance per container, named by the container id the outbound handler
 * sees. Bounded ring buffer: a noisy or hostile repo cannot grow it forever.
 */

const MAX_EVENTS = 500;
const TTL_MS = 2 * 60 * 60_000;

export type EgressEvent = {
  seq: number;
  at: number;
  decision: 'allowed' | 'blocked';
  /** Why the decision was made, e.g. "git clone", "ai inference". */
  reason: string;
  method: string;
  scheme: string;
  host: string;
  port?: string;
  /** Path only: query strings can carry secrets. */
  path: string;
  status?: number;
  durationMs?: number;
  error?: string;
};

export type EgressSnapshot = {
  events: EgressEvent[];
  /** Highest sequence number ever assigned (events before it may have been dropped). */
  lastSeq: number;
  dropped: number;
  counts: { total: number; allowed: number; blocked: number };
  hosts: { host: string; allowed: number; blocked: number }[];
};

export type NewEgressEvent = Omit<EgressEvent, 'seq' | 'at'>;

export class EgressLog extends DurableObject<Env> {
  async record(event: NewEgressEvent): Promise<void> {
    const events = (await this.ctx.storage.get<EgressEvent[]>('events')) ?? [];
    const seq = ((await this.ctx.storage.get<number>('seq')) ?? 0) + 1;
    events.push({ ...event, seq, at: Date.now() });
    const dropped = Math.max(0, events.length - MAX_EVENTS);
    if (dropped) events.splice(0, dropped);
    await this.ctx.storage.put({
      events,
      seq,
      dropped: ((await this.ctx.storage.get<number>('dropped')) ?? 0) + dropped,
    });
    await this.ctx.storage.setAlarm(Date.now() + TTL_MS);
  }

  async read(since = 0): Promise<EgressSnapshot> {
    const all = (await this.ctx.storage.get<EgressEvent[]>('events')) ?? [];
    const hosts = new Map<string, { host: string; allowed: number; blocked: number }>();
    let allowed = 0;
    let blocked = 0;
    for (const e of all) {
      const h = hosts.get(e.host) ?? { host: e.host, allowed: 0, blocked: 0 };
      if (e.decision === 'allowed') (h.allowed++, allowed++);
      else (h.blocked++, blocked++);
      hosts.set(e.host, h);
    }
    return {
      events: all.filter((e) => e.seq > since),
      lastSeq: (await this.ctx.storage.get<number>('seq')) ?? 0,
      dropped: (await this.ctx.storage.get<number>('dropped')) ?? 0,
      counts: { total: all.length, allowed, blocked },
      hosts: [...hosts.values()].sort(
        (a, b) => b.blocked - a.blocked || b.allowed - a.allowed,
      ),
    };
  }

  /** Old sandboxes' logs clean themselves up. */
  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export function egressLogStub(env: Env, containerId: string): DurableObjectStub<EgressLog> {
  return env.EGRESS_LOG.get(env.EGRESS_LOG.idFromName(containerId));
}
