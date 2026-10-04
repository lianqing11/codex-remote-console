// Separate process: the SDK resolves CLAUDE_CONFIG_DIR when it is imported.
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { stat, rm } from "node:fs/promises";
import path from "node:path";
const [sourceId, cwd, title, sourceFile, upToMessageId] = process.argv.slice(2);
try {
  const before = await stat(sourceFile);
  const result = await forkSession(sourceId, { dir: cwd, title, ...(upToMessageId ? { upToMessageId } : {}) });
  const after = await stat(sourceFile);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    await rm(path.join(path.dirname(sourceFile), `${result.sessionId}.jsonl`), { force: true });
    throw new Error("FORK_SAFE_RETRY:Claude source changed during fork. Retry when it is idle.");
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
