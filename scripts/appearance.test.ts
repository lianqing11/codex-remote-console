import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { appearanceBootstrapScript, defaultAppearance, parseAppearance } from "../app/appearance";

assert.deepEqual(parseAppearance(null), defaultAppearance);
assert.deepEqual(parseAppearance({ mode: "broken", accent: "<script>", mobileLayout: "unknown" }), defaultAppearance);
assert.deepEqual(parseAppearance({ mode: "system", accent: "purple", mobileLayout: "detailed" }), { mode: "system", accent: "purple", mobileLayout: "detailed" });
for (const dark of [true, false]) {
  const dataset: Record<string, string> = {};
  runInNewContext(appearanceBootstrapScript, {
    document: { documentElement: { dataset } },
    localStorage: { getItem: () => JSON.stringify({ mode: "system", accent: "blue", mobileLayout: "detailed" }) },
    matchMedia: () => ({ matches: dark })
  });
  assert.equal(dataset.theme, dark ? "dark" : "light");
  assert.equal(dataset.accent, "blue");
  assert.equal(dataset.mobileLayout, "detailed");
}
for (const getItem of [() => { throw new Error("storage blocked"); }, () => "{invalid", () => '"string"']) {
  const dataset: Record<string, string> = {};
  runInNewContext(appearanceBootstrapScript, { document: { documentElement: { dataset } }, localStorage: { getItem }, matchMedia: () => ({ matches: false }) });
  assert.deepEqual(dataset, { theme: "light", accent: "green", mobileLayout: "minimal" });
}
console.log("appearance.test.ts: ok");
