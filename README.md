# tenfootpole

Open any git repo in a throwaway cloud IDE. Paste an HTTPS git URL and tenfootpole
spins up an isolated Cloudflare Sandbox, clones the repo, starts
[code-server](https://github.com/coder/code-server) (VS Code in the browser) and
gives you a URL.

Some repos you wouldn't touch with a ten-foot pole. For the rest, you need one.

- **Public demo:** tenfootpole.dev (capped at 10 concurrent sandboxes, 10-minute sessions, no sandbox internet access)
- **Run your own, no limits:**

  [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/omkarkhair/tenfootpole)

## How it works

1. `POST /api/provision` validates the URL and asks the `Registry` Durable Object for a slot. If the cap is reached it returns `503 at_capacity`.
2. Each request gets a random 128-bit sandbox ID, even for a repo that was already pulled, so IDE URLs are unguessable and never shared between users.
3. A Workflow clones the repo, starts code-server, exposes port 8080 and starts the session clock.
4. When the session expires, the Registry destroys the sandbox and frees the slot.

## Configuration

Set in `vars` in `wrangler.jsonc`:

| Variable | Default (self-host) | Public site | Meaning |
|---|---|---|---|
| `MAX_CONTAINERS` | `0` (unlimited) | `10` | Max sandboxes alive at once |
| `SESSION_MAX_MINUTES` | `60` | `10` | Hard session length; the sandbox is destroyed after this |
| `EGRESS_MODE` | `open` | `deny` | `deny`: sandboxes have no internet. `open`: full network access |
| `PREVIEW_HOSTNAME` | empty | `tenfootpole.dev` | Wildcard domain for IDE URLs. Empty means quick tunnels |

`wrangler.public.jsonc` holds the public-site settings. Deploy it with `npm run deploy:public`.

### Exposing the IDE

- **Quick tunnels** (default when `PREVIEW_HOSTNAME` is empty): a `*.trycloudflare.com` URL. Needs no domain, but needs `EGRESS_MODE=open` because `cloudflared` runs inside the sandbox.
- **Preview URLs** (when `PREVIEW_HOSTNAME` is set): routed through your Worker, so they work with no sandbox internet. This needs:
  - a domain on Cloudflare;
  - a proxied wildcard DNS record (`*`), which can be a dummy `A` record to `192.0.2.1`;
  - Worker routes for `yourdomain.com` and `*.yourdomain.com/*`, as in `wrangler.public.jsonc`.

  `*.workers.dev` does not support this.

If neither a preview hostname nor open egress is configured, `/api/provision` returns a 500 explaining so.

## Egress policy

With `EGRESS_MODE=deny`, sandboxes have no internet. Every outbound HTTP(S) attempt goes through an interceptor (`src/sandbox.ts`) that logs the decision, host, method and path as JSON (`"source":"outbound"`). Only the repo's git host is allowed, and only during the clone.

Limits:
- Non-HTTP traffic (other ports, raw TCP/UDP) is dropped by the network layer and cannot be logged by the handler.
- Because there is no internet, `npm install` and similar commands fail inside the IDE on the public site.
- Only HTTPS git URLs are supported, since SSH cannot be intercepted.

## Security notes

- code-server runs with `--auth none`. The unguessable URL is the only protection, so treat the link as a secret.
- Sandboxes are destroyed at the end of the session; `sleepAfter` is a backstop.

## Development

Requires Docker (`docker info` must succeed).

```bash
npm install
npm run dev        # http://localhost:8787, cap 10, 10-minute sessions
npm run typecheck
npx wrangler types # after changing wrangler.jsonc
```

`npm run dev` uses `localhost:8787` as the preview hostname, so IDE URLs look like `http://8080-<id>-<token>.localhost:8787/`.

## Deploy

```bash
npm run deploy          # self-hosted config (wrangler.jsonc)
npm run deploy:public   # tenfootpole.dev config (wrangler.public.jsonc)
```
