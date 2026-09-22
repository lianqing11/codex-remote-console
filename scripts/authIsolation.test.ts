import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const authSource = readFileSync("server/auth.ts", "utf8");
const packageSource = readFileSync("package.json", "utf8");

assert.match(authSource, /const cookieName = "coding_agent_console_session"/);
assert.match(authSource, /const configuredBasePath = process\.env\.NEXT_PUBLIC_BASE_PATH\?\.trim\(\) \|\| ""/);
assert.match(authSource, /const cookiePath = configuredBasePath \? `\$\{configuredBasePath\.replace\(\/\\\/\+\$\/, ""\)\}\/` : "\/"/);
assert.match(authSource, /Path=\$\{cookiePath\}/);
assert.equal(authSource.includes("codex_remote_console"), false);
assert.match(packageSource, /NEXT_PUBLIC_BASE_PATH=\/codex_web_cursor/);

console.log("auth isolation static checks passed");
