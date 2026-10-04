import assert from "node:assert/strict";
import { deferWorkLogs, readWorkLog } from "../server/workLog";
import { applyItemsFromTurns, applyWorkLog, getThreadViewState } from "../app/threadViewStore";
import { partitionTurnItems, type Turn } from "../app/threadModel";

const user = { id: "u1", type: "userMessage", content: [{ type: "text", text: "Fix it" }] };
const note = { id: "n1", type: "agentMessage", text: "Looking", phase: "commentary" };
const command = { id: "c1", type: "commandExecution", command: "ls", aggregatedOutput: "x".repeat(1000) };
const thought = { id: "r1", type: "reasoning", summary: [] };
const final = { id: "f1", type: "agentMessage", text: "Done", phase: "final_answer" };
const history = () => ({ thread: { id: "t", turns: [
  { id: "turn-1", status: "completed", items: [user, note, command, thought, final] },
  { id: "turn-2", status: "inProgress", items: [{ ...user, id: "u2" }, { ...command, id: "c2" }] },
  { id: "turn-3", status: "interrupted", items: [{ ...user, id: "u3" }, { ...command, id: "c3" }] }
] } });

const deferred = deferWorkLogs("codex", history()).thread.turns as Turn[];
assert.deepEqual(deferred[0].items.map((item) => item.id), ["u1", "f1"], "completed turn keeps prompt and answer only");
assert.deepEqual(deferred[0].workLog, { turnId: "turn-1", updates: 1, actions: 1, reasoning: 1 });
assert.equal(deferred[1].items.length, 2, "live turns keep their steps");
assert.equal(deferred[2].items.length, 2, "turns without a final answer open their log, so keep it");
assert.equal(partitionTurnItems(deferred[0].items, false, true).finalItems[0].id, "f1");

async function main() {
let reads = 0;
const read = async () => { reads += 1; return history(); };
assert.deepEqual((await readWorkLog("codex", "t", "turn-1", read)).map((item) => item.id), ["n1", "c1", "r1"]);
assert.equal(reads, 0, "a cached thread answers without a provider read");
assert.equal((await readWorkLog("claude", "t", "turn-1", read)).length, 3, "a miss refills from one read");
assert.equal(reads, 1);
await assert.rejects(readWorkLog("codex", "t", "turn-2", read), /no longer available/);

// Client: steps load after the prompt and survive a refresh that defers them again.
applyItemsFromTurns("codex:t", deferred);
assert.deepEqual(getThreadViewState().turnsByThread["codex:t"]["turn-1"].workLog?.turnId, "turn-1");
applyWorkLog("codex:t", "turn-1", [note, command, thought]);
const ids = () => getThreadViewState().turnsByThread["codex:t"]["turn-1"].itemIds;
assert.deepEqual(ids(), ["u1", "n1", "c1", "r1", "f1"]);
applyItemsFromTurns("codex:t", deferWorkLogs("codex", history()).thread.turns as Turn[]);
assert.deepEqual(ids(), ["u1", "n1", "c1", "r1", "f1"], "refresh keeps loaded steps in place");
assert.equal(getThreadViewState().itemsByThread["codex:t"].c1, command);

console.log("work log deferral tests passed");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
