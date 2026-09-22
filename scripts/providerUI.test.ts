import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const pageSource = readFileSync("app/page.tsx", "utf8");
const paneSource = readFileSync("app/ConversationPane.tsx", "utf8");
const fleetSource = readFileSync("app/AgentFleet.tsx", "utf8");
const composerSource = readFileSync("app/Composer.tsx", "utf8");
const projectWorkspaceSource = readFileSync("app/ProjectFileWorkspace.tsx", "utf8");
const executionSource = readFileSync("app/ExecutionModeSwitch.tsx", "utf8");
const files = ["app/page.tsx", "app/layout.tsx", "app/slashCommands.ts", "app/cursorAdapter.ts"];
const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
const oldProductName = ["Codex", "Remote", "Console"].join(" ");
const oldStorageNamespace = ["codex", "remote", "console"].join("-") + ".";

assert.equal(source.includes(oldProductName), false);
assert.equal(pageSource.includes(oldStorageNamespace), false);
assert.ok(source.includes("Coding Agent Console"));
assert.ok(source.includes("/provider"));
assert.ok(source.includes("/ask"));
assert.ok(source.includes("agent:request"));
assert.ok(source.includes("session/create"));
assert.ok(source.includes("run/start"));
assert.ok(pageSource.includes("fromBootstrap.available === true"));
assert.ok(pageSource.includes('message.type === "agent:snapshot"'));
assert.equal(pageSource.includes('setWsState(message.status === "connected"'), false);
assert.ok(pageSource.includes("Allowlist · no sandbox"));
assert.ok(pageSource.includes("providerStrip"));
const cssSource = readFileSync("app/globals.css", "utf8");
assert.ok(cssSource.includes(".providerToggle {\n  display: grid;\n  grid-template-columns: repeat(3, minmax(0, 1fr));"));
assert.ok(pageSource.includes("New {providerName(selectedProvider)}"));
assert.ok(paneSource.includes("providerToggle"));
assert.ok(paneSource.includes('role="radiogroup"'));
assert.ok(paneSource.includes("New {option.label}"));
assert.ok(pageSource.includes('aria-label="New session"'));
assert.equal(pageSource.includes("Create Cursor session"), false);
assert.equal(pageSource.includes("className=\"providerMenu\""), false);
assert.equal(pageSource.includes("Sandbox auto-run"), false);
assert.ok(pageSource.includes("Cursor CLI modes are fixed per native session"));
assert.ok(fleetSource.includes("fleetSessionModel"));
assert.ok(fleetSource.includes("fleetSessionFast"));
assert.ok(fleetSource.includes("fastModeLabel(thread.serviceTier)"));
assert.ok(fleetSource.includes("Live work stays here until it finishes"));
assert.ok(fleetSource.includes('label="Queued"'));
assert.ok(pageSource.includes("attentionThreadKeys"));
assert.ok(pageSource.includes("listedThreads"));
assert.ok(pageSource.includes("withImmediateTitle"));
assert.ok(pageSource.includes("beginDraftSession"));
assert.ok(pageSource.includes("topbarRename"));
assert.ok(pageSource.includes("selectedThreadIdRef.current !== tid"));
assert.ok(pageSource.includes('wsState !== "online"'));
assert.ok(pageSource.includes('title={`Thinking effort: ${displayedReasoning || "default"}`}'));
assert.ok(pageSource.includes("fastModeLabel(displayedServiceTier)"));
assert.ok(pageSource.includes('selectedThread && sessionExecutionState.phase !== "idle"'));
assert.equal(pageSource.includes('className="sessionModeMeta"'), false, "composer owns the Session mode display");
assert.equal(pageSource.includes('className="sessionProviderMeta"'), false, "the provider strip owns the Provider display");
assert.ok(pageSource.includes("async function selectSessionMode("));
assert.ok(pageSource.includes("const refreshSessionState = useCallback("));
assert.ok(pageSource.includes("async function executeCurrentPlan()"));
assert.ok(pageSource.includes("commitSessionMode(threadId, runtime.mode)"));
assert.ok(pageSource.includes("commitSessionMode(threadId, turnMode)"));
assert.ok(composerSource.includes("<SessionExecutionControl"));
assert.ok(
  composerSource.indexOf("<SessionExecutionControl") < composerSource.indexOf("{slashOpen ? ("),
  "Session mode must remain the first visible composer region"
);
assert.ok(
  composerSource.indexOf("<SessionExecutionControl") < composerSource.indexOf("{attachments.length ? ("),
  "attachments must render below Session mode"
);
assert.ok(composerSource.includes('aria-label="Attach files to agent"'));
assert.ok(composerSource.includes('"Agent files"'));
assert.ok(projectWorkspaceSource.includes('aria-label="Upload files to project"'));
assert.ok(projectWorkspaceSource.includes('"Upload here"'));
assert.equal(composerSource.includes('accept="image/*"'), false);
assert.ok(composerSource.includes("· On server"));
assert.ok(pageSource.includes('type: "uploadedFile"'));
assert.ok(pageSource.includes("uploadServerFile"));
assert.ok(
  composerSource.indexOf("<SessionExecutionControl") < composerSource.indexOf("{hasThread ? ("),
  "queue status must render below Session mode"
);
assert.equal(pageSource.includes("<SessionExecutionControl"), false, "the shared execution control renders once through Composer");
assert.ok(executionSource.includes("sessionExecutionControl"));
assert.ok(executionSource.includes("Stop planning & execute"));
assert.equal(executionSource.includes("mobileModeSwitch"), false);
assert.equal(fleetSource.includes("onPrefetch"), false);
assert.equal(pageSource.includes("prefetchThreadHistory"), false);
assert.equal(pageSource.includes("scheduleThreadPrefetch"), false);
assert.equal(pageSource.includes("loadThreadHistory"), false);
assert.ok(pageSource.includes('provider === "codex" && hadCache'));
assert.equal(pageSource.includes('message.method === "turn/completed" && selectedThreadIdRef.current === tid'), false);
assert.ok(pageSource.includes("if (!hadCache) setHistoryLoadingThreadId(key)"));
assert.ok(pageSource.includes("onShowAllHistory={onShowAllHistory}"));
assert.ok(pageSource.includes("startProviders={startProviders}"));
assert.ok(pageSource.includes('const providerOrder: ProviderId[] = ["codex", "cursor", "claude"]'));
assert.ok(pageSource.includes("ClaudeUsagePill"));
assert.ok(pageSource.includes("CursorUsagePill"));
assert.ok(pageSource.includes("account/usage/read"));
assert.ok(pageSource.includes("selectedThreadIdRef.current === tid"));
assert.ok(pageSource.includes("if (wsRef.current?.readyState === WebSocket.OPEN) return;"));
assert.equal(pageSource.includes("if (wsRef.current?.readyState === WebSocket.OPEN) refreshLiveState(false)"), false);

console.log("provider UI static checks passed");
