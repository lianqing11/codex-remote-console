import assert from "node:assert/strict";
import { autoApprovalForRequest } from "../server/approvalPolicy";

function exec(command: string) {
  return autoApprovalForRequest({
    id: 1,
    method: "execCommandApproval",
    params: { command }
  });
}

assert.equal(exec("ls -la")?.reason, "read-only command");
assert.equal(exec("sed -n '1,10p' README.md")?.reason, "read-only command");
assert.equal(exec("find . -name '*.ts'")?.reason, "read-only command");
assert.equal(exec("sed -i s/a/b/ file.ts"), null);
assert.equal(exec("sed 'w /tmp/out' file.ts"), null);
assert.equal(exec("sed -e '1,5w /tmp/out' file.ts"), null);
assert.equal(exec("find . -fprintf /tmp/out %p"), null);
assert.equal(exec("find . -fprint /tmp/out"), null);
assert.equal(exec("rm -rf /tmp/x"), null);

const mcp = autoApprovalForRequest({
  id: 2,
  method: "mcpServer/elicitation/request",
  params: { serverName: "test" }
});
assert.equal((mcp?.result as { action?: string } | undefined)?.action, "accept");

const previous = process.env.CODEX_WEB_AUTO_APPROVE_MCP;
process.env.CODEX_WEB_AUTO_APPROVE_MCP = "off";
assert.equal(
  autoApprovalForRequest({
    id: 3,
    method: "mcpServer/elicitation/request",
    params: { serverName: "test" }
  }),
  null
);
if (previous === undefined) delete process.env.CODEX_WEB_AUTO_APPROVE_MCP;
else process.env.CODEX_WEB_AUTO_APPROVE_MCP = previous;

console.log("approval policy tests passed");
