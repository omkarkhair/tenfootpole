import { DurableObject } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';

/**
 * Singleton Durable Object that owns the "how many sandboxes are alive"
 * question. Every sandbox holds a *lease*; leases always expire, so a crashed
 * workflow or an abandoned tab can never leak a slot forever.
 *
 * Lifecycle of a lease:
 *   acquire()   -> provisioning lease (PROVISION_LEASE_MS)
 *   markReady() -> session lease (SESSION_MAX_MINUTES, the hard session cap)
 *   release()   -> early release (provision failure)
 *   alarm()     -> any expired lease gets its sandbox destroyed
 */

const PROVISION_LEASE_MS = 5 * 60_000;
const DESTROY_RETRY_MS = 30_000;
const DEFAULT_SESSION_MINUTES = 60;

type Lease = {
  expiresAt: number;
  ready: boolean;
  createdAt: number;
  // How many destroy attempts have failed after expiry.
  destroyFailures?: number;
};

export type AcquireResult =
  | { ok: true; active: number; max: number }
  | { ok: false; active: number; max: number; retryAfterSec: number };

export type RegistryStatus = {
  active: number;
  /** 0 means unlimited. */
  max: number;
  sessionMinutes: number;
};

export function sessionMinutes(env: { SESSION_MAX_MINUTES?: string }): number {
  const n = Number(env.SESSION_MAX_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SESSION_MINUTES;
}

export function maxContainers(env: { MAX_CONTAINERS?: string }): number {
  const n = Number(env.MAX_CONTAINERS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export class Registry extends DurableObject<Env> {
  private async load(): Promise<Record<string, Lease>> {
    return (await this.ctx.storage.get<Record<string, Lease>>('leases')) ?? {};
  }

  private async save(leases: Record<string, Lease>): Promise<void> {
    await this.ctx.storage.put('leases', leases);
    const times = Object.values(leases).map((l) => l.expiresAt);
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.min(...times));
    }
  }

  async status(): Promise<RegistryStatus> {
    const leases = await this.load();
    const now = Date.now();
    const active = Object.values(leases).filter((l) => l.expiresAt > now).length;
    return {
      active,
      max: maxContainers(this.env),
      sessionMinutes: sessionMinutes(this.env),
    };
  }

  async acquire(sandboxId: string): Promise<AcquireResult> {
    const leases = await this.load();
    const now = Date.now();
    const max = maxContainers(this.env);
    // Expired-but-not-yet-destroyed leases still occupy a container, so they
    // keep counting until the alarm confirms the destroy.
    const active = Object.keys(leases).length;

    if (max > 0 && active >= max) {
      const soonest = Math.min(...Object.values(leases).map((l) => l.expiresAt));
      return {
        ok: false,
        active,
        max,
        retryAfterSec: Math.max(5, Math.ceil((soonest - now) / 1000)),
      };
    }

    leases[sandboxId] = {
      createdAt: now,
      expiresAt: now + PROVISION_LEASE_MS,
      ready: false,
    };
    await this.save(leases);
    return { ok: true, active: active + 1, max };
  }

  /** Provisioning finished: start the hard session clock. */
  async markReady(sandboxId: string): Promise<{ expiresAt: number }> {
    const leases = await this.load();
    const expiresAt = Date.now() + sessionMinutes(this.env) * 60_000;
    const lease = leases[sandboxId];
    leases[sandboxId] = {
      createdAt: lease?.createdAt ?? Date.now(),
      expiresAt,
      ready: true,
    };
    await this.save(leases);
    return { expiresAt };
  }

  async release(sandboxId: string): Promise<void> {
    const leases = await this.load();
    if (leases[sandboxId]) {
      delete leases[sandboxId];
      await this.save(leases);
    }
  }

  async alarm(): Promise<void> {
    const leases = await this.load();
    const now = Date.now();

    for (const [sandboxId, lease] of Object.entries(leases)) {
      if (lease.expiresAt > now) continue;
      try {
        await getSandbox(this.env.Sandbox, sandboxId).destroy();
        delete leases[sandboxId];
        console.log(
          JSON.stringify({
            source: 'registry',
            event: 'expired and destroyed',
            sandboxId,
            ready: lease.ready,
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (error) {
        lease.destroyFailures = (lease.destroyFailures ?? 0) + 1;
        console.log(
          JSON.stringify({
            source: 'registry',
            event: 'destroy failed',
            sandboxId,
            attempt: lease.destroyFailures,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }),
        );
        if (lease.destroyFailures >= 5) {
          // Give up so a stuck sandbox cannot hold a slot forever; the
          // container's own `sleepAfter` is the final backstop.
          delete leases[sandboxId];
        } else {
          lease.expiresAt = now + DESTROY_RETRY_MS;
        }
      }
    }

    await this.save(leases);
  }
}
