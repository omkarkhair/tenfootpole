import { WorkflowEntrypoint, type WorkflowStep } from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';
import { AI_HOST } from './ai-proxy';
import { sessionMinutes, type Registry } from './registry';

export type ProvisionParams = {
  repo: string;
  /** Random, unguessable id minted per request; never derived from the repo. */
  sandboxId: string;
};

export type ProvisionOutput = {
  url: string;
  /** Epoch ms at which the sandbox is destroyed. */
  expiresAt: number;
};

// Applied on first getSandbox() call for a given sandbox ID.
//
// The Registry Durable Object enforces the hard session limit by destroying
// the sandbox when its lease expires. `sleepAfter` is only a backstop (in case
// that destroy fails), so it is set slightly past the session length.
function sandboxOptions(env: Env) {
  return {
    normalizeId: true,
    sleepAfter: `${sessionMinutes(env) + 2}m`,
  } as const;
}

function registryStub(env: Env): DurableObjectStub<Registry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName('global'));
}

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
    const { repo, sandboxId } = event.payload;
    const { instanceId } = event;
    const registry = registryStub(this.env);

    log(instanceId, 'run', 'start', { repo, sandboxId });

    try {
      return await this.provision(event, step, registry);
    } catch (error) {
      // Free the slot and the container right away instead of waiting for
      // the lease to expire.
      log(instanceId, 'run', 'failed, releasing slot', {
        sandboxId,
        error: error instanceof Error ? error.message : String(error),
      });
      await registry.release(sandboxId).catch(() => {});
      await getSandbox(this.env.Sandbox, sandboxId)
        .destroy()
        .catch(() => {});
      throw error;
    }
  }

  private async provision(
    event: WorkflowEvent<ProvisionParams>,
    step: WorkflowStep,
    registry: DurableObjectStub<Registry>,
  ): Promise<ProvisionOutput> {
    const { repo, sandboxId } = event.payload;
    const { instanceId } = event;
    const SANDBOX_OPTIONS = sandboxOptions(this.env);

    await step.do(
      'checkout repo',
      { retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' } },
      async (ctx) => {
        log(instanceId, 'checkout repo', 'start', {
          sandboxId,
          attempt: ctx.attempt,
        });
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, SANDBOX_OPTIONS);

        const projectExists = await sandbox.exists('/workspace/project');
        log(instanceId, 'checkout repo', 'exists check', {
          sandboxId,
          exists: projectExists.exists,
        });

        if (!projectExists.exists) {
          log(instanceId, 'checkout repo', 'cloning', { sandboxId, repo });
          // The sandbox has no internet. Open a hole to the repo's git host
          // for the duration of the clone only.
          const gitHost = new URL(repo).hostname;
          await sandbox.setOutboundByHost(gitHost, 'allowGitHost');
          // `gitCheckout` is removed on @next — run git directly via exec().
          // Unlike stable's buffered `exec(string)`, @next's `exec(argv)`
          // resolves at launch; call `.output()` to wait for it to finish.
          const clone = await sandbox.exec([
            'git',
            'clone',
            '--',
            repo,
            '/workspace/project',
          ]);
          let result;
          try {
            result = await clone.output({ encoding: 'utf8' });
          } finally {
            await sandbox.removeOutboundByHost(gitHost);
          }
          if (result.exitCode !== 0) {
            throw new Error(
              `git clone failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
            );
          }
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
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, SANDBOX_OPTIONS);

        // `command` is now argv (string[]), not a joined string.
        // Route the in-sandbox agent's inference calls through the Worker.
        // Done once the container is up (after the clone), for its lifetime.
        await sandbox.setOutboundByHost(AI_HOST, 'workersAi');

        const processes = await sandbox.listProcesses();
        const existing = processes.find(
          (p) =>
            p.state === 'running' &&
            p.command.some((part) => part.includes('code-server')),
        );
        log(instanceId, 'start code-server', 'process check', {
          sandboxId,
          processCount: processes.length,
          codeServerRunning: Boolean(existing),
        });

        // `startProcess` is gone on @next — `exec()` covers both short and
        // long-running work via the same handle, resolving once the process
        // has launched (not once it exits).
        const server = existing
          ? await sandbox.getProcess(existing.id)
          : null;

        if (server) {
          log(instanceId, 'start code-server', 'already running', {
            sandboxId,
          });
        } else {
          log(instanceId, 'start code-server', 'launching', { sandboxId });
          const launched = await sandbox.exec([
            'code-server',
            '--bind-addr',
            '0.0.0.0:8080',
            '--auth',
            'none',
            '--disable-telemetry',
            '--disable-update-check',
            '/workspace/project',
          ]);
          log(instanceId, 'start code-server', 'waiting for port', {
            sandboxId,
          });
          await launched.waitForPort(8080, { timeout: 30_000 });
          log(instanceId, 'start code-server', 'port ready', { sandboxId });
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
        'expose ide',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } },
        async (ctx) => {
          log(instanceId, 'expose ide', 'start', {
            sandboxId,
            attempt: ctx.attempt,
          });
          const sandbox = getSandbox(this.env.Sandbox, sandboxId, SANDBOX_OPTIONS);

          // Preview URLs are routed through this Worker, so they work with
          // no sandbox egress at all. They need a wildcard domain.
          // Quick tunnels (the fallback) run `cloudflared` inside the
          // container and need real outbound access (EGRESS_MODE=open).
          let exposed: string;
          if (this.env.PREVIEW_HOSTNAME) {
            const preview = await sandbox.exposePort(8080, {
              hostname: this.env.PREVIEW_HOSTNAME,
            });
            exposed = preview.url;
          } else {
            exposed = (await sandbox.tunnels.get(8080)).url;
          }
          log(instanceId, 'expose ide', 'done', { sandboxId, url: exposed });
          return exposed;
        },
      )
      .catch((error) => {
        log(instanceId, 'expose ide', 'failed', {
          sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });

    // Provisioning is done: start the hard session clock.
    const { expiresAt } = await step.do('start session clock', async () =>
      registry.markReady(sandboxId),
    );

    log(instanceId, 'run', 'complete', { sandboxId, url, expiresAt });

    return { url, expiresAt };
  }
}
