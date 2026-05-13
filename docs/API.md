# API Surface

Codex Remote Console exposes these browser-local routes from the custom Node server. They are implementation details for the web UI, not a stable public API.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/bootstrap` | `GET` | Check auth state, Codex version, and gateway snapshot. |
| `/api/auth/login` | `POST` | Log in with the configured password or token. |
| `/api/auth/logout` | `POST` | Clear the session cookie. |
| `/api/projects/suggestions` | `GET` | Return suggested server project directories. |
| `/api/projects/resolve?cwd=...` | `GET` | Validate and resolve an absolute project directory. |
| `/api/projects/list?cwd=...` | `GET` | List child directories for the server-side picker. |
| `/api/projects/diff?cwd=...` | `GET` | Return working-tree status, file stats, and unified diff. |
| `/api/projects/diff-snapshot` | `POST` | Record a git tree snapshot used for per-turn diff cards. |
| `/api/projects/file?cwd=...&path=...` | `GET` | Preview current working-tree file content for the code drawer. |
| `/api/projects/file-at-tree?cwd=...&tree=...&path=...` | `GET` | Preview file content from a per-turn snapshot. |
| `/ws` | WebSocket | Browser-to-server Codex bridge. |
