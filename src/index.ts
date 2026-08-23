import { proxyToSandbox, type Sandbox } from '@cloudflare/sandbox';
import type { ProvisionOutput, ProvisionParams } from './provision-workflow';

export { Sandbox } from '@cloudflare/sandbox';
export { ProvisionWorkflow } from './provision-workflow';

type Env = {
  Sandbox: DurableObjectNamespace<Sandbox>;
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
    const instance = await env.PROVISION_WORKFLOW.create({ params: { repo } });
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

    return Response.json({ status: status.status });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Instance not found';
    log('GET /api/provision/:id', 'lookup failed', { instanceId, error: message });
    return Response.json({ error: message }, { status: 404 });
  }
}
