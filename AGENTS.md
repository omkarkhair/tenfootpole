# tenfootpole

Provision an isolated cloud IDE from any git repository. There are repos you
wouldn't touch with a ten-foot pole — but for the ones you would, you need a
ten-foot pole. Users paste a git HTTPS or SSH endpoint on a landing page; the
app spins up a Cloudflare Sandbox, clones the repo, launches code-server (VS
Code in the browser), and exposes it to the web via a sandbox preview URL (the
"tunnel").

## Architecture Overview

```
┌──────────────┐      POST /api/provision       ┌─────────────────────────┐
│  Landing     │ ────────────────────────────── │  Worker (Hono router)   │
│  Page        │                               │                         │
│  (static     │ ◀──── preview URL ─────────── │  1. validate git URL     │
│  assets)     │                               │  2. getSandbox(id)       │
└──────────────┘                               │  3. gitCheckout(repo)    │
                                               │  4. start code-server    │
                                               │  5. exposePort(8080)     │
                                               └────────────┬────────────┘
                                                            │ DO binding
                                              ┌─────────────▼─────────────┐
                                              │  Sandbox Durable Object    │
                                              │  (Container instance)     │
                                              │                           │
                                              │  ┌───────────────────────┐ │
                                              │  │ code-server :8080     │ │
                                              │  │ /workspace/<repo>     │ │
                                              │  └───────────────────────┘ │
                                              │                           │
                                              │  Preview URL (tunnel)     │
                                              │  *.workers.dev or custom  │
                                              └───────────────────────────┘
```

### Components

| Component              | Technology                         | Purpose                                    |
|-----------------------|------------------------------------|--------------------------------------------|
| Landing page           | Static HTML/CSS/JS (Worker assets) | Collect git endpoint, show progress, redirect to IDE |
| Worker API            | Cloudflare Worker (TypeScript)     | Orchestrate provisioning, return preview URL |
| Sandbox               | `@cloudflare/sandbox` (DO + Container) | Isolated container running code-server + cloned repo |
| IDE                    | code-server (VS Code in browser)   | Full code editing experience in the browser |
| Tunnel / exposure     | `sandbox.exposePort()`              | Public preview URL for the IDE port         |
| Git access            | `sandbox.gitCheckout()` / `exec`    | Clone the user's repo into the sandbox     |

### Key SDK APIs Used

```typescript
// Derive stable sandbox ID from repo URL (SHA-256, first 8 hex chars)
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(repo));
const sandboxId = Array.from(new Uint8Array(digest))
  .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);

// Get sandbox instance (lazy-starts container on first operation)
const sandbox = getSandbox(env.Sandbox, sandboxId);

// Clone the repo (built-in helper)
await sandbox.gitCheckout(repo, { targetDir: 'project' });

// Start code-server in background
await sandbox.exec('code-server --bind-addr 0.0.0.0:8080 --auth none --workspace /workspace/project &');

// Expose the IDE port to the web (returns preview URL)
const { url } = await sandbox.exposePort(8080);
```

## Tech Stack

- **Runtime**: Cloudflare Workers (TypeScript)
- **Sandbox**: `@cloudflare/sandbox` (Durable Objects + Containers)
- **IDE**: code-server (VS Code in browser), installed in the sandbox Dockerfile
- **Frontend**: Vanilla HTML/CSS/JS served as static assets (no build step)
- **Package manager**: npm

## Commands

| Command                  | Purpose                                      |
|--------------------------|----------------------------------------------|
| `npm install`            | Install dependencies                         |
| `npm run dev`            | Local development (wrangler dev)             |
| `npm run deploy`         | Deploy to Cloudflare                         |
| `npm run typecheck`      | TypeScript type checking                     |
| `npx wrangler types`     | Generate TypeScript types from bindings      |
| `docker info`            | Verify Docker is running (required for dev)  |

Run `npx wrangler types` after changing bindings in `wrangler.jsonc`.

## Development Phases

Build incrementally. Each phase produces a testable milestone.

### Phase 1 — Project Scaffold

**Goal**: Working Worker with Sandbox binding, empty Dockerfile, deploys without error.

- [ ] `package.json` with `@cloudflare/sandbox`, `wrangler`, `typescript` deps
- [ ] `tsconfig.json` (ES2022, module ESNext, bundler resolution)
- [ ] `wrangler.jsonc` with: containers (class `Sandbox`, image `./Dockerfile`, instance_type `lite`), durable_objects binding (`Sandbox`), migrations (`new_sqlite_classes: ["Sandbox"]`), static assets (`./public`), `nodejs_compat` flag
- [ ] `Dockerfile` extending `docker.io/cloudflare/sandbox:0.10.2` (install code-server)
- [ ] `src/index.ts` re-exporting `Sandbox` from `@cloudflare/sandbox`
- [ ] `public/index.html` placeholder
- [ ] `npm install` + `npm run dev` succeeds

### Phase 2 — Landing Page (Frontend)

**Goal**: User can paste a git URL, submit, and see a loading state.

- [ ] `public/index.html` — centered card with git URL input, submit button, error area, loading spinner
- [ ] `public/style.css` — clean, minimal, responsive (dark theme recommended)
- [ ] `public/app.js` — form submit handler, validates URL (HTTPS or SSH format), POSTs JSON to `/api/provision`, shows loading, redirects to returned preview URL
- [ ] URL validation: accept `https://github.com/...`, `git@github.com:...`, `ssh://git@...`
- [ ] Error display for invalid URLs and server errors

