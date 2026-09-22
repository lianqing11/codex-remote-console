import assert from "node:assert/strict";
import {
  activeAtQuery,
  chipLabel,
  chipOverLimit,
  expandFileContext,
  parseAtMentions,
  shouldInlineChip,
  sliceFileLines,
  upsertChip,
  type FileContextChip
} from "../app/fileContext";

const lines = (count: number) => Array.from({ length: count }, (_, index) => `line-${index + 1}`).join("\n");

function chip(partial: Partial<FileContextChip> & { path: string }): FileContextChip {
  return {
    id: `file-ctx:${partial.path}`,
    startLine: null,
    endLine: null,
    text: "",
    ...partial
  };
}

assert.equal(sliceFileLines("a\nb\nc\nd", 2, 3), "b\nc");
assert.equal(activeAtQuery("see @src/f", 10)?.query, "src/f");
assert.equal(activeAtQuery("/mention", 8), null);

assert.deepEqual(parseAtMentions("see @src/foo.ts:12-40 and @README.md"), [
  { path: "src/foo.ts", startLine: 12, endLine: 40 },
  { path: "README.md", startLine: null, endLine: null }
]);
assert.equal(parseAtMentions("email me@host.com").length, 0);
assert.equal(parseAtMentions("search @md").length, 0);
assert.equal(parseAtMentions("see @README.md").length, 1);
assert.equal(activeAtQuery("please check @package.json:1-8", "please check @package.json:1-8".length), null);
assert.equal(activeAtQuery("please check @package.json", "please check @package.json".length)?.query, "package.json");

const first = upsertChip([], { path: "a.ts", startLine: 1, endLine: 3, text: "a\nb\nc" });
const second = upsertChip(first, { path: "a.ts", startLine: 10, endLine: 12, text: "x\ny\nz" });
assert.equal(second.length, 1);
assert.equal(chipLabel(second[0]), "a.ts:10-12");

const huge = chip({ path: "big.ts", startLine: 1, endLine: 240, text: lines(240) });
assert.equal(chipOverLimit(huge), true);
assert.equal(shouldInlineChip(huge, [huge]), false);

const small = chip({ path: "src/foo.ts", startLine: 12, endLine: 14, text: "a\nb\nc" });
const expanded = expandFileContext("Look at this bug", [small]);
assert.match(expanded, /Look at this bug/);
assert.match(expanded, /@src\/foo\.ts/);
assert.match(expanded, /```12:14:src\/foo\.ts\na\nb\nc\n```/);

const skipped = expandFileContext("fix @big.ts please", [huge]);
assert.match(skipped, /@big\.ts:1-240/);
assert.equal(skipped.includes("```"), false);

const many = Array.from({ length: 5 }, (_, index) =>
  chip({ path: `f${index}.ts`, startLine: 1, endLine: 180, text: lines(180) })
);
assert.equal(shouldInlineChip(many[0], many), true);
assert.equal(shouldInlineChip(many[4], many), false);

console.log("file context tests passed");
