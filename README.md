# Codex Remote Console

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Next.js](https://img.shields.io/badge/next.js-15-black?logo=next.js)](https://nextjs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

_Self-hosted web UI for Codex CLI on the machine where your repo and environment already live._

Codex stays on the server (GPU box, workstation, lab); your browser is the console for prompts, streaming output, approvals, and diffs—similar in spirit to self-hosted surfaces like [yepanywhere](https://github.com/kzahel/yepanywhere), but wired to Codex CLI + `codex app-server`.

<video src="docs/images/teaser.mp4" controls autoplay loop muted playsinline width="100%"></video>

*Demo: prompt in the browser, remote Codex run, approvals, streamed output, per-turn diff.*

## Features

- Start, resume, and manage remote Codex threads; sessions keep running when the tab closes.
- Project picker (suggestions + safe directory browsing—no arbitrary file dumps).
- WebSocket streaming of messages, reasoning, commands, plans, file changes.
- Runtime controls: model, reasoning, sandbox, approval policy, tier, collaboration.
- Browser handling for approvals and `request_user_input`; optional auto-approve for clearly read-only commands.
- Git snapshot each turn + inline diff; slash commands (`/diff`, `/review`, `/model`, `/permissions`, and others).
- Configurable base path for reverse proxies.

## Requirements

Node **18.18+**, **`codex` on PATH**, Codex authenticated for the same OS user that runs this app.

## Quick start

```bash
npm install
CODEX_WEB_PASSWORD='change-me' PORT=3027 npm run dev
```

Open `http://<host>:3027` (defaults bind `0.0.0.0` for LAN / proxy).

**Production:**

```bash
npm run build
CODEX_WEB_PASSWORD='change-me' CODEX_WEB_SECRET='use-a-long-random-secret' PORT=3027 npm run start
```

`CODEX_WEB_TOKEN` works instead of password. Production refuses to start without password or token.

## Security

**Alpha.** For private VPN / SSH tunnel / trusted LAN or reverse proxy with your own auth and TLS—not a multi-tenant public service.

Whoever reaches the UI runs as the same user as the Node process (projects, shell, Codex credentials). Set `CODEX_WEB_PASSWORD` or `CODEX_WEB_TOKEN`, use a strong `CODEX_WEB_SECRET` for cookie signing, and never commit real secrets.

## Screenshots

![Codex Remote Console session overview](docs/images/console-overview.svg)

| Login | Flow | Approvals |
| --- | --- | --- |
| ![Password login](docs/images/login.png) | ![Remote control flow](docs/images/remote-flow.svg) | ![Approvals in browser](docs/images/approval-flow.svg) |

## How it works (short)

Custom server (`server/index.ts`) on the remote host serves Next.js + WebSockets at `/ws`. It spawns `codex app-server --listen stdio://` (`server/codex/stdioGateway.ts`) and relays the Codex protocol to browsers. Gateway mode `CODEX_WEB_GATEWAY=ws` uses the legacy loopback transport. Thread defaults favor persistent history (`ephemeral: false`, `persistExtendedHistory: true`).

HTTP/WebSocket routes: [docs/API.md](docs/API.md).

## Behind a reverse proxy (subpath)

Build and run with the same base path, e.g. `/codex_web/`:

```bash
NEXT_PUBLIC_BASE_PATH=/codex_web npm run build
NODE_ENV=production NEXT_PUBLIC_BASE_PATH=/codex_web CODEX_WEB_PASSWORD='change-me' PORT=3027 npm run start
```

Or use **`npm run dev:proxy`** / **`npm run start:proxy`** for the bundled defaults. Proxy: `https://your-host.example/codex_web/` → `http://127.0.0.1:3027`.

## Configuration & scripts

**Env:** see [`.env.example`](.env.example) for variables (`PORT`, `HOST`, `NEXT_PUBLIC_BASE_PATH`, auth, cookie secret, gateway, auto-approve flags, optional `CODEX_WEB_PROJECT_ROOTS`, etc.).

**npm:** `npm run dev` · `npm run build` · `npm run start` · `npm run check` / `npm run check:proxy` · `npm run test:slash` · `npm run test:diff` · `npm run generate:codex-protocol`.

Approval behavior (read-only auto-approve, MCP, destructive commands) is summarized in `.env.example` and implemented in `server/approvalPolicy.ts`.

## Troubleshooting

| Symptom | Likely fix |
| --- | --- |
| `codexVersion` unavailable | `codex` not on PATH for the Node process. |
| Production auth error | Set `CODEX_WEB_PASSWORD` or `CODEX_WEB_TOKEN`. |
| `Timed out waiting for codex app-server` | Confirm `codex app-server` works from the same environment; check logs for `[codex-app-server]`. |
| Broken assets/WebSocket behind proxy | `NEXT_PUBLIC_BASE_PATH` must match the proxy path at **build** and **run** time. |

## Contributing & license

Issues and PRs welcome—small changes, tests where behavior shifts, avoid dependency bloat.

**License:** MIT — [LICENSE](LICENSE).

**GitHub About (suggested):** Self-hosted browser console for Codex CLI on a remote machine.
**Topics:** `codex`, `codex-cli`, `remote-development`, `webui`, `ai-coding`, `self-hosted`, `nextjs`, `websocket`.
