import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMAND_LADDER, TIER_DEMAND_FLOOR, compose } from "../extensions/pi-compass-router/route/compose.js";
import { applyBudget, guard, type GuardRequest, type GuardState } from "../extensions/pi-compass-router/route/guard.js";
import { filterChain, insertPrefer } from "../extensions/pi-compass-router/policy/filter.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig, Target } from "../extensions/pi-compass-router/schema.js";
import type { Judgment } from "../extensions/pi-compass-router/classify/types.js";

function config(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return {
    ...DEFAULT_CONFIG,
    classify: { ...DEFAULT_CONFIG.classify },
    budget: { ...DEFAULT_CONFIG.budget },
    cache: { ...DEFAULT_CONFIG.cache },
    taskKinds: { ...DEFAULT_CONFIG.taskKinds },
    kindMinimumTier: { ...DEFAULT_CONFIG.kindMinimumTier },
    thinking: { ...DEFAULT_CONFIG.thinking },
    xpremium: { ...DEFAULT_CONFIG.xpremium },
    freePool: { ...DEFAULT_CONFIG.freePool },
    ...overrides,
  } as CompassConfig;
}

function judgment(overrides: Partial<Judgment> = {}): Judgment {
  return {
    kind: "chat",
    kindConfidence: 0.9,
    complexity: 0.2,
    capability: 0.2,
    deepReasoning: 0.1,
    thinking: "low",
    latencyMs: 5,
    source: "laya",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — compose
// ---------------------------------------------------------------------------

test("demand uses the 0.55/0.45/0.15 weights and is clamped to 0-3", () => {
  const result = compose(
    judgment({ kind: "operate", kindConfidence: 0.9, complexity: 1.7, capability: 1.55, deepReasoning: 0.82 }),
    config(),
  );
  // operate: floor 0.5 (taskKinds) and tier floor standard (1.5)
  assert.ok(result.demand >= 1.5, `demand ${result.demand} must clear the standard floor`);
  assert.ok(result.demand <= 3, "demand must stay on the 0-3 scale");
});

test("a chat turn lands on quick with light thinking", () => {
  const result = compose(judgment(), config());
  assert.equal(result.tier, "quick");
  assert.equal(result.thinking, "low", "judgment.thinking wins over the ladder");
});

test("TIER_DEMAND_FLOOR and the ladder share thresholds", () => {
  assert.equal(TIER_DEMAND_FLOOR.quick, 0.5);
  assert.equal(TIER_DEMAND_FLOOR.standard, 1.5);
  assert.equal(TIER_DEMAND_FLOOR.high, 2.5);
  assert.equal(TIER_DEMAND_FLOOR.premium, 2.9);
  assert.equal(DEMAND_LADDER[0].below, TIER_DEMAND_FLOOR.quick);
  assert.equal(DEMAND_LADDER[1].below, TIER_DEMAND_FLOOR.standard);
  assert.equal(DEMAND_LADDER[2].below, TIER_DEMAND_FLOOR.high);
  assert.equal(DEMAND_LADDER[3].below, TIER_DEMAND_FLOOR.premium);
});

test("demand exactly at a tier floor reaches that tier, not the one above", () => {
  // plan: kindMinimumTier = high, whose floor is 2.5. Demand must land on
  // 'high', not 'premium' — the floor semantics are ">= to qualify".
  const result = compose(
    judgment({ kind: "plan", kindConfidence: 0.9, complexity: 0, capability: 0, deepReasoning: 0 }),
    config(),
  );
  assert.equal(result.demand, 2.5, "the high floor dominates a zero-demand judgment");
  assert.equal(result.tier, "high", "demand == floor must qualify for that tier");
});

test("kindMinimumTier floor raises a cheap judgment", () => {
  const high = compose(judgment({ kind: "review", kindConfidence: 0.9, complexity: 0, capability: 0 }), config());
  const quick = compose(judgment({ kind: "chat", kindConfidence: 0.9, complexity: 0, capability: 0 }), config());
  assert.equal(high.tier, "high");
  assert.equal(quick.tier, "quick");
  assert.ok(high.demand > quick.demand);
});

test("confidence guard overrides the kind floor and falls back to standard", () => {
  const result = compose(
    judgment({ kind: "plan", kindConfidence: 0.1, complexity: 0, capability: 0 }),
    config(), // confidenceThreshold 0.34, kindMinimumTier.plan = high
  );
  assert.equal(result.tier, "standard", "low confidence must beat the plan >= high floor");
});

test("confidence guard never raises a cheap tier", () => {
  const result = compose(
    judgment({ kind: "chat", kindConfidence: 0.1, complexity: 0, capability: 0 }),
    config(),
  );
  assert.equal(result.tier, "quick", "the guard only downgrades");
});

test("thinking precedence: config pin > judgment > ladder", () => {
  const pinned = compose(
    judgment({ kind: "refactor", thinking: "low" }),
    config({ thinking: { refactor: "max" } }),
  );
  assert.equal(pinned.thinking, "max", "a per-kind pin beats the judgment");

  const globalPin = compose(judgment({ kind: "refactor", thinking: "low" }), config({ thinking: { pin: "off" } }));
  assert.equal(globalPin.thinking, "off");

  const noThinking = compose(
    judgment({ kind: "operate", thinking: undefined, complexity: 2.6, capability: 2.6, deepReasoning: 1 }),
    config(),
  );
  assert.equal(noThinking.thinking, "high", "ladder: demand >= 2.5 and < 2.9 -> high");
});

test("a missing judgment fails open to standard with tier-default thinking", () => {
  const result = compose(undefined, config());
  assert.equal(result.demand, 0);
  assert.equal(result.tier, "standard");
  assert.equal(result.thinking, "low", "TIER_THINKING.standard");
});

test("missing complexity/capability skips the weighted demand but keeps floors", () => {
  const result = compose(
    judgment({ kind: "plan", kindConfidence: 0.9, complexity: undefined, capability: undefined }),
    config(),
  );
  assert.equal(result.demand, 2.5, "only floors apply, no guessed score");
  assert.equal(result.tier, "high");
});

test("xpremium stays capped when disabled", () => {
  const result = compose(
    judgment({ kind: "plan", kindConfidence: 0.99, complexity: 3, capability: 3, deepReasoning: 1 }),
    config(),
  );
  assert.equal(result.tier, "premium", "xpremium.enabled is false by default");
});

test("xpremium is reachable when enabled", () => {
  const result = compose(
    judgment({ kind: "plan", kindConfidence: 0.99, complexity: 3, capability: 3, deepReasoning: 1 }),
    config({ xpremium: { enabled: true } }),
  );
  assert.equal(result.tier, "xpremium");
});

// ---------------------------------------------------------------------------
// L2 policy — deny / allowProviders / prefer
// ---------------------------------------------------------------------------

const targets: Target[] = [
  { provider: "openrouter", model: "anthropic/claude-opus-latest" },
  { provider: "openrouter", model: "xiaomi/mimo-v2.6-flash" },
  { provider: "anthropic", model: "claude-sonnet-4-5" },
];

test("deny removes matching derived entries by full id or bare model", () => {
  const out = filterChain(targets, config({ deny: ["*claude-opus*", "*mimo*"] }));
  assert.deepStrictEqual(
    out.map((t) => t.model),
    ["claude-sonnet-4-5"],
  );
});

test("explicit entries survive their own deny (Part 9 L3, Part 2)", () => {
  const explicit: Target = { provider: "openrouter", model: "anthropic/claude-opus-latest", explicit: true };
  const out = filterChain([explicit, ...targets], config({ deny: ["*claude-opus*"] }));
  assert.ok(out.includes(explicit), "explicit config entries are never filtered");
});

test("allowProviders drops other providers when non-empty", () => {
  const out = filterChain(targets, config({ allowProviders: ["anthropic"] }));
  assert.deepStrictEqual(out.map((t) => t.model), ["claude-sonnet-4-5"]);
});

test("no policy configured leaves the chain untouched", () => {
  assert.strictEqual(filterChain(targets, config()), targets);
});

test("insertPrefer prepends heads, marks them explicit, and dedupes", () => {
  const cfg = config({ prefer: { quick: ["moonshotai/kimi-k3"] } });
  const out = insertPrefer(targets, "quick", cfg);
  // N2：prefer 是**裸 model id**（可含 `/`）——不強拆 provider，交由 resolveModel
  // 以 registry 唯一匹配解析；強拆會把 `xiaomi/...` 拆成不存在的 provider。
  assert.equal(out[0].provider, "");
  assert.equal(out[0].model, "moonshotai/kimi-k3");
  assert.equal(out[0].explicit, true, "prefer heads are explicit");
  assert.equal(out.length, 3 + 1);

  // 同一個真實模型（鏈上為 provider/model，prefer 為裸 id）→ 去重。
  const duped = insertPrefer([{ provider: "moonshotai", model: "kimi-k3" }], "quick", cfg);
  assert.equal(duped.length, 1, "the pre-existing entry is replaced, not duplicated");
});

test("insertPrefer is a no-op for a tier with no preference", () => {
  assert.strictEqual(insertPrefer(targets, "high", config()), targets);
});

test("a prefer head survives a deny that matches it (explicit beats policy)", () => {
  const cfg = config({ prefer: { quick: ["anthropic/claude-opus-latest"] }, deny: ["*claude-opus*"] });
  const out = insertPrefer(filterChain(targets, cfg), "quick", cfg);
  assert.equal(out[0].model, "anthropic/claude-opus-latest", "prefer is injected after filtering and never filtered");
});

// ---------------------------------------------------------------------------
// Stage 4 — guard
// ---------------------------------------------------------------------------

function state(overrides: Partial<GuardState> = {}): GuardState {
  return {
    currentModel: null,
    currentTier: null,
    todayUsd: 0,
    monthUsd: 0,
    lastSwitchAtMs: null,
    ...overrides,
  };
}

function request(tier: GuardRequest["tier"], demand: number, model = "openrouter/target-model"): GuardRequest {
  return { target: { provider: "openrouter", model }, tier, demand };
}

test("guard: stickiness holds when the current model is already the target", () => {
  // fixture 用生產形狀：provider 分開、model 是裸 id（不是整條 key）。
  const result = guard(request("high", 2.8, "m1"), state({ currentModel: "openrouter/m1", currentTier: "high" }), config(), "auto");
  assert.equal(result.outcome, "held");
  assert.equal(result.tier, "high");
  assert.match(String(result.reason), /stickiness/);
});

test("guard: an affordable turn applies unchanged", () => {
  const result = guard(request("high", 2.8), state(), config(), "auto");
  assert.equal(result.outcome, "applied");
  assert.equal(result.tier, "high");
});

test("applyBudget: soft pressure drops exactly one tier", () => {
  // 3.6 / 5 = 0.72 >= softRatio 0.7, below hardRatio 0.9
  const out = applyBudget("high", 2.8, { todayUsd: 3.6, monthUsd: 0 }, config());
  assert.equal(out.tier, "standard");
  assert.equal(out.forced, true);
  assert.match(out.reasons.join(" "), /soft ratio/);
});

test("applyBudget: hard pressure forces quick when demand is low", () => {
  // 4.6 / 5 = 0.92 >= hardRatio 0.9, demand 1.0 < 2.5
  const out = applyBudget("high", 1.0, { todayUsd: 4.6, monthUsd: 0 }, config());
  assert.equal(out.tier, "quick");
  assert.match(out.reasons.join(" "), /hard ratio/);
});

test("applyBudget: hard pressure still allows standard when demand >= 2.5", () => {
  const out = applyBudget("premium", 2.6, { todayUsd: 4.6, monthUsd: 0 }, config());
  assert.equal(out.tier, "standard", "architectural turns may stay at standard (Part 8)");
});

test("applyBudget: hard pressure never raises a tier that was already cheaper", () => {
  const out = applyBudget("quick", 1.0, { todayUsd: 4.6, monthUsd: 0 }, config());
  assert.equal(out.tier, "quick");
  assert.equal(out.forced, false);
});

test("applyBudget: an uncapped budget never downgrades", () => {
  const uncapped = config({ budget: { dailyUsd: null, monthlyUsd: null, softRatio: 0.7, hardRatio: 0.9 } });
  const out = applyBudget("premium", 3, { todayUsd: 1e9, monthUsd: 1e9 }, uncapped);
  assert.equal(out.tier, "premium");
});

test("guard: notify mode reports the suggestion without applying it", () => {
  const result = guard(request("high", 2.8), state(), config(), "notify");
  assert.equal(result.outcome, "notify-only");
  assert.equal(result.tier, "high");
});

test("guard: confirm mode still reaches the caller as applied (Stage 5 asks)", () => {
  const result = guard(request("high", 2.8), state(), config(), "confirm");
  assert.equal(result.outcome, "applied");
});

test("guard: an over-cap cache penalty holds a non-upgrade switch", () => {
  // 2026-10-03 校準：升級不受 cache penalty 限制；同層/降級才擋。
  const result = guard(
    request("standard", 1.6),
    state({ currentTier: "high", cachePenaltyUsd: 0.2 }),
    config(),
    "auto",
  );
  assert.equal(result.outcome, "held");
  assert.equal(result.tier, "high", "held keeps the current tier");
  assert.match(String(result.reason), /cache miss/);
});

test("guard: bypassTierDelta overrides the cache penalty cap", () => {
  const cfg = config({ cache: { ...DEFAULT_CONFIG.cache, bypassTierDelta: 1 } });
  const result = guard(
    request("high", 2.8),
    state({ currentTier: "standard", cachePenaltyUsd: 0.2 }),
    cfg,
    "auto",
  );
  assert.equal(result.outcome, "applied", "a quality-critical jump is exempt from the penalty cap");
});

test("guard: an unknown cache penalty never blocks (fail open)", () => {
  const result = guard(request("high", 2.8), state({ currentTier: "standard" }), config(), "auto");
  assert.equal(result.outcome, "applied");
});

test("guard: deadband holds a marginal upward switch", () => {
  // demand 2.5 < floor(high) 2.5 + deadband 0.25
  const result = guard(request("high", 2.5), state({ currentTier: "standard" }), config(), "auto");
  assert.equal(result.outcome, "held");
  assert.equal(result.tier, "standard", "held keeps the current tier");
  assert.match(String(result.reason), /deadband/);
});

test("guard: deadband does not apply on the session's first switch", () => {
  const result = guard(request("high", 2.5), state({ currentTier: null }), config(), "auto");
  assert.equal(result.outcome, "applied", "nothing flaps yet, so there is nothing to damp");
});

test("guard: cooldown blocks a switch until it expires", () => {
  const cfg = config({ cache: { ...DEFAULT_CONFIG.cache, cooldownSeconds: 300 } });
  const result = guard(
    request("high", 3.0),
    state({ currentTier: "standard", lastSwitchAtMs: Date.now() - 1000 }),
    cfg,
    "auto",
  );
  assert.equal(result.outcome, "held");
  assert.match(String(result.reason), /cooldown/);
});

test("guard: a budget-forced change is exempt from cooldown", () => {
  // W2 後：budget 在 planTurn 決定 tier，guard 只要看到 budgetForced 就讓路。
  const cfg = config({ cache: { ...DEFAULT_CONFIG.cache, cooldownSeconds: 300 } });
  const result = guard(
    request("quick", 1.0),
    state({ currentTier: "standard", lastSwitchAtMs: Date.now() - 1000, budgetForced: true }),
    cfg,
    "auto",
  );
  assert.equal(result.outcome, "applied", "budget-forced changes bypass the cooldown (Part 7)");
  assert.equal(result.tier, "quick");
});

test("guard: a big tier jump is exempt from cooldown", () => {
  const cfg = config({ cache: { ...DEFAULT_CONFIG.cache, cooldownSeconds: 300 } });
  const result = guard(
    request("premium", 3.0),
    state({ currentTier: "quick", lastSwitchAtMs: Date.now() - 1000 }),
    cfg,
    "auto",
  );
  assert.equal(result.outcome, "applied", "delta >= bypassTierDelta is quality-critical");
});

test("guard: a budget-forced downgrade bypasses the deadband", () => {
  // soft 降級 high → standard，delta = 1 < bypassTierDelta 2，故 bypass 不生效；
  // demand 2.4 > floor(high)=2.5 − deadband 0.25 = 2.25，落在死區內。
  // budgetForced 必須讓 deadband 讓路（錢的約束優先）。
  const result = guard(
    request("standard", 2.4),
    state({ currentTier: "high", budgetForced: true }),
    config(),
    "auto",
  );
  assert.equal(result.outcome, "applied", "money constraint beats demand uncertainty");
  assert.equal(result.tier, "standard");
});
// ---------------------------------------------------------------------------
// Stage 5 — apply
// ---------------------------------------------------------------------------

import { applyRoute, type ApplyDecision, type ApplyHooks } from "../extensions/pi-compass-router/route/apply.js";
import type { RouteEntry } from "../extensions/pi-compass-router/ui/entries.js";

function decision(overrides: Partial<ApplyDecision> = {}): ApplyDecision {
  return {
    outcome: "applied",
    target: { provider: "openrouter", model: "m" },
    thinking: "high",
    mode: "auto",
    tier: "high",
    ...overrides,
  };
}

/** 記錄呼叫的 hooks；`failModel` 讓 setModel 拋錯（驗證 fail-open）。 */
function hooks(overrides: Partial<ApplyHooks> & { failModel?: boolean } = {}) {
  const calls: { model?: string; thinking?: string; entries: RouteEntry[] } = { entries: [] };
  const h: ApplyHooks = {
    setModel(target) {
      if (overrides.failModel) throw new Error("boom");
      calls.model = target.provider ? `${target.provider}/${target.model}` : target.model;
    },
    setThinkingLevel(level: string) {
      calls.thinking = level;
    },
    readThinkingLevel: overrides.readThinkingLevel ?? (() => "high"),
    writeEntry: (entry: RouteEntry) => {
      calls.entries.push(entry);
    },
    ...overrides,
  };
  return { h, calls };
}

test("apply: auto + applied switches the model, applies thinking, reads back", async () => {
  const { h, calls } = hooks();
  const result = await applyRoute(decision({ mode: "auto" }), h);
  assert.equal(result.applied, true);
  assert.equal(calls.model, "openrouter/m");
  assert.equal(calls.thinking, "high");
  assert.equal(result.appliedThinking, "high", "read back after clamp");
  assert.equal(result.symbol, "→");
  assert.equal(result.needsConfirm, false);
  assert.equal(calls.entries.length, 1, "entry written");
  assert.equal(calls.entries[0].thinking?.applied, "high");
});

test("apply: notify does not switch and does not apply thinking", async () => {
  const { h, calls } = hooks();
  const result = await applyRoute(decision({ mode: "notify", reason: "budget soft" }), h);
  assert.equal(result.applied, false, "notify never calls setModel");
  assert.equal(calls.model, undefined);
  assert.equal(calls.thinking, undefined, "notify mode does not touch thinking");
  assert.equal(result.symbol, "•");
  assert.match(String(calls.entries[0].reason), /not applied \(notify mode\)/);
});

test("apply: confirm flags needsConfirm without blocking on a question", async () => {
  const { h, calls } = hooks();
  const result = await applyRoute(decision({ mode: "confirm" }), h);
  assert.equal(result.needsConfirm, true, "index.ts asks, apply does not block");
  assert.equal(result.applied, false, "no model change before the user confirms");
  assert.equal(calls.entries.length, 0, "no entry before the user decides (W7)");
  assert.equal(calls.model, undefined);
  assert.equal(result.symbol, "→", "still a switch (pending confirmation)");
});

test("apply: held applies thinking but never the model, in every mode", async () => {
  for (const mode of ["auto", "confirm", "notify"] as const) {
    const { h, calls } = hooks();
    const result = await applyRoute(decision({ outcome: "held", mode }), h);
    assert.equal(result.applied, false);
    assert.equal(calls.model, undefined, `held never switches in ${mode}`);
    assert.equal(calls.thinking, "high", `held applies thinking in ${mode} (stale-thinking fix)`);
    assert.equal(result.symbol, "=");
  }
});

test("apply: skipped writes an entry with the reason and applies thinking", async () => {
  const { h, calls } = hooks();
  const result = await applyRoute(decision({ outcome: "skipped", skipReason: "continuation" }), h);
  assert.equal(result.symbol, "×");
  assert.equal(calls.model, undefined);
  assert.equal(calls.thinking, "high");
  assert.equal(calls.entries[0].reason, "continuation");
});

test("apply: a failing setModel never throws and is captured, fail-open", async () => {
  const { h, calls } = hooks({ failModel: true });
  const result = await applyRoute(decision({ mode: "auto" }), h);
  assert.equal(result.failed, true);
  assert.equal(result.applied, false);
  assert.match(String(result.error), /apply failed: boom/);
  assert.equal(calls.thinking, undefined, "thinking untouched after a model failure");
  assert.equal(calls.entries.length, 1, "entry still written for visibility");
});

test("apply: a missing readThinkingLevel leaves appliedThinking unset (no false success)", async () => {
  const { h } = hooks({ readThinkingLevel: undefined });
  const result = await applyRoute(decision({ mode: "auto" }), h);
  assert.equal(result.applied, true);
  assert.equal(result.appliedThinking, undefined, "do not fake a clamp readback");
  assert.equal(result.entry.thinking?.applied, undefined);
});

test("apply: a prefer entry with an empty provider passes the bare model id", async () => {
  const { h, calls } = hooks();
  await applyRoute(decision({ target: { provider: "", model: "~z-ai/glm-latest", explicit: true } }), h);
  assert.equal(calls.model, "~z-ai/glm-latest", "empty provider → bare id (targetKey)");
});

test("apply: skipped without a target still applies thinking and writes the entry (W10)", async () => {
  const { h, calls } = hooks();
  const result = await applyRoute(
    { outcome: "skipped", thinking: "low", mode: "auto", skipReason: "continuation" },
    h,
  );
  assert.equal(result.applied, false);
  assert.equal(calls.thinking, "low", "skipped applies thinking (stale-level fix)");
  assert.equal(calls.entries.length, 1);
  assert.equal(calls.entries[0].symbol, "×");
  assert.equal(calls.entries[0].target, null);
  assert.equal(calls.entries[0].tier, null);
  assert.equal(calls.entries[0].reason, "continuation");
});

test("compose: low kind confidence withdraws the kind's demand and tier floors (W9)", () => {
  const cfg = config({
    classify: { ...DEFAULT_CONFIG.classify, confidenceThreshold: 0.5 },
    taskKinds: { plan: { label: "Plan", floor: 2.5 } },
    kindMinimumTier: { plan: "premium" },
    thinking: {},
  });
  const low = compose(
    { kind: "plan", kindConfidence: 0.2, complexity: 1.0, capability: 1.0, source: "laya", latencyMs: 1 },
    cfg,
  );
  assert.equal(low.demand, 1.0, "kind floor withdrawn");
  assert.equal(low.tier, "standard", "confidence cap");
  assert.equal(low.thinking, "low", "thinking follows the withdrawn demand, not the kind floor");

  const high = compose(
    { kind: "plan", kindConfidence: 0.9, complexity: 1.0, capability: 1.0, source: "laya", latencyMs: 1 },
    cfg,
  );
  assert.equal(high.demand, 2.9, "confident kinds keep their floor (kindMinimumTier premium)");
  assert.equal(high.tier, "premium");
});
