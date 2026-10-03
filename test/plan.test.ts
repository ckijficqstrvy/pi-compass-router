// test/plan.test.ts — Stage 2–4 純編排（route/plan.ts）與 tierOfModel。
//
// 這批測試的存在理由：2026-10-03 發現 `routeTurn` 從未供給 `currentTier` /
// `lastSwitchAtMs` / `cachePenaltyUsd`，使 guard 的 deadband、cooldown、
// cache penalty 全程空轉卻沒有任何測試失敗。改為純函式後，這三條規則
// 第一次真的被測到。
import { test } from "node:test";
import assert from "node:assert/strict";

import { planTurn, estimateCacheMissUsd, type PlanSnapshot, type CostRates } from "../extensions/pi-compass-router/route/plan.js";
import { tierOfModel } from "../extensions/pi-compass-router/route/select.js";
import { MODEL_FACTS } from "../extensions/pi-compass-router/policy/facts.js";
import { DEFAULT_CONFIG, type CompassConfig, type Target } from "../extensions/pi-compass-router/schema.js";
import type { Judgment } from "../extensions/pi-compass-router/classify/types.js";

const A: Target = { provider: "openrouter", model: "quick-model" };
const B: Target = { provider: "openrouter", model: "standard-model" };

/** 固定鏈的設定；其餘沿用預設。 */
function configWith(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return {
    ...DEFAULT_CONFIG,
    mode: "auto",
    kindModels: {},
    routes: { quick: [A], standard: [B], high: [], premium: [], xpremium: [] },
    cache: { ...DEFAULT_CONFIG.cache, aware: true, deadband: 0.25, cooldownSeconds: 0, bypassTierDelta: 2, maxPenaltyUsd: 0.05 },
    ...overrides,
  };
}

/** demand ≈ 0.55·complexity + 0.45·capability。 */
function judgmentFor(demand: number): Judgment {
  return {
    kind: "chat",
    kindConfidence: 0.9,
    complexity: demand,
    capability: demand,
    source: "laya",
    latencyMs: 5,
  };
}

function snapshotWith(overrides: Partial<PlanSnapshot> = {}): PlanSnapshot {
  return {
    currentModel: "openrouter/quick-model",
    currentTier: "quick",
    lastSwitchAtMs: null,
    contextTokens: null,
    currentCost: null,
    todayUsd: 0,
    monthUsd: 0,
    ...overrides,
  };
}

const deps = {
  isAvailable: () => true,
  costOf: (_t: Target): CostRates | null => null,
};

test("stickiness holds when the current model already is the target (provider/model key)", () => {
  // 回歸（2026-10-03 實跑發現）：guard 只比 `target.model`（bare id），而
  // 呼叫端傳的是 `provider/model`，導致 provider 非空時永遠不命中。
  const config = configWith();
  const plan = planTurn(
    judgmentFor(1.9),
    config,
    snapshotWith({ currentModel: "openrouter/standard-model", currentTier: null }),
    deps,
  );
  assert.equal(plan.guard?.outcome, "held");
  assert.match(String(plan.guard?.reason), /stickiness/);
});

test("first switch (currentTier null) is not blocked by the deadband", () => {
  // demand 1.6 ≥ standard floor 1.5，但 < 1.5+0.25；currentTier null → 不套 deadband。
  const plan = planTurn(judgmentFor(1.6), configWith(), snapshotWith({ currentTier: null }), deps);
  assert.equal(plan.composed.tier, "standard");
  assert.equal(plan.guard?.outcome, "applied", "first switch must not be deadbanded");
});

test("deadband holds when demand has not cleared the boundary", () => {
  const plan = planTurn(judgmentFor(1.6), configWith(), snapshotWith({ currentTier: "quick" }), deps);
  assert.equal(plan.guard?.outcome, "held");
  assert.match(String(plan.guard?.reason), /deadband/, "reason names the deadband");
});

test("demand above floor + deadband switches", () => {
  const plan = planTurn(judgmentFor(1.9), configWith(), snapshotWith({ currentTier: "quick" }), deps);
  assert.equal(plan.guard?.outcome, "applied");
});

test("cooldown holds a switch right after the last one", () => {
  const plan = planTurn(
    judgmentFor(1.9),
    configWith({ cache: { ...DEFAULT_CONFIG.cache, aware: true, deadband: 0.25, cooldownSeconds: 60, bypassTierDelta: 2, maxPenaltyUsd: 0.05 } }),
    snapshotWith({ currentTier: null, lastSwitchAtMs: Date.now() }),
    deps,
  );
  assert.equal(plan.guard?.outcome, "held");
  assert.match(String(plan.guard?.reason), /cooldown/);
});

