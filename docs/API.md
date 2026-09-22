# API Surface

Coding Agent Console exposes these browser-local routes from the custom Node server. They are implementation details for the web UI, not a stable public API.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/bootstrap` | `GET` | Check auth state and return independent Codex and Cursor provider snapshots, capabilities, diagnostics, and active-run summaries. |
| `/api/auth/login` | `POST` | Log in with the configured password or token. |
| `/api/auth/logout` | `POST` | Clear the session cookie. |
| `/api/projects/suggestions` | `GET` | Return suggested server project directories. |
| `/api/projects/resolve?cwd=...` | `GET` | Validate and resolve an absolute project directory. |
| `/api/projects/list?cwd=...` | `GET` | List child directories for the server-side picker. |
| `/api/projects/tree?cwd=...&path=...` | `GET` | Lazily list files and directories under the selected project root. Generated directories are omitted and results are capped at 500 entries. |
| `/api/projects/read?cwd=...&path=...` | `GET` | Read a UTF-8 project file for the read-only Files workspace. Text previews are capped at 512 KiB. |
| `/api/projects/asset?cwd=...&path=...` | `GET` | Serve an authenticated project-local PNG, JPEG, GIF, WebP, or AVIF image for Markdown preview, capped at 10 MiB. |
| `/api/projects/diff?cwd=...` | `GET` | Return working-tree status, file stats, and unified diff. |
| `/api/projects/diff-snapshot` | `POST` | Record a git tree snapshot used for per-turn diff cards. |
| `/api/projects/file?cwd=...&path=...` | `GET` | Preview current working-tree file content for the code drawer. |
| `/api/projects/file-at-tree?cwd=...&tree=...&path=...` | `GET` | Preview file content from a per-turn snapshot. |
| `/ws` | WebSocket | Browser-to-server provider-qualified agent bridge. |

All project file paths are project-relative. The server resolves the selected project and requested target through the filesystem, rejects traversal and absolute paths, and refuses symbolic links whose real target is outside the selected project root. The Files workspace is read-only and also works for non-Git directories; Git snapshot routes retain their separate repository-root semantics.

## WebSocket messages

Agent requests use a provider-qualified envelope:

```json
{
  "type": "agent:request",
  "requestId": "browser-generated-id",
  "provider": "codex",
  "method": "thread/list",
  "params": {}
}
```

Cursor uses the same envelope with `"provider": "cursor"` and Cursor adapter methods such as `session/list`, `session/create`, `session/read`, `session/rename`, `session/suggest-title`, `session/archive`, `model/list`, `run/start`, and `run/stop`. Replies retain the common `reply` envelope and matching `requestId`.

Normalized provider notifications use `agent:event` and always identify `provider` and `sessionId`; events tied to a run also include `runId`. Codex-native notifications and server approval requests remain available through the compatibility event types because Codex thread/turn/approval semantics are intentionally preserved rather than projected onto Cursor.

Durable prompt submission uses `queue:enqueue`. Its reply is sent only after the item is committed to the server-side queue store. Queue state is restored with `queue:list` or the server-initiated `queue:snapshot` event. Queue control messages are `queue:cancel`, `queue:retry`, `queue:pause`, `queue:resume`, and `queue:clear`. Queue items are serialized per provider-qualified thread while different threads may run concurrently.

Text prompts use the durable queue. Image attachments retain the direct-turn path because queue attachment persistence is not enabled yet. A failed, cancelled, or restart-ambiguous task pauses later items for that thread until the user resumes or retries it.

Per-turn Git baseline and post-turn diff capture are best-effort background work. They start alongside provider dispatch or terminal handling, but never delay `turn/start`, the terminal queue state, or the next same-thread item. A queue item can therefore be `running` before `baseTree` is populated, or `completed` before `diff` is populated; later `queue:snapshot` events attach those fields when the background Git work finishes.
