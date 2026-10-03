import type { QueuedPrompt } from "./queueModel";
import { userItemMatchesPrompt, type Turn } from "./threadModel";

export type ClaudeQueuedTurn = Pick<QueuedPrompt, "runId" | "text" | "createdAt" | "updatedAt" | "status" | "timings">;

// Claude's JSONL user UUID differs from the console run ID. Keep the run ID after
// completion as well as during streaming, so queue diffs and late events share it.
// Prompt text alone is insufficient: users often send the same prompt repeatedly.
export function canonicalClaudeTurns(turns: Turn[], runs: ClaudeQueuedTurn[]): Turn[] {
  const proposed = turns.map((turn) => {
    if (runs.some((run) => run.runId === turn.id)) return turn.id;
    if (!turn.startedAt) return turn.id;
    const candidates = runs.filter((run) => {
      if (!run.runId || run.status === "queued" || run.status === "dispatching") return false;
      const start = run.timings?.startRequestedAt ? run.timings.startRequestedAt / 1000 : run.createdAt;
      const terminal = !["running", "waiting_for_input"].includes(run.status);
      const end = terminal ? (run.timings?.completedAt ? run.timings.completedAt / 1000 : run.updatedAt) : Infinity;
      return turn.startedAt! >= Math.floor(start) && turn.startedAt! <= end
        && turn.items.some((item) => userItemMatchesPrompt(item, run.text));
    });
    return candidates.length === 1 ? candidates[0].runId! : turn.id;
  });
  // Ambiguous retry/compaction histories must never collapse two genuine turns.
  const counts = new Map<string, number>();
  for (const id of proposed) counts.set(id, (counts.get(id) || 0) + 1);
  return turns.map((turn, index) => proposed[index] !== turn.id && counts.get(proposed[index]) === 1
    ? { ...turn, id: proposed[index] } : turn);
}
