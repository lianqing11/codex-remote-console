---
name: start-coding-agent-console
description: >-
  Start or restart the Coding Agent Console web service in a user-accessible
  tmux session. Use when the user says the service is down, asks to start/重启
  codex_web_cursor, open tmux for the console, or bring up PORT 3032 /proxy
  /codex_web_cursor/.
---

# Start Coding Agent Console (tmux)

## Defaults

| Item | Value |
|------|--------|
| Project | current Git checkout (`git rev-parse --show-toplevel`) |
| tmux session | `codex_web_cursor` |
| Port | `3032` |
| Proxy URL | `http://<gateway-host>:1818/codex_web_cursor/` |
| Env file | `.env.local` (gitignored; includes password + proxy) |

## Start / restart

1. Stop any old process for this project:

```bash
repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
bash scripts/kill-coding-agent-console.sh 3032
```

2. Ensure tmux session exists (create if missing):

```bash
repo_root="$(git rev-parse --show-toplevel)"
tmux has-session -t codex_web_cursor 2>/dev/null || tmux new-session -d -s codex_web_cursor -c "$repo_root"
```

3. Start the production proxy build in that session:

```bash
repo_root="$(git rev-parse --show-toplevel)"
tmux send-keys -t codex_web_cursor C-c
tmux send-keys -t codex_web_cursor "cd '$repo_root' && set -a && source .env.local && set +a && NODE_ENV=production NEXT_PUBLIC_BASE_PATH=/codex_web_cursor PORT=3032 HOST=0.0.0.0 npx tsx server/index.ts" Enter
```

If code or `NEXT_PUBLIC_BASE_PATH` changed and assets break, rebuild first then start:

```bash
repo_root="$(git rev-parse --show-toplevel)"
tmux send-keys -t codex_web_cursor "cd '$repo_root' && set -a && source .env.local && set +a && npm run build:proxy && NODE_ENV=production NEXT_PUBLIC_BASE_PATH=/codex_web_cursor PORT=3032 HOST=0.0.0.0 npx tsx server/index.ts" Enter
```

Do **not** use bare `npm run start:proxy` unless a rebuild is intended — its `prestart` always runs `build:proxy`.

4. Verify:

```bash
tmux capture-pane -t codex_web_cursor -p | tail -20
ss -tlnp | grep 3032
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3032/
curl --noproxy '*' -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:1818/codex_web_cursor/
```

Expect log line `coding-agent-console listening on http://0.0.0.0:3032` and HTTP `200`.

## User attach

User can inspect logs / control the process with:

```bash
tmux attach -t codex_web_cursor
```

Detach without killing: `Ctrl-b` then `d`.

## Notes

- Production requires `CODEX_WEB_PASSWORD` or `CODEX_WEB_TOKEN` (from `.env.local`).
- `CODEX_WEB_PROXY_URL` in `.env.local` is for the spawned Codex process, not for Nginx.
- The Docker gateway should proxy `:1818/codex_web_cursor/` → `0.0.0.0:3032`; use the sibling `web_proxy/proxy.sh` workflow to add or validate it.
- Prefer the dedicated session name `codex_web_cursor` so the user can always find it; do not bury the server in unrelated sessions like `data`.
