import assert from "node:assert/strict";
import { projectAssetUrl, resolveProjectReference } from "../app/projectFileUtils";

assert.deepEqual(resolveProjectReference("docs/guide/README.md", "../images/demo.png"), {
  kind: "project",
  path: "docs/images/demo.png",
  hash: ""
});
assert.deepEqual(resolveProjectReference("README.md", "docs/API.md#routes"), {
  kind: "project",
  path: "docs/API.md",
  hash: "#routes"
});
assert.deepEqual(resolveProjectReference("README.md", "#features"), { kind: "anchor", href: "#features" });
assert.deepEqual(resolveProjectReference("README.md", "https://example.com/a"), {
  kind: "external",
  href: "https://example.com/a"
});
assert.equal(resolveProjectReference("README.md", "javascript:alert(1)").kind, "blocked");
assert.equal(resolveProjectReference("README.md", "data:text/html,hello").kind, "blocked");
assert.equal(resolveProjectReference("README.md", "../outside.md").kind, "blocked");

const asset = projectAssetUrl("/codex_web", "/tmp/project", "docs/demo image.png");
assert.match(asset, /^\/codex_web\/api\/projects\/asset\?/);
assert.match(asset, /path=docs%2Fdemo\+image.png/);

console.log("project file UI utils ok");
