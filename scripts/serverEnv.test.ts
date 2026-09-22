import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const envModule = pathToFileURL(path.join(repoRoot, "server", "loadLocalEnv.ts")).href;
const notifyModule = pathToFileURL(path.join(repoRoot, "server", "feishuNotify.ts")).href;

function childEnvironment() {
  const env = { ...process.env };
  for (const key of [
    "CODEX_WEB_FEISHU_NOTIFY",
    "CODEX_WEB_FEISHU_USER_OPEN_ID",
    "CODEX_WEB_FEISHU_CHUNK_MAX_BYTES",
    "CODEX_WEB_FEISHU_SUMMARY_MAX",
    "CODEX_WEB_FEISHU_STATE_PATH"
  ]) {
    delete env[key];
  }
  return env;
}

function runProbe(cwd: string, existingValue = "parent") {
  const script = `
    (async () => {
      const envModule = await import(${JSON.stringify(envModule)});
      const notifyModule = await import(${JSON.stringify(notifyModule)});
      const envApi = envModule.default || envModule;
      const notifyApi = notifyModule.default || notifyModule;
      const config = notifyApi.loadFeishuNotifyConfig();
      console.log(JSON.stringify({
        loaded: envApi.loadLocalEnv(),
        enabled: config.enabled,
        userOpenId: config.userOpenId,
        chunkMaxBytes: config.chunkMaxBytes,
        statePath: config.statePath,
        existingValue: process.env.ENV_LOAD_EXISTING
      }));
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const result = spawnSync(tsx, ["-e", script], {
    cwd,
    env: { ...childEnvironment(), ENV_LOAD_EXISTING: existingValue },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

async function main() {
  const configured = await mkdtemp(path.join(tmpdir(), "cursor-server-env-"));
  const statePath = path.join(configured, "feishu-state.json");
  await writeFile(
    path.join(configured, ".env.local"),
    [
      "CODEX_WEB_FEISHU_NOTIFY=on",
      "CODEX_WEB_FEISHU_USER_OPEN_ID=ou_test_env_local",
      "CODEX_WEB_FEISHU_CHUNK_MAX_BYTES=321",
      `CODEX_WEB_FEISHU_STATE_PATH=${statePath}`,
      "ENV_LOAD_EXISTING=file"
    ].join("\n") + "\n"
  );

  assert.deepEqual(runProbe(configured), {
    loaded: true,
    enabled: true,
    userOpenId: "ou_test_env_local",
    chunkMaxBytes: 321,
    statePath,
    existingValue: "parent"
  });

  const missing = await mkdtemp(path.join(tmpdir(), "cursor-server-env-missing-"));
  const missingProbe = runProbe(missing);
  assert.equal(missingProbe.loaded, false);
  assert.equal(missingProbe.enabled, false);
  assert.equal(missingProbe.userOpenId, "");
  assert.equal(missingProbe.existingValue, "parent");

  console.log("server env tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
