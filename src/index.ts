import { proxyToSandbox } from '@cloudflare/sandbox';
import type { ProvisionOutput, ProvisionParams } from './provision-workflow';
import { runEval } from './eval';
import { maxContainers, sessionMinutes, type Registry } from './registry';

export { Sandbox, ContainerProxy } from './sandbox';
export { ProvisionWorkflow } from './provision-workflow';
export { Registry } from './registry';

// Sandboxes have no SSH egress (only HTTP(S) can be intercepted), so only
// HTTPS git endpoints are accepted.
const GIT_URL_PATTERNS = [/^https:\/\/[a-zA-Z0-9.-]+\/[\w.-]+\/[\w.-]+(\.git)?$/];

const DEPLOY_URL =
  'https://deploy.workers.cloudflare.com/?url=https://github.com/omkarkhair/tenfootpole';

function registry(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName('global'));
}

function isValidGitUrl(url: string): boolean {
  return GIT_URL_PATTERNS.some((p) => p.test(url.trim()));
}

function log(route: string, event: string, extra?: Record<string, unknown>) {
  console.log(
    JSON.stringify({
      source: 'worker',
      route,
      event,
      timestamp: new Date().toISOString(),
      ...extra,
    }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxyResponse = await proxyToSandbox(request, env);
    if (proxyResponse) return proxyResponse;

    const url = new URL(request.url);

    // M0 spike: local dev only.
    if (url.pathname === '/api/_eval' && url.hostname === 'localhost') {
      const model = url.searchParams.get('model') ?? env.AI_MODEL;
      return Response.json(await runEval(env, model).catch((e) => ({ model, error: String(e) })));
    }

    if (url.pathname === '/api/config' && request.method === 'GET') {
      const status = await registry(env).status();
      return Response.json(
        {
          active: status.active,
          max: maxContainers(env),
          sessionMinutes: sessionMinutes(env),
          deployUrl: DEPLOY_URL,
        },
        { headers: { 'cache-control': 'no-store' } },
      );
    }

    if (url.pathname === '/api/provision' && request.method === 'POST') {
      return handleProvision(request, env);
    }

    const statusMatch = url.pathname.match(/^\/api\/provision\/([^/]+)$/);
    if (statusMatch && request.method === 'GET') {
      return handleProvisionStatus(statusMatch[1], env);
    }

    // Dedicated status page: /sandbox/<instanceId>. Serve the same static
    // page for any instance id; the page reads the id from the URL client-side.
    if (url.pathname.match(/^\/sandbox\/[^/]+$/) && request.method === 'GET') {
      // The assets binding serves sandbox.html's content at the
      // extensionless `/sandbox` path (its default html_handling behavior);
      // requesting `/sandbox.html` directly would 307-redirect instead.
      return env.ASSETS.fetch(new Request(new URL('/sandbox', url), request));
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleProvision(request: Request, env: Env): Promise<Response> {
  let body: { repo?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const repo = body.repo?.trim();
  if (!repo) {
    return Response.json({ error: 'Missing "repo" field' }, { status: 400 });
  }

  if (!isValidGitUrl(repo)) {
    log('POST /api/provision', 'invalid git url', { repo });
    return Response.json(
      { error: 'Invalid git URL. Use an HTTPS endpoint (https://host/owner/repo).' },
      { status: 400 },
    );
  }

  // Quick tunnels need real egress; with egress denied the only way to reach
  // the IDE is a preview hostname routed through this Worker.
  if (!env.PREVIEW_HOSTNAME && env.EGRESS_MODE !== 'open') {
    log('POST /api/provision', 'misconfigured');
    return Response.json(
      {
        error:
          'Server misconfigured: set PREVIEW_HOSTNAME (wildcard domain) or EGRESS_MODE=open so the IDE can be exposed.',
      },
      { status: 500 },
    );
  }

  // Every request gets its own random sandbox, even for a repo that was
  // already pulled: 128 bits of randomness makes the id (and therefore the
  // preview URL) unguessable.
  const sandboxId = crypto.randomUUID().replaceAll('-', '');

  const lease = await registry(env).acquire(sandboxId);
  if (!lease.ok) {
    log('POST /api/provision', 'at capacity', {
      active: lease.active,
      max: lease.max,
    });
    return Response.json(
      {
        code: 'at_capacity',
        error: `All ${lease.max} sandboxes are in use right now. Try again in a few minutes, or deploy your own with no limits.`,
        active: lease.active,
        max: lease.max,
        retryAfterSec: lease.retryAfterSec,
        deployUrl: DEPLOY_URL,
      },
      { status: 503, headers: { 'retry-after': String(lease.retryAfterSec) } },
    );
  }

  try {
    // Encode the creation time into the instance id (Workflows' own
    // `InstanceStatus` doesn't expose timestamps) so the status endpoint can
    // report a real elapsed time and derive a human-readable phase, instead
    // of just "running" with no detail.
    const instanceId = `prov-${Date.now().toString(36)}-${crypto.randomUUID()}`;
    const instance = await env.PROVISION_WORKFLOW.create({
      id: instanceId,
      params: { repo, sandboxId } satisfies ProvisionParams,
    });
    log('POST /api/provision', 'workflow created', {
      repo,
      sandboxId,
      instanceId: instance.id,
    });
    return Response.json({ instanceId: instance.id });
  } catch (error) {
    await registry(env).release(sandboxId);
    const message =
      error instanceof Error ? error.message : 'Failed to start provisioning';
    log('POST /api/provision', 'workflow create failed', {
      repo,
      error: message,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}

async function handleProvisionStatus(
  instanceId: string,
  env: Env,
): Promise<Response> {
  try {
    const instance = await env.PROVISION_WORKFLOW.get(instanceId);
    const status = await instance.status();

    log('GET /api/provision/:id', 'status', { instanceId, status: status.status });

    if (status.status === 'errored') {
      log('GET /api/provision/:id', 'errored', {
        instanceId,
        error: status.error?.message,
      });
      return Response.json(
        {
          status: status.status,
          error: status.error?.message ?? 'Provisioning failed',
        },
        { status: 500 },
      );
    }

    if (status.status === 'complete') {
      const output = status.output as ProvisionOutput;
      log('GET /api/provision/:id', 'complete', {
        instanceId,
        url: output.url,
      });
      return Response.json({
        status: status.status,
        url: output.url,
        expiresAt: output.expiresAt,
        scan: output.scan,
      });
    }

    // "running"/"queued"/etc — no per-step detail is available from the
    // Workflows API, so approximate a human-readable phase from elapsed
    // time. This is a heuristic, not ground truth from the Workflow itself.
    const { phase, message } = describeProgress(instanceId);
    return Response.json({ status: status.status, phase, message });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Instance not found';
    log('GET /api/provision/:id', 'lookup failed', { instanceId, error: message });
    return Response.json({ error: message }, { status: 404 });
  }
}

// Instance ids are minted as `prov-<base36 timestamp>-<random>` (see
// handleProvision), so elapsed time can be recovered without extra storage.
function describeProgress(instanceId: string): { phase: string; message: string } {
  const match = instanceId.match(/^prov-([0-9a-z]+)-/);
  const createdAt = match ? parseInt(match[1], 36) : NaN;
  const elapsedMs = Number.isFinite(createdAt) ? Date.now() - createdAt : 0;

  if (elapsedMs < 8_000) {
    return { phase: 'checkout', message: 'Cloning repository...' };
  }
  if (elapsedMs < 20_000) {
    return { phase: 'server', message: 'Starting code-server...' };
  }
  return { phase: 'tunnel', message: 'Exposing tunnel...' };
}
