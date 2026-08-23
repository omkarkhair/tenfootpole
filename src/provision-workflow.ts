import { WorkflowEntrypoint, type WorkflowStep } from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';

export type ProvisionParams = {
  repo: string;
};

export type ProvisionOutput = {
  url: string;
};

function log(
  instanceId: string,
  step: string,
  event: string,
  extra?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      workflow: 'provision',
      instanceId,
      step,
      event,
      timestamp: new Date().toISOString(),
      ...extra,
    }),
  );
}

export class ProvisionWorkflow extends WorkflowEntrypoint<Env, ProvisionParams> {
  async run(
    event: WorkflowEvent<ProvisionParams>,
    step: WorkflowStep,
  ): Promise<ProvisionOutput> {
    const { repo } = event.payload;
    const { instanceId } = event;

    log(instanceId, 'run', 'start', { repo });

    const sandboxId = await step.do('derive sandbox id', async () => {
      log(instanceId, 'derive sandbox id', 'start');
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(repo),
      );
      const id = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 8);
      log(instanceId, 'derive sandbox id', 'done', { sandboxId: id });
      return id;
    });

    await step.do(
      'checkout repo',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async (ctx) => {
        log(instanceId, 'checkout repo', 'start', {
          sandboxId,
          attempt: ctx.attempt,
        });
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
          normalizeId: true,
          enableDefaultSession: false,
        });

        const projectExists = await sandbox.exists('/workspace/project');
        log(instanceId, 'checkout repo', 'exists check', {
          sandboxId,
          exists: projectExists.exists,
        });

        if (!projectExists.exists) {
          log(instanceId, 'checkout repo', 'cloning', { sandboxId, repo });
          await sandbox.gitCheckout(repo, { targetDir: '/workspace/project' });
          log(instanceId, 'checkout repo', 'clone complete', { sandboxId });
        } else {
          log(instanceId, 'checkout repo', 'skip clone, already exists', {
            sandboxId,
          });
        }
      },
    ).catch((error) => {
      log(instanceId, 'checkout repo', 'failed', {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });

    await step.do(
      'start code-server',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async (ctx) => {
        log(instanceId, 'start code-server', 'start', {
          sandboxId,
          attempt: ctx.attempt,
        });
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
          normalizeId: true,
          enableDefaultSession: false,
        });

        const processes = await sandbox.listProcesses();
        const codeServerRunning = processes.some((p) =>
          p.command.includes('code-server'),
        );
        log(instanceId, 'start code-server', 'process check', {
          sandboxId,
          processCount: processes.length,
          codeServerRunning,
        });

        if (!codeServerRunning) {
          log(instanceId, 'start code-server', 'launching', { sandboxId });
          const server = await sandbox.startProcess(
            'code-server --bind-addr 0.0.0.0:8080 --auth none /workspace/project',
          );
          log(instanceId, 'start code-server', 'waiting for port', {
            sandboxId,
          });
          await server.waitForPort(8080, { timeout: 30_000 });
          log(instanceId, 'start code-server', 'port ready', { sandboxId });
        } else {
          log(instanceId, 'start code-server', 'already running', {
            sandboxId,
          });
        }
      },
    ).catch((error) => {
      log(instanceId, 'start code-server', 'failed', {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });

    const url = await step
      .do(
        'expose tunnel',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } },
        async (ctx) => {
          log(instanceId, 'expose tunnel', 'start', {
            sandboxId,
            attempt: ctx.attempt,
          });
          const sandbox = getSandbox(this.env.Sandbox, sandboxId, {
            normalizeId: true,
            enableDefaultSession: false,
          });
          const tunnel = await sandbox.tunnels.get(8080);
          log(instanceId, 'expose tunnel', 'done', {
            sandboxId,
            url: tunnel.url,
          });
          return tunnel.url;
        },
      )
      .catch((error) => {
        log(instanceId, 'expose tunnel', 'failed', {
          sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });

    log(instanceId, 'run', 'complete', { sandboxId, url });

    return { url };
  }
}
