import { Sandbox as BaseSandbox, ContainerProxy } from '@cloudflare/sandbox';
import type { OutboundHandlerContext } from '@cloudflare/containers';

export { ContainerProxy };

export class Sandbox extends BaseSandbox {}

Sandbox.outbound = async (
  request: Request,
  _env: Cloudflare.Env,
  ctx: OutboundHandlerContext,
): Promise<Response> => {
  const start = Date.now();
  const url = request.url;

  console.log(
    JSON.stringify({
      source: 'outbound',
      phase: 'request',
      containerId: ctx.containerId,
      method: request.method,
      url,
      timestamp: new Date().toISOString(),
      headers: sanitizeHeaders(request.headers),
    }),
  );

  const response = await fetch(request);
  const durationMs = Date.now() - start;

  console.log(
    JSON.stringify({
      source: 'outbound',
      phase: 'response',
      containerId: ctx.containerId,
      method: request.method,
      url,
      status: response.status,
      durationMs,
      timestamp: new Date().toISOString(),
      responseHeaders: sanitizeHeaders(response.headers),
    }),
  );

  return response;
};

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
