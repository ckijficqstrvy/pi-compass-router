import { test } from "node:test";
import assert from "node:assert/strict";

import { DEMAND_LADDER, TIER_DEMAND_FLOOR, compose } from "../extensions/pi-compass-router/route/compose.js";
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
  assert.equal(out[0].model, "moonshotai/kimi-k3");
  assert.equal(out[0].explicit, true, "prefer heads are explicit");
  assert.equal(out[0].provider, "", "id-only match, provider is unknown for a bare catalogue id");
  assert.equal(out.length, 3 + 1);

  const duped = insertPrefer([{ provider: "openrouter", model: "moonshotai/kimi-k3" }], "quick", cfg);
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