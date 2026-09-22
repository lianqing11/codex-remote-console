import assert from "node:assert/strict";
import {
  formatCodexPercent,
  formatCodexResetFull,
  formatCodexResetShort,
  remainingCodexPercent,
  standardCodexRateLimit
} from "../app/codexUsage";

const standard = standardCodexRateLimit({
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 1_786_841_885 }
  },
  rateLimitsByLimitId: {
    codex_bengalfox: {
      limitId: "codex_bengalfox",
      primary: { usedPercent: 91, windowDurationMins: 10_080, resetsAt: 1_786_849_101 }
    },
    codex: {
      limitId: "codex",
      primary: { usedPercent: 4, windowDurationMins: 10_080, resetsAt: 1_786_841_885 }
    }
  }
});

assert.deepEqual(standard, {
  usedPercent: 4,
  windowDurationMins: 10_080,
  resetsAt: 1_786_841_885
});
assert.equal(formatCodexResetShort(standard!.resetsAt), "Aug 16, 00:58 UTC");
assert.equal(formatCodexResetFull(standard!.resetsAt), "2026-08-16 00:58:05 UTC");
assert.equal(remainingCodexPercent(8), 92);
assert.equal(remainingCodexPercent(0), 100);
assert.equal(remainingCodexPercent(100), 0);
assert.equal(formatCodexPercent(remainingCodexPercent(4)), "96");
assert.equal(formatCodexPercent(remainingCodexPercent(4.25)), "95.8");

assert.deepEqual(
  standardCodexRateLimit({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 150, windowDurationMins: 60, resetsAt: 100 }
    }
  }),
  { usedPercent: 100, windowDurationMins: 60, resetsAt: 100 }
);
assert.equal(
  standardCodexRateLimit({
    rateLimits: {
      limitId: "codex_other",
      primary: { usedPercent: 4, windowDurationMins: 60, resetsAt: 100 }
    }
  }),
  null
);
assert.equal(standardCodexRateLimit({ rateLimits: { limitId: "codex", primary: null } }), null);

console.log("Codex usage helpers passed");
