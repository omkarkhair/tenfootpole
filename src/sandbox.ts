import { Sandbox as BaseSandbox, ContainerProxy } from '@cloudflare/sandbox';
import type { OutboundHandlerContext } from '@cloudflare/containers';

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

function logAttempt(
  decision: Decision,
  reason: string,
  request: Request,
  ctx: OutboundHandlerContext,
  extra?: Record<string, unknown>,
) {
  const url = new URL(request.url);
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
    return forward('egress mode open', request, ctx);
  }

  logAttempt('blocked', 'egress denied by default', request, ctx);
  return new Response(
    'Outbound network access is disabled in this tenfootpole sandbox.\n',
    { status: 403, headers: { 'content-type': 'text/plain' } },
  );
};

// Named handlers, assigned per sandbox at runtime (see provision workflow).
Sandbox.outboundHandlers = {
  allowGitHost: (
    request: Request,
    _env: Cloudflare.Env,
    ctx: OutboundHandlerContext,
  ) => forward('git clone', request, ctx),
};

async function forward(
  reason: string,
  request: Request,
  ctx: OutboundHandlerContext,
): Promise<Response> {
  const start = Date.now();
  try {
    const response = await fetch(request);
    logAttempt('allowed', reason, request, ctx, {
      status: response.status,
      durationMs: Date.now() - start,
    });
    return response;
  } catch (error) {
    logAttempt('allowed', reason, request, ctx, {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    });
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
