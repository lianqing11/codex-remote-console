import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionForks } from "../server/sessionFork";
import { forkCursorStore, decodeCursorMetadata, encodeCursorMetadata, CURSOR_FORK_VERSION } from "../server/providers/cursorFork";
import { ClaudeProvider, claudeTurnCutoff, projectSlug } from "../server/providers/claude";
import { orderBranchThreads } from "../app/forkTree";
import { normalizeThread, type Thread } from "../app/threadModel";
import { inheritedForkRuntime, defaultRuntimeSettings } from "../app/sessionRuntime";
import { findSlashCommand, slashCommandDisabledReason } from "../app/slashCommands";

async function main() {
  const inherited = inheritedForkRuntime({ ...defaultRuntimeSettings, model: "unrelated", reasoningEffort: "low" }, { runtime: { model: "source-model", reasoningEffort: "high", serviceTier: "priority", mode: "plan", forkSettings: { approvalPolicy: "never", sandbox: "read-only" } } });
  assert.deepEqual([inherited.model, inherited.reasoningEffort, inherited.mode, inherited.sandboxMode], ["source-model", "high", "plan", "read-only"]);
  const root = await mkdtemp(path.join(tmpdir(), "session-fork-test-"));
  const file = path.join(root, "forks.sqlite");
  let forks = new SessionForks(file), nativeCalls = 0;
  const source = { id: "source", name: "Original", status: { type: "idle" }, turns: [{ id: "t1", status: "completed", items: [{ type: "userMessage" }] }, { id: "t2", status: "completed", items: [{ type: "userMessage" }] }] };
  const requests: any[] = [];
  const request = async (_provider: any, method: string, params: any): Promise<any> => {
    requests.push({ method, params });
    if (method === "thread/fork") { nativeCalls++; await new Promise(r => setTimeout(r, 10)); return { thread: { ...source, id: "child", turns: source.turns.slice(0, params.lastTurnId ? 1 : 2) } }; }
    if (method === "thread/name/set") return {};
    return { thread: { ...source, id: params.threadId } };
  };
  const input = { threadId: "source", forkRequestId: randomUUID(), lastTurnId: "t1" };
  const [a, b] = await Promise.all([forks.fork("codex", input, request, () => false), forks.fork("codex", input, request, () => false)]);
  assert.equal(nativeCalls, 1);
  assert.equal(a.thread.id, b.thread.id);
  assert.equal(a.thread.forkedFromId, "source");
  assert.equal(a.thread.forkedAtTurnId, "t1");
  assert.equal(a.thread.turns.length, 1);
  assert.equal(requests.find(r => r.method === "thread/fork").params.deferGoalContinuation, true);
  forks.close(); forks = new SessionForks(file);
  await forks.fork("codex", input, request, () => true);
  assert.equal(nativeCalls, 1, "Completed forks are recoverable even if the parent is now busy");
  const recoveredList = await forks.list("codex", {}, { data: [] }, request);
  assert.equal(recoveredList.data[0].id, "child", "Idle forks remain listed before their first new message");
  assert.equal(recoveredList.data[0].forkedFromId, "source");
  forks.archived("codex", "source", true);
  assert.equal((await forks.list("codex", {}, { data: [] }, request)).data.length, 1, "Archiving parent does not archive child");
  forks.archived("codex", "child", true);
  assert.equal((await forks.list("codex", {}, { data: [] }, request)).data.length, 0);
  forks.archived("codex", "child", false);
  await assert.rejects(forks.fork("codex", { ...input, threadId: "different" }, request, () => false), /different source/);
  await assert.rejects(forks.fork("cursor", { ...input, forkRequestId: randomUUID() }, request, () => false), /Historical/);
  await assert.rejects(forks.fork("codex", { ...input, forkRequestId: randomUUID() }, request, () => true), /tasks/);
  await assert.rejects(forks.fork("codex", { ...input, forkRequestId: randomUUID(), lastTurnId: "missing" }, request, () => false), /completed turn/);
  source.status.type = "waiting_for_input";
  await assert.rejects(forks.fork("codex", { threadId: "source", forkRequestId: randomUUID() }, request, () => false), /active session/);
  source.status.type = "idle";
  source.turns[0].status = "inProgress";
  await assert.rejects(forks.fork("codex", { ...input, forkRequestId: randomUUID() }, request, () => false), /completed turn/);
  source.turns[0].status = "completed";
  const retained = source.turns.splice(0);
  await assert.rejects(forks.fork("codex", { threadId: "source", forkRequestId: randomUUID() }, request, () => false), /empty/);
  source.turns.push(...retained);
  const retryInput = { threadId: "source", forkRequestId: randomUUID() };
  let attempts = 0;
  const recoverableRequest = async (provider: any, method: string, params: any) => {
    if (method !== "thread/fork") return request(provider, method, params);
    if (++attempts === 1) throw Object.assign(new Error("Snapshot changed and was cleaned"), { forkSafeToRetry: true });
    return { thread: { ...source, id: "recovered-child" } };
  };
  await assert.rejects(forks.fork("cursor", retryInput, recoverableRequest, () => false), /Snapshot changed/);
  assert.equal((await forks.fork("cursor", retryInput, recoverableRequest, () => false)).thread.id, "recovered-child");
  assert.equal(attempts, 2);
  const rollout = path.join(root, "source-rollout.jsonl");
  await writeFile(rollout, "original\n");
  const archived: string[] = [];
  const changingCodex = async (_provider: any, method: string, params: any) => {
    if (method === "thread/read") return { thread: { ...source, path: rollout } };
    if (method === "thread/fork") { await writeFile(rollout, "original\nexternal turn\n"); return { thread: { id: "discard-only-this-child" } }; }
    if (method === "thread/archive") { archived.push(params.threadId); return {}; }
    return {};
  };
  await assert.rejects(forks.fork("codex", { threadId: "source", forkRequestId: randomUUID() }, changingCodex, () => false), /source changed/);
  assert.deepEqual(archived, ["discard-only-this-child"]);
  const events: string[] = [];
  await Promise.all([
    forks.locks.run("codex:source", async () => { events.push("fork"); await new Promise(r => setTimeout(r, 15)); events.push("saved"); }),
    forks.locks.run("codex:source", () => { events.push("start"); })
  ]);
  assert.deepEqual(events, ["fork", "saved", "start"]);
  forks.close();

  // Native SQLite snapshot includes committed WAL records and excludes run identity.
  const chats = path.join(root, "cursor-chats"), sourceId = randomUUID();
  await mkdir(path.join(chats, sourceId), { recursive: true });
  const db = new DatabaseSync(path.join(chats, sourceId, "store.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=1; CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT)");
  const blob = Buffer.from("retained context"), blobId = createHash("sha256").update(blob).digest("hex");
  const meta = { agentId: sourceId, latestRootBlobId: blobId, name: "Original", createdAt: 1, mode: "plan", isRunEverything: false, subagentInfo: { parentAgentId: "do-not-copy" }, blobEncryptionKey: "a".repeat(64), lastUsedModel: "test-model" };
  db.prepare("INSERT INTO blobs VALUES (?,?)").run(blobId, blob);
  db.prepare("INSERT INTO meta VALUES ('0',?)").run(encodeCursorMetadata(meta));
  const child = await forkCursorStore({ root: chats, cwd: root, sourceId, title: "Branch", version: CURSOR_FORK_VERSION });
  const copied = new DatabaseSync(path.join(child.directory, "store.db"), { readOnly: true });
  const childMeta = decodeCursorMetadata((copied.prepare("SELECT value FROM meta").get() as any).value);
  assert.equal(childMeta.agentId, child.id);
  assert.equal(childMeta.latestRootBlobId, blobId);
  assert.equal(childMeta.mode, "plan");
  assert.equal(childMeta.subagentInfo, undefined);
  assert.notEqual(childMeta.blobEncryptionKey, meta.blobEncryptionKey);
  assert.deepEqual(Buffer.from((copied.prepare("SELECT data FROM blobs").get() as any).data), blob);
  db.prepare("INSERT INTO blobs VALUES (?,?)").run("b".repeat(64), Buffer.from("parent later"));
  assert.equal((copied.prepare("SELECT count(*) AS n FROM blobs").get() as any).n, 1);
  assert.equal(decodeCursorMetadata((db.prepare("SELECT value FROM meta").get() as any).value).agentId, sourceId);
  copied.close();
  await assert.rejects(forkCursorStore({ root: chats, cwd: root, sourceId, title: "Bad", version: "unknown" }), /compatible CLI/);
  for (let index = 0; index < 260; index++) db.prepare("INSERT INTO blobs VALUES (?,?)").run(`extra-${index}`, blob);
  const watcher = watch(chats, (_event, file) => {
    if (file?.startsWith(".fork-")) {
      watcher.close();
      db.prepare("INSERT INTO blobs VALUES (?,?)").run("external-write", blob);
    }
  });
  const raced = forkCursorStore({ root: chats, cwd: root, sourceId, title: "Raced", version: CURSOR_FORK_VERSION });
  await assert.rejects(raced, /source changed/);
  watcher.close();
  db.prepare("INSERT INTO blobs VALUES (?,NULL)").run("corrupt-blob");
  await assert.rejects(forkCursorStore({ root: chats, cwd: root, sourceId, title: "Bad blob", version: CURSOR_FORK_VERSION }), /missing blob/);
  db.prepare("UPDATE meta SET value='broken'").run();
  await assert.rejects(forkCursorStore({ root: chats, cwd: root, sourceId, title: "Bad", version: CURSOR_FORK_VERSION }), /metadata/);
  assert.ok(!(await readdir(chats)).some(name => name.startsWith(".fork-")));
  db.close();

  // Use the real SDK with an isolated Claude config directory and synthetic history.
  const configDir = path.join(root, "claude-config");
  const provider = new ClaudeProvider({ configDir, stateDir: path.join(root, "claude-state") });
  const started = await provider.handle("thread/start", { cwd: root, model: "test-model", mode: "plan", effort: "low" }) as any;
  const parentId = started.thread.id;
  const dir = path.join(configDir, "projects", projectSlug(root));
  await mkdir(dir, { recursive: true });
  const u = randomUUID(), assistant = randomUUID();
  const original = [
    { type: "user", uuid: u, parentUuid: null, sessionId: parentId, cwd: root, timestamp: new Date().toISOString(), message: { role: "user", content: "Remember apricot" } },
    { type: "assistant", uuid: assistant, parentUuid: u, sessionId: parentId, cwd: root, timestamp: new Date().toISOString(), message: { id: "msg-test", role: "assistant", type: "message", content: [{ type: "text", text: "apricot" }], model: "test-model", stop_reason: "end_turn" } }
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(path.join(dir, `${parentId}.jsonl`), original);
  const fork = await provider.handle("thread/fork", { threadId: parentId, title: "Branch" }) as any;
  assert.notEqual(fork.thread.id, parentId);
  assert.equal(fork.thread.turns.length, 1);
  assert.equal(fork.thread.runtime.model, "test-model");
  assert.equal(fork.thread.runtime.mode, "plan");
  const cloned = await readFile(path.join(dir, `${fork.thread.id}.jsonl`), "utf8");
  assert.ok(cloned.includes("apricot"));
  const clonedMessages = cloned.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.type === "user" || row.type === "assistant");
  assert.ok(clonedMessages.every(row => row.uuid !== u && row.uuid !== assistant && row.parentUuid !== u), "SDK remaps message links while retaining provenance");
  assert.equal(await readFile(path.join(dir, `${parentId}.jsonl`), "utf8"), original);
  const restored = new ClaudeProvider({ configDir, stateDir: path.join(root, "claude-state") });
  assert.equal(((await restored.handle("thread/read", { threadId: fork.thread.id })) as any).thread.turns.length, 1);

  // Turn fork: keep turn 1 through its tool round trip and final answer, drop turn 2.
  const [toolCall, toolResult, final, u2, a2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const at = new Date().toISOString(), base = { sessionId: parentId, cwd: root, timestamp: at };
  const twoTurns = original + [
    { ...base, type: "assistant", uuid: toolCall, parentUuid: assistant, message: { id: "msg-tool", role: "assistant", type: "message", content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }], model: "test-model" } },
    { ...base, type: "user", uuid: toolResult, parentUuid: toolCall, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "file.txt" }] } },
    { ...base, type: "assistant", uuid: final, parentUuid: toolResult, message: { id: "msg-final", role: "assistant", type: "message", content: [{ type: "text", text: "listed" }], model: "test-model", stop_reason: "end_turn" } },
    { ...base, type: "user", uuid: u2, parentUuid: final, message: { role: "user", content: "Now banana" } },
    { ...base, type: "assistant", uuid: a2, parentUuid: u2, message: { id: "msg-2", role: "assistant", type: "message", content: [{ type: "text", text: "banana" }], model: "test-model", stop_reason: "end_turn" } }
  ].map(row => JSON.stringify(row)).join("\n") + "\n";
  await writeFile(path.join(dir, `${parentId}.jsonl`), twoTurns);
  assert.equal(claudeTurnCutoff(twoTurns, u), final, "a turn ends at its last entry, past tool results");
  assert.equal(claudeTurnCutoff(twoTurns, u2), a2);
  assert.throws(() => claudeTurnCutoff(twoTurns, toolResult), /completed turn/);
  const turnFork = await provider.handle("thread/fork", { threadId: parentId, title: "Turn branch", lastTurnId: u }) as any;
  assert.equal(turnFork.thread.turns.length, 1);
  const turnClone = await readFile(path.join(dir, `${turnFork.thread.id}.jsonl`), "utf8");
  assert.ok(turnClone.includes("listed") && !turnClone.includes("banana"));

  // The browser may name a Claude turn by its console run ID; the route maps it back.
  let claudeForkParams: any = null;
  const claudeRequest = async (_provider: any, method: string, params: any): Promise<any> => {
    if (method === "thread/fork") { claudeForkParams = params; return { thread: { id: "claude-child" } }; }
    return { thread: { id: parentId, status: "idle", turns: [
      { id: u, status: "completed", startedAt: 100, items: [{ type: "userMessage", content: [{ type: "text", text: "Remember apricot" }] }] },
      { id: u2, status: "completed", startedAt: 200, items: [{ type: "userMessage", content: [{ type: "text", text: "Now banana" }] }] }
    ] } };
  };
  const claudeForks = new SessionForks(path.join(root, "claude-forks.sqlite"));
  const run = { runId: "run-2", text: "Now banana", createdAt: 199, updatedAt: 210, status: "completed" as const, timings: {} };
  await claudeForks.fork("claude", { threadId: parentId, forkRequestId: randomUUID(), lastTurnId: "run-2" }, claudeRequest, () => false, () => [run]);
  assert.equal(claudeForkParams.lastTurnId, u2);
  await assert.rejects(claudeForks.fork("claude", { threadId: parentId, forkRequestId: randomUUID(), lastTurnId: "run-unknown" }, claudeRequest, () => false), /completed turn/);
  claudeForks.close();

  const thread = (id: string, parent?: string) => normalizeThread({ id, provider: "codex", forkedFromId: parent, name: id, preview: id, cwd: root, updatedAt: 0, status: { type: "idle" }, turns: [] } as Thread);
  assert.deepEqual(orderBranchThreads([thread("c", "p"), thread("p")], new Set()).map(t => t.nativeId), ["p", "c"]);
  assert.deepEqual(orderBranchThreads([thread("c", "p"), thread("p")], new Set(["codex:p"])).map(t => t.nativeId), ["p"]);
  assert.equal(orderBranchThreads([thread("c", "archived")], new Set()).length, 1);
  for (const provider of ["codex", "cursor", "claude"] as const) assert.equal(slashCommandDisabledReason(findSlashCommand("/fork")!, { provider, hasThread: true, activeTurn: false, supportsFork: true }), "");
  console.log("Session fork tests passed: idempotency/restart, source/turn guards, locks, Cursor WAL/native metadata, real Claude SDK, branch tree.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
