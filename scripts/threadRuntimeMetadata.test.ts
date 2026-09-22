import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  codexThreadRuntimeFromLine,
  enrichCodexThreadRuntime,
  readCodexThreadRuntime
} from "../server/codex/threadRuntime";

const applied = JSON.stringify({
  type: "event_msg",
  payload: {
    type: "thread_settings_applied",
    thread_settings: {
      model: "gpt-new",
      reasoning_effort: "high",
      service_tier: "fast",
      collaboration_mode: { mode: "plan", settings: { model: "gpt-new", reasoning_effort: "high" } }
    }
  }
});

assert.deepEqual(codexThreadRuntimeFromLine(applied), {
  model: "gpt-new",
  reasoningEffort: "high",
  serviceTier: "fast",
  mode: "plan"
});
assert.deepEqual(codexThreadRuntimeFromLine(JSON.stringify({
  type: "turn_context",
  payload: { model: "gpt-old", effort: "xhigh", collaboration_mode: { mode: "default" } }
})), {
  model: "gpt-old",
  reasoningEffort: "xhigh",
  serviceTier: null,
  mode: "default"
});
assert.equal(codexThreadRuntimeFromLine("not json"), null);

async function main() {
  const root = await mkdtemp(join(tmpdir(), "codex-thread-runtime-"));
  const rolloutPath = join(root, "rollout-test.jsonl");
  const oversizedOutput = JSON.stringify({ type: "response_item", payload: { output: "x".repeat(150_000) } });
  await writeFile(rolloutPath, [
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-old", effort: "medium" } }),
    oversizedOutput,
    applied,
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } })
  ].join("\n"));

  assert.deepEqual(await readCodexThreadRuntime(rolloutPath, { allowedRoot: root }), {
    model: "gpt-new",
    reasoningEffort: "high",
    serviceTier: "fast",
    mode: "plan"
  });
  assert.equal(await readCodexThreadRuntime("/etc/passwd", { allowedRoot: root }), null);

  const result = await enrichCodexThreadRuntime("thread/list", {
    data: [{ id: "thread-1", path: rolloutPath }]
  }) as any;
  // The production enricher deliberately rejects paths outside CODEX_HOME.
  assert.equal(result.data[0].runtime, undefined);
  console.log("Codex thread runtime metadata tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