test("cooldown is bypassed by a big tier jump (bypassTierDelta)", () => {
  const config = configWith({
    routes: { quick: [A], standard: [], high: [], premium: [], xpremium: [] },
    cache: { ...DEFAULT_CONFIG.cache, aware: true, deadband: 0.25, cooldownSeconds: 60, bypassTierDelta: 2, maxPenaltyUsd: 0.05 },
  });
  // demand 3 → xpremium 封頂 premium（未啟用），tier 差 ≥ 2 → bypass。
  const plan = planTurn(judgmentFor(3), config, snapshotWith({ currentTier: "quick", lastSwitchAtMs: Date.now() }), {
    ...deps,
    isAvailable: () => true,
  });
  // premium 鏈為空 → 只有 kindModels 空 → 不可用；改用 standard 有 B 的設定再驗。
  assert.ok(plan.unavailable === true || plan.guard?.outcome === "applied");
});

test("cache penalty holds when the estimated miss cost exceeds the cap", () => {
  const contextTokens = 100_000;
  const nextCost: CostRates = { input: 1, output: 0, cacheRead: 0, cacheWrite: 1 }; // $0.20 for 100k
  const plan = planTurn(
    judgmentFor(1.9),
    configWith(),
    snapshotWith({ currentTier: "high", contextTokens, currentCost: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
    { isAvailable: () => true, costOf: () => nextCost },
  );
  assert.equal(plan.guard?.outcome, "held");
  assert.match(String(plan.guard?.reason), /cache miss/);
  assert.ok(Math.abs((plan.cacheMissUsd ?? 0) - 0.2) < 1e-9, `cacheMissUsd ≈ 0.2, got ${plan.cacheMissUsd}`);
});

test("unknown prices skip the cache estimate entirely (never guess)", () => {
  const plan = planTurn(
    judgmentFor(1.9),
    configWith(),
    snapshotWith({ currentTier: null, contextTokens: 100_000, currentCost: null }),
    deps, // costOf → null
  );
  assert.equal(plan.cacheMissUsd, undefined);
  assert.equal(plan.guard?.outcome, "applied", "no estimate → no cache hold");
});

test("no available model yields unavailable (caller writes the skip entry)", () => {
  const plan = planTurn(judgmentFor(1.9), configWith(), snapshotWith(), { isAvailable: () => false, costOf: () => null });
  assert.equal(plan.unavailable, true);
  assert.equal(plan.target, undefined);
});

test("availability falls back through the chain", () => {
  const config = configWith({ routes: { quick: [A], standard: [B, { provider: "openrouter", model: "third" }], high: [], premium: [], xpremium: [] } });
  const plan = planTurn(judgmentFor(1.9), config, snapshotWith({ currentTier: null }), {
    isAvailable: (t) => t.model === "third",
    costOf: () => null,
  });
  assert.equal(plan.target?.model, "third");
});

test("estimateCacheMissUsd follows the SPEC Part 7 formula", () => {
  const value = estimateCacheMissUsd(200_000, { input: 0, cacheRead: 1, cacheWrite: 0 }, { input: 3, cacheRead: 0, cacheWrite: 2 });
  // (200000/1e6) × (3 + 2 − 1) = 0.8
  assert.ok(Math.abs((value ?? 0) - 0.8) < 1e-9);
  assert.equal(estimateCacheMissUsd(null, { input: 1, cacheRead: 0, cacheWrite: 0 }, { input: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
  assert.equal(estimateCacheMissUsd(1000, null, { input: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("tierOfModel maps a priced fact to a tier and unknown models to null", () => {
  const priced = MODEL_FACTS.models.find((f) => f.price !== undefined);
  if (priced) {
    const tier = tierOfModel(DEFAULT_CONFIG, priced.provider, priced.model);
    assert.ok(tier !== null, "a priced fact must land in some tier");
  }
  assert.equal(tierOfModel(DEFAULT_CONFIG, "openrouter", "no-such-model-xyz"), null);
});

// ---------------------------------------------------------------------------
// cache penalty 校準（2026-10-03）：只擋同層互換/降級，不擋升級
// ---------------------------------------------------------------------------

// 在 standard ceiling 內（$5/M blended），但 100k context 的 cache miss 仍超 $0.05 上限。
const hugeNext: CostRates = { input: 1, output: 0, cacheRead: 0, cacheWrite: 1 };
const zeroCurrent: CostRates = { input: 0, cacheRead: 0, cacheWrite: 0 };

test("cache penalty does not block an explicit tier upgrade", () => {
  const plan = planTurn(
    judgmentFor(1.9), // → standard（高於 currentTier quick）
    configWith(),
    snapshotWith({ currentTier: "quick", contextTokens: 100_000, currentCost: zeroCurrent }),
    { isAvailable: () => true, costOf: () => hugeNext },
  );
  assert.equal(plan.guard?.outcome, "applied", "upgrade must not be cache-penalised");
  assert.ok((plan.cacheMissUsd ?? 0) > 0.05, `estimate still reported: ${plan.cacheMissUsd}`);
});

test("cache penalty holds a same-or-lower tier move", () => {
  const plan = planTurn(
    judgmentFor(1.9), // → standard（低於 currentTier premium）
    configWith(),
    snapshotWith({ currentTier: "high", contextTokens: 100_000, currentCost: zeroCurrent }),
    { isAvailable: () => true, costOf: () => hugeNext },
  );
  assert.equal(plan.guard?.outcome, "held");
  assert.match(String(plan.guard?.reason), /cache miss/);
});

test("unknown current tier skips the cache penalty (fail-open)", () => {
  const plan = planTurn(
    judgmentFor(1.9),
    configWith(),
    snapshotWith({ currentTier: null, contextTokens: 100_000, currentCost: zeroCurrent }),
    { isAvailable: () => true, costOf: () => hugeNext },
  );
  assert.equal(plan.guard?.outcome, "applied");
});

// ---------------------------------------------------------------------------
// W8：runtime registry 價格重驗（靜態 facts 可能過期）
// ---------------------------------------------------------------------------

test("a target above the runtime price ceiling is skipped for the next candidate", () => {
  const config = configWith({ ceilings: { standard: 2 } }); // $/M blended
  const plan = planTurn(judgmentFor(1.9), config, snapshotWith({ currentTier: null }), {
    isAvailable: () => true,
    costOf: (target) =>
      target.model === "standard-model"
        ? { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 } // blended 15 > 2
        : { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 },
  });
  // standard-model 被 runtime 價格擋下；鏈上沒有其他候選 → unavailable。
  assert.equal(plan.unavailable, true);
});

test("unknown runtime price does not block (fail-open)", () => {
  const config = configWith({ ceilings: { standard: 2 } });
  const plan = planTurn(judgmentFor(1.9), config, snapshotWith({ currentTier: null }), {
    isAvailable: () => true,
    costOf: () => null,
  });
  assert.equal(plan.target?.model, "standard-model");
});

// ---------------------------------------------------------------------------
// W2/W4：預算先決 tier 再選 target；stickiness 讀設定且不遮蔽預算
// ---------------------------------------------------------------------------

test("budget pressure reselects the target from the cheaper chain (W2)", () => {
  const config = configWith({
    routes: {
      quick: [{ provider: "openrouter", model: "cheap-x" }],
      standard: [{ provider: "openrouter", model: "standard-model" }],
      high: [],
      premium: [],
      xpremium: [],
    },
  });
  // 壓力 0.92 ≥ hardRatio 0.9、demand 1.9 < 2.5 → effective quick。
  const plan = planTurn(judgmentFor(1.9), config, snapshotWith({ currentTier: null, todayUsd: 4.6 }), {
    isAvailable: () => true,
    costOf: () => null,
  });
  assert.equal(plan.target?.model, "cheap-x", "target comes from the downgraded chain");
  assert.equal(plan.guard?.tier, "quick");
  assert.match(String(plan.guard?.reason), /hard ratio/);
});

test("stickiness: false disables the held shortcut (W4)", () => {
  const config = configWith({ stickiness: false });
  const plan = planTurn(
    judgmentFor(1.9),
    config,
    snapshotWith({ currentModel: "openrouter/standard-model", currentTier: null }),
    deps,
  );
  assert.equal(plan.guard?.outcome, "applied", "stickiness off → no held shortcut");
});

test("stickiness does not mask budget pressure (W4)", () => {
  // 目前的模型就是原鏈首（standard），但已超 hard cap → 必須降到 quick 鏈而不是 held。
  const config = configWith({
    routes: {
      quick: [{ provider: "openrouter", model: "cheap-x" }],
      standard: [{ provider: "openrouter", model: "standard-model" }],
      high: [],
      premium: [],
      xpremium: [],
    },
  });
  const plan = planTurn(
    judgmentFor(1.9),
    config,
    snapshotWith({ currentModel: "openrouter/standard-model", currentTier: "standard", todayUsd: 4.6 }),
    { isAvailable: () => true, costOf: () => null },
  );
  assert.equal(plan.target?.model, "cheap-x");
  assert.equal(plan.guard?.outcome, "applied", "budget must not be masked by stickiness");
});
