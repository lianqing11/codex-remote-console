# Project Instructions

## Completion notifications

- Send a Feishu/Lark completion notification only when the user explicitly asks for one in the current request.
- Use `scripts/notify-feishu-me.sh "Codex task complete: <short result>"` after the requested work and verification finish.
- The script reads the recipient from `CODEX_WEB_FEISHU_USER_OPEN_ID`; keep the real identifier in `.env.local` or the process environment.
- If the user provides exact notification text, send that text. Otherwise send a concise completion summary with verification status.
- Never include secrets, credentials, full logs, or long diffs in a notification.
- Report the command error if delivery fails.

## Network access

- Keep proxy endpoints in the local environment. Do not commit host-specific proxy URLs.
- If GitHub access needs a proxy, use the operator-provided `http_proxy` and `https_proxy` values for that command only.
- Do not reuse a GitHub proxy for Hugging Face downloads.

## Repository hygiene

- Do not commit `.env.local`, credentials, runtime state, build output, logs, uploaded files, or host-specific paths and identifiers.
- Keep examples portable by using environment variables, loopback addresses, and placeholder paths.
