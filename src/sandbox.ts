import { Sandbox as BaseSandbox, ContainerProxy } from '@cloudflare/sandbox';
import type { OutboundHandlerContext } from '@cloudflare/containers';
import { handleAiRequest } from './ai-proxy';
import { egressLogStub } from './egress-log';

export { ContainerProxy };

/**
 * Egress policy
 * -------------
 * Sandboxes run untrusted code, so they get NO internet by default:
 *
 *  - `enableInternet = false` (unless EGRESS_MODE=open) blocks everything except DNS and ports 80/443.
 *  - `interceptHttps = true` routes HTTPS through the handlers below too, so
 *    every HTTP(S) attempt is visible to (and logged by) the Worker.
 *  - The catch-all `outbound` handler logs each attempt, then denies it
 *    unless `EGRESS_MODE=open` (self-hosters only).
 *  - The provisioning workflow temporarily maps the repo's git host to the
 *    `allowGitHost` handler (via `setOutboundByHost`) for the duration of the
 *    clone, and removes it again afterwards.
 *
 * Limit: non-HTTP traffic (other ports, raw TCP/UDP) is dropped by the
 * network layer and never reaches a handler, so it cannot be logged here.
 */
export class Sandbox extends BaseSandbox {
  enableInternet = false;
  interceptHttps = true;

  constructor(ctx: DurableObjectState<{}>, env: Cloudflare.Env) {
    super(ctx, env);
    // EGRESS_MODE=open is the self-hosted escape hatch. It turns on full
    // network access (needed by quick tunnels, whose `cloudflared` speaks
    // QUIC on a non-HTTP port). HTTP(S) is still routed through, and logged
    // by, the outbound handler below.
    this.enableInternet = env.EGRESS_MODE === 'open';
  }
}

type Decision = 'allowed' | 'blocked';

export async function logAttempt(
  decision: Decision,
  reason: string,
  request: Request,
  ctx: OutboundHandlerContext,
  extra?: Record<string, unknown>,
  env?: Cloudflare.Env,
): Promise<void> {
  const url = new URL(request.url);
  if (env) {
    // Feeds the "Network watch" tab. Monitoring must never break traffic.
    await egressLogStub(env as Env, ctx.containerId)
      .record({
        decision,
        reason,
        method: request.method,
        scheme: url.protocol.replace(':', ''),
        host: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
        status: typeof extra?.status === 'number' ? extra.status : undefined,
        durationMs: typeof extra?.durationMs === 'number' ? extra.durationMs : undefined,
        error: typeof extra?.error === 'string' ? extra.error.slice(0, 200) : undefined,
      })
      .catch(() => {});
  }
  console.log(
    JSON.stringify({
      source: 'outbound',
      decision,
      reason,
      containerId: ctx.containerId,
      method: request.method,
      scheme: url.protocol.replace(':', ''),
      host: url.hostname,
      port: url.port || undefined,
      // Query strings and credentials can carry secrets; keep the path only.
      path: url.pathname,
      headers: sanitizeHeaders(request.headers),
      timestamp: new Date().toISOString(),
      ...extra,
    }),
  );
}

// Catch-all: every attempt not claimed by a per-host handler lands here.
Sandbox.outbound = async (
  request: Request,
  env: Cloudflare.Env,
  ctx: OutboundHandlerContext,
): Promise<Response> => {
  if (env.EGRESS_MODE === 'open') {
    return forward('egress mode open', request, ctx, env);
  }

  await logAttempt('blocked', 'egress denied by default', request, ctx, undefined, env);
  return new Response(
    'Outbound network access is disabled in this tenfootpole sandbox.\n',
    { status: 403, headers: { 'content-type': 'text/plain' } },
  );
};

// Named handlers, assigned per sandbox at runtime (see provision workflow).
Sandbox.outboundHandlers = {
  allowGitHost: (
    request: Request,
    env: Cloudflare.Env,
    ctx: OutboundHandlerContext,
  ) => forward('git clone', request, ctx, env),
  // Pi -> Workers AI. Registered per sandbox for its whole life.
  workersAi: (
    request: Request,
    env: Cloudflare.Env,
    ctx: OutboundHandlerContext,
  ) => handleAiRequest(request, env, ctx),
};

async function forward(
  reason: string,
  request: Request,
  ctx: OutboundHandlerContext,
  env: Cloudflare.Env,
): Promise<Response> {
  const start = Date.now();
  try {
    const response = await fetch(request);
    await logAttempt('allowed', reason, request, ctx, {
      status: response.status,
      durationMs: Date.now() - start,
    }, env);
    return response;
  } catch (error) {
    await logAttempt('allowed', reason, request, ctx, {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    }, env);
    throw error;
  }
}

function sanitizeHeaders(headers: Headers): Record<string, string> {
  const sanitized: Record<string, string> = {};
  const redact = new Set([
    'authorization',
    'cookie',
    'set-cookie',
    'x-auth-token',
    'proxy-authorization',
  ]);
  for (const [key, value] of headers.entries()) {
    sanitized[key] = redact.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return sanitized;
}