### Phase 3 — Provisioning API

**Goal**: POST `/api/provision` returns a working preview URL for the IDE.

- [ ] `src/index.ts` — route POST `/api/provision`
- [ ] Parse JSON body `{ repo: string }`, validate git URL format
- [ ] Derive sandbox ID from repo URL (SHA-256 hash, first 8 chars)
- [ ] `getSandbox(env.Sandbox, sandboxId)` — create/reuse sandbox
- [ ] `sandbox.gitCheckout(repo, { targetDir: 'project' })` — clone repo
- [ ] Start code-server: `sandbox.exec('code-server --bind-addr 0.0.0.0:8080 --auth none /workspace/project &')`
- [ ] Wait for code-server to be ready (poll `localhost:8080` or check process)
- [ ] `sandbox.exposePort(8080)` — get preview URL
- [ ] Return JSON `{ url: string }` to frontend
- [ ] Serve static assets for all other routes (landing page)
- [ ] Error handling: repo not found, clone failure, code-server startup failure

### Phase 4 — IDE in Sandbox (Dockerfile)

**Goal**: code-server runs in the sandbox, serves the cloned repo, accessible via preview URL.

- [ ] Extend Dockerfile: `RUN npm install -g code-server`
- [ ] Verify code-server starts and binds to `0.0.0.0:8080`
- [ ] Configure code-server to open `/workspace/project` as workspace root
- [ ] Set `--auth none` for MVP (no password prompt); plan auth for production
- [ ] Test end-to-end: paste a public GitHub repo URL → get preview URL → IDE loads with repo files

### Phase 5 — SSH Git Endpoint Support

**Goal**: Users can paste SSH git endpoints (`git@github.com:org/repo.git`).

- [ ] Detect SSH vs HTTPS URL format
- [ ] For SSH: generate or accept an SSH key pair, write to `~/.ssh/` in sandbox
- [ ] Add `github.com` (or relevant host) to `~/.ssh/known_hosts` (or disable strict host checking for MVP)
- [ ] Configure `git` to use the SSH key
- [ ] Document how users provide their SSH key (env var, upload, or generate-and-add-to-GitHub)
- [ ] MVP approach: support public HTTPS repos first, SSH as enhancement

### Phase 6 — Production Hardening

**Goal**: Safe, reliable, production-ready.

- [ ] Custom domain with wildcard DNS for preview URLs (`.workers.dev` doesn't support preview subdomains in production)
- [ ] code-server auth: generate a random password per sandbox, return it to the user
- [ ] Sandbox lifecycle: set `sleepAfter` appropriately, provide cleanup endpoint
- [ ] Rate limiting on `/api/provision` (prevent abuse)
- [ ] Input sanitization on git URL (prevent command injection via `shellQuote`)
- [ ] Repo size limits and timeout on clone
- [ ] Progress feedback: stream clone progress to frontend (SSE or polling)
- [ ] Error recovery: retry failed clones, handle non-existent repos gracefully

## File Structure

```
tenfootpole/
├── AGENTS.md              # This file — project guide and progress tracker
├── package.json
├── tsconfig.json
├── wrangler.jsonc         # Worker config: containers, DO, assets, migrations
├── Dockerfile             # Sandbox image: base + code-server
├── public/
│   ├── index.html         # Landing page
│   ├── style.css          # Styles
│   └── app.js             # Frontend logic (form, API call, redirect)
└── src/
    └── index.ts           # Worker: routes, provisioning orchestration
```

## Important Notes

### Sandbox SDK specifics

- **Must export Sandbox class**: `export { Sandbox } from '@cloudflare/sandbox'` — Worker won't deploy without it.
- **Lazy start**: `getSandbox()` returns immediately; container starts on first operation.
- **Sleep**: Containers sleep after 10 min of inactivity (configurable via `sleepAfter`).
- **Preview URLs**: Need a custom domain with wildcard DNS (`*.yourdomain.com`) for production. The `.workers.dev` domain does NOT support preview URL subdomains.
- **Docker required**: Local dev needs Docker running (`docker info` must succeed).
- **Internet access**: By default sandboxes have internet access. To restrict, set `enableInternet = false` and use `allowedHosts`. For git clone, `github.com` (and `gitlab.com`, `bitbucket.org`, etc.) must be allowed.

### Security

- **Always shell-quote user input**: Use a `shellQuote()` helper to prevent command injection.
- **Validate git URLs**: Reject anything that isn't a valid HTTPS or SSH git endpoint.
- **code-server auth**: `--auth none` is fine for MVP but must be replaced with password auth before production.
- **No secrets in container**: Use the `outboundByHost` proxy pattern to inject secrets at the Worker level, never bake them into the container image.

### References

- Sandbox docs: https://developers.cloudflare.com/sandbox/
- Sandbox API: https://developers.cloudflare.com/sandbox/api/
- Expose services guide: https://developers.cloudflare.com/sandbox/guides/expose-services/
- code-server: https://github.com/coder/code-server
- Wrangler config: https://developers.cloudflare.com/workers/wrangler/configuration/
- Workers static assets: https://developers.cloudflare.com/workers/static-assets/binding/
