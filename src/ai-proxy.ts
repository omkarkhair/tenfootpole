// OpenAI-compatible inference proxy for the in-sandbox Pi agent.
// The sandbox calls http://ai.tenfootpole.internal/v1/chat/completions; the
// outbound handler (src/sandbox.ts) lands here, so no credential ever enters
// the container.

import type { OutboundHandlerContext } from '@cloudflare/containers';
import { logAttempt } from './sandbox';

export const AI_HOST = 'ai.tenfootpole.internal';

export async function handleAiRequest(
  request: Request,
  env: Env,
  ctx: OutboundHandlerContext,
  modelOverride?: string,
): Promise<Response> {
  const sandboxId = ctx.containerId ?? 'unknown';
  const start = Date.now();
  const response = await run(request, env, sandboxId, modelOverride);
  await logAttempt('allowed', 'ai inference', request, ctx, { status: response.status, durationMs: Date.now() - start }, env);
  return response;
}

async function run(
  request: Request,
  env: Env,
  sandboxId: string,
  modelOverride?: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    return Response.json({ error: 'Only POST /v1/chat/completions' }, { status: 404 });
  }
  const body = (await request.json()) as Record<string, unknown>;
  const model = modelOverride ?? env.AI_MODEL;
  // Callers cannot choose the model; the operator does.
  body.model = model;

  const result = await env.AI.run(
    model as keyof AiModels,
    body as never,
    { gateway: { id: env.AI_GATEWAY_ID, metadata: { sandboxId } } },
  );

  if (result instanceof ReadableStream) {
    return new Response(result, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
  }
  return Response.json(result);
}
