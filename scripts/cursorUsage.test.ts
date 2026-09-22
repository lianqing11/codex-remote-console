import assert from "node:assert/strict";
import {
  formatCursorUsd,
  formatCursorUsageLabel,
  formatCursorUsageTitle,
  formatCursorUsedPercent,
  parseCursorUsage
} from "../app/cursorUsage";
import { formatCodexResetFull, formatCodexResetShort } from "../app/codexUsage";
import { fetchCursorUsage } from "../server/cursorUsage";

const dashboard = {
  billingCycleStart: "1789483625000",
  billingCycleEnd: "1792075625000",
  planUsage: {
    totalSpend: 8547,
    includedSpend: 7000,
    bonusSpend: 1547,
    limit: 7000,
    remainingBonus: false,
    autoPercentUsed: 9.930833333333332,
    apiPercentUsed: 1.4000000000000001,
    totalPercentUsed: 9.556972111553785
  },
  displayMessage: "You've hit your usage limit",
  autoModelSelectedDisplayMessage: "You've used 10% of your included total usage",
  namedModelSelectedDisplayMessage: "You've used 1% of your included API usage"
};

const plan = {
  planInfo: {
    planName: "Pro+",
    includedAmountCents: 7000,
    price: "$60/mo",
    billingCycleEnd: "1792075625000"
  }
};

const exhausted = parseCursorUsage(dashboard, plan);
assert.deepEqual(exhausted, {
  planName: "Pro+",
  remainingCents: 0,
  includedSpendCents: 7000,
  limitCents: 7000,
  bonusSpendCents: 1547,
  usedPercent: 100,
  resetsAt: 1_792_075_625,
  displayMessage: "You've hit your usage limit",
  cursorModels: {
    usedPercent: 9.930833333333332,
    message: "You've used 10% of your included total usage"
  },
  otherModels: {
    usedPercent: 1.4000000000000001,
    message: "You've used 1% of your included API usage"
  }
});
assert.equal(formatCursorUsedPercent(exhausted!.cursorModels.usedPercent), "10");
assert.equal(formatCursorUsedPercent(exhausted!.otherModels.usedPercent), "1");
assert.equal(formatCursorUsageLabel(exhausted!), "Models 10% used · API 1% used");
assert.equal(formatCursorUsd(0), "$0");
assert.equal(formatCursorUsd(7000), "$70");
assert.equal(formatCursorUsd(1547), "$15.47");
assert.equal(formatCodexResetShort(exhausted!.resetsAt), "Oct 15, 14:47 UTC");
assert.equal(formatCodexResetFull(exhausted!.resetsAt), "2026-10-15 14:47:05 UTC");
assert.match(formatCursorUsageTitle(exhausted!), /Pro\+/);
assert.match(formatCursorUsageTitle(exhausted!), /Models 10% used · API 1% used/);
assert.match(formatCursorUsageTitle(exhausted!), /included API usage/);

const remainingExplicit = parseCursorUsage({
  billingCycleEnd: "2026-10-15T14:47:05.000Z",
  planUsage: { includedSpend: 3500, limit: 7000, remaining: 3500 }
});
assert.equal(remainingExplicit?.remainingCents, 3500);
assert.equal(remainingExplicit?.usedPercent, 50);

assert.deepEqual(
  parseCursorUsage({
    remainingCents: 1_200,
    includedSpendCents: 5_800,
    limitCents: 7_000,
    bonusSpendCents: 0,
    usedPercent: 82.857,
    resetsAt: 1_792_075_625,
    planName: "Pro+"
  }),
  {
    planName: "Pro+",
    remainingCents: 1_200,
    includedSpendCents: 5_800,
    limitCents: 7_000,
    bonusSpendCents: 0,
    usedPercent: 82.857,
    resetsAt: 1_792_075_625,
    displayMessage: null,
    cursorModels: { usedPercent: 82.857, message: null },
    otherModels: { usedPercent: 0, message: null }
  }
);

assert.equal(parseCursorUsage({ planUsage: { includedSpend: 10 } }), null);
assert.equal(parseCursorUsage({ planUsage: { limit: 7000, includedSpend: 10 } }), null);

async function main() {
  const fetched = await fetchCursorUsage({
    request: async (url) => {
      if (url.includes("GetPlanInfo")) return plan;
      if (url.includes("GetCurrentPeriodUsage")) return dashboard;
      throw new Error(url);
    }
  });
  assert.deepEqual(fetched, exhausted);

  await assert.rejects(
    () => fetchCursorUsage({
      request: async () => ({ planUsage: { limit: 7000 } })
    }),
    /empty/
  );

  if (process.env.CURSOR_USAGE_LIVE) {
    const live = await fetchCursorUsage();
    assert.ok(live.limitCents > 0);
    console.log(`live ${live.planName} remaining=${live.remainingCents} limit=${live.limitCents}`);
  }
}

main().then(() => {
  console.log("Cursor usage helpers passed");
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
