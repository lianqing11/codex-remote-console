import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const baseUrl = new URL(process.env.CODING_AGENT_CONSOLE_TEST_URL || "http://127.0.0.1:3032/");
const password = process.env.CODEX_WEB_PASSWORD || process.env.CODEX_WEB_TOKEN || "";

function appUrl(route: string) {
  return new URL(route.replace(/^\/+/, ""), baseUrl);
}

async function bodyJson(response: Response) {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

async function main() {
  const project = await mkdtemp(path.join(tmpdir(), "coding-agent-console-public-project-upload-"));
  try {
    await mkdir(path.join(project, "docs"));
    const login = await fetch(appUrl("api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(password ? { password } : {})
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
    assert.match(cookie, /^coding_agent_console_session=/);

    async function upload(name: string, content: string, directory = "", overwrite = false) {
      const query = new URLSearchParams({
        cwd: project,
        path: directory,
        name,
        overwrite: overwrite ? "1" : "0"
      });
      const response = await fetch(appUrl(`api/projects/upload?${query.toString()}`), {
        method: "POST",
        headers: { cookie, "content-type": "text/plain" },
        body: content
      });
      return { response, body: await bodyJson(response) };
    }

    const root = await upload("root.txt", "root upload\n");
    assert.equal(root.response.status, 201);
    assert.equal(root.body.path, "root.txt");
    assert.equal(await readFile(path.join(project, "root.txt"), "utf8"), "root upload\n");

    const nested = await upload("nested.md", "# Nested\n", "docs");
    assert.equal(nested.response.status, 201);
    assert.equal(nested.body.path, "docs/nested.md");
    assert.equal(await readFile(path.join(project, "docs", "nested.md"), "utf8"), "# Nested\n");

    const conflict = await upload("root.txt", "blocked\n");
    assert.equal(conflict.response.status, 409);
    assert.equal(await readFile(path.join(project, "root.txt"), "utf8"), "root upload\n");

    const replacement = await upload("root.txt", "replacement\n", "", true);
    assert.equal(replacement.response.status, 200);
    assert.equal(replacement.body.overwritten, true);
    assert.equal(await readFile(path.join(project, "root.txt"), "utf8"), "replacement\n");

    const escape = await upload("escape.txt", "blocked\n", "../outside");
    assert.equal(escape.response.status, 400);

    console.log(JSON.stringify({
      url: baseUrl.toString(),
      authenticated: true,
      rootUpload: 201,
      nestedUpload: 201,
      conflictWithoutWrite: 409,
      confirmedReplacement: 200,
      traversalRejected: 400
    }, null, 2));
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
