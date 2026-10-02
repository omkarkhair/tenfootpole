import { proxyToSandbox, type Sandbox as SandboxType } from '@cloudflare/sandbox';
import type { ProvisionOutput, ProvisionParams } from './provision-workflow';

export { Sandbox, ContainerProxy } from './sandbox';
export { ProvisionWorkflow } from './provision-workflow';

type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
  PROVISION_WORKFLOW: Workflow<ProvisionParams>;
  ASSETS: Fetcher;
};

const GIT_URL_PATTERNS = [
  /^https:\/\/[a-zA-Z0-9.-]+\/[\w.-]+\/[\w.-]+(\.git)?$/,
  /^git@[a-zA-Z0-9.-]+:[\w.-]+\/[\w.-]+(\.git)?$/,
  /^ssh:\/\/git@[a-zA-Z0-9.-]+\/[\w.-]+\/[\w.-]+(\.git)?$/,
];

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
  let body: { repo?: string; instanceType?: string };
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
      { error: 'Invalid git URL. Use HTTPS (https://...) or SSH (git@...) format.' },
      { status: 400 },
    );
  }

  try {
    // Encode the creation time into the instance id (Workflows' own
    // `InstanceStatus` doesn't expose timestamps) so the status endpoint can
    // report a real elapsed time and derive a human-readable phase, instead
    // of just "running" with no detail.
    const instanceId = `prov-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const instance = await env.PROVISION_WORKFLOW.create({
      id: instanceId,
      params: { repo },
    });
    log('POST /api/provision', 'workflow created', {
      repo,
      instanceId: instance.id,
    });
    return Response.json({ instanceId: instance.id });
  } catch (error) {
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
      return Response.json({ status: status.status, url: output.url });
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
