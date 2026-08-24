import { WorkflowEntrypoint, type WorkflowStep } from 'cloudflare:workers';
import type { WorkflowEvent } from 'cloudflare:workers';
import { getSandbox } from '@cloudflare/sandbox';

export type ProvisionParams = {
  repo: string;
};

export type ProvisionOutput = {
  url: string;
};

// Applied on first getSandbox() call for a given sandbox ID.
//
// Note: traffic through an exposed tunnel/port goes straight to the
// container and does NOT reset this inactivity timer — only calls made
// through the Sandbox DO (via the SDK) do. A user actively using code-server
// through the tunnel can still have their sandbox go to sleep and the tunnel
// die underneath them. Extend the default (10m) generously here since this
// is an interactive IDE session; a follow-up could periodically "ping" the
// sandbox (e.g. `sandbox.exists()`) from the client while the tab is open,
// or use `keepAlive` with explicit `destroy()` cleanup.
//
// `@cloudflare/sandbox@next` has no session concept (each `exec()` call is
// independent — pass `cwd`/`env` per call instead), so `enableDefaultSession`
// from the stable package is gone.
const SANDBOX_OPTIONS = {
  normalizeId: true,
  sleepAfter: '2h',
} as const;

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
        const sandbox = getSandbox(this.env.Sandbox, sandboxId, SANDBOX_OPTIONS);

        const projectExists = await sandbox.exists('/workspace/project');
        log(instanceId, 'checkout repo', 'exists check', {
          sandboxId,
          exists: projectExists.exists,
        });

        if (!projectExists.exists) {
          log(instanceId, 'checkout repo', 'cloning', { sandboxId, repo });
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
          const result = await clone.output({ encoding: 'utf8' });
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
        'expose tunnel',
        { retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' } },
        async (ctx) => {
          log(instanceId, 'expose tunnel', 'start', {
            sandboxId,
            attempt: ctx.attempt,
          });
          const sandbox = getSandbox(this.env.Sandbox, sandboxId, SANDBOX_OPTIONS);
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
