# Project Instructions

## Feishu Completion Notifications

Standing user authorization:

- When the user explicitly asks for a Feishu/Lark completion notification in the current request, send it after the requested work is complete without asking for another confirmation.
- Trigger examples include "send me a Feishu message when done", "Feishu notify me after this finishes", "做完了飞书给我发一条消息", "飞书通知我", and equivalent wording.
- Recipient: the local owner/user `连庆`, open_id `ou_731b47962ce9e91ce3d1cbabeac3ba58`.
- Sending identity: the configured Feishu app/bot via `lark-cli`.
- Preferred command:

```bash
scripts/notify-feishu-me.sh "Codex task complete: <short result>"
```

- If the user provides exact notification content, send that content. Otherwise send a concise completion summary with key verification status.
- Do not include secrets, access tokens, full logs, or long diffs in the Feishu message.
- This standing authorization applies only to completion/status notifications to the recipient above. For other recipients, group chats, destructive actions, or unrelated message content, confirm explicitly first.
- If sending fails, report the failure and the CLI error in the final response.

## GitHub Proxy Rule

If GitHub access fails because of network connectivity, DNS, timeout, TLS handshake, or repository fetch/clone issues, retry the affected command with these proxy variables in the same shell:

```bash
export http_proxy=http://100.68.175.233:3128; export https_proxy=http://100.68.175.233:3128
```

Use this only for GitHub-related access problems, such as `github.com`, `raw.githubusercontent.com`, or dependencies fetched from GitHub.

## Volcengine ML Training Queue Rule

When creating Volcengine ML training jobs, only use these resource queues:

- `VLA-A800-训练队列`
- `VLA训练队列-1`

Before every `create_training_job` call:

1. Call `list_resource_queues` and resolve the current queue IDs by exact queue name.
2. Compare each allowed queue's available capacity from the returned quota fields, especially available GPUs:
   `quota_capability.gpu_count - quota_allocated.gpu_count`.
3. Choose an allowed queue that has enough free capacity for the requested job so the job starts instead of sitting in `Queued` when another allowed queue is available.
4. If both allowed queues have capacity, prefer the queue whose GPU type / instance type matches the job request. If both match, use the queue with more free matching GPUs.
5. If neither allowed queue has enough capacity, still do not use any other queue. Submit only to one of the two allowed queues, choosing the best matching queue, and mention that no allowed queue currently has enough free capacity.

Known queue IDs from the latest check, to be revalidated before use:

- `VLA-A800-训练队列`: `q-20251231151234-7t96n`
- `VLA训练队列-1`: `q-20250527113834-pppjg`
