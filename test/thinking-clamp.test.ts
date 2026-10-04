import { test } from "node:test";
import assert from "node:assert/strict";

import { compose } from "../extensions/pi-compass-router/route/compose.js";
import { DEFAULT_CONFIG, type CompassConfig } from "../extensions/pi-compass-router/schema.js";
import type { Judgment } from "../extensions/pi-compass-router/classify/types.js";

function config(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return {
    ...DEFAULT_CONFIG,
    classify: { ...DEFAULT_CONFIG.classify },
    taskKinds: { ...DEFAULT_CONFIG.taskKinds },
    kindMinimumTier: { ...DEFAULT_CONFIG.kindMinimumTier },
    thinking: { ...DEFAULT_CONFIG.thinking },
    ...overrides,
  } as CompassConfig;
}

function judgment(overrides: Partial<Judgment> = {}): Judgment {
  return { kind: "chat", kindConfidence: 0.9, latencyMs: 5, source: "laya", ...overrides };
}

// Observed 2026-10-04: the local classifier answered "xhigh" for "1+1=?".
test("an extreme over-thinking answer falls back to the demand ladder", () => {
  const result = compose(judgment({ kind: "chat", complexity: 1, capability: 1, thinking: "xhigh" }), config());
  assert.equal(result.demand, 1, "no floor above the scores");
  assert.equal(result.thinking, "low", "xhigh is outside the ladder +/-1 window");
});

test("a low-confidence judgment cannot raise thinking above the ladder", () => {
  const result = compose(
    judgment({ kind: "chat", kindConfidence: 0.1, complexity: 1, capability: 1, thinking: "xhigh" }),
    config(),
  );
  assert.equal(result.thinking, "low");
});

// Observed: a genuinely complex migration was answered "minimal".
test("an under-thinking answer is raised back to the demand ladder", () => {
  const result = compose(
    judgment({ kind: "operate", complexity: 2.6, capability: 2.6, deepReasoning: 1, thinking: "minimal" }),
    config(),
  );
  assert.ok(result.demand >= 2.75, `demand ${result.demand} should reach the high ladder`);
  assert.equal(result.thinking, "high", "ladder is high at demand 2.75; minimal is too far below");
});

test("a judged level within one rung of the ladder is kept", () => {
  const result = compose(
    judgment({ kind: "operate", complexity: 1.8, capability: 1.8, thinking: "high" }),
    config(),
  );
  assert.equal(result.thinking, "high");
});

test("an explicit pin still wins over the clamp", () => {
  const result = compose(
    judgment({ kind: "operate", complexity: 1.8, capability: 1.8, thinking: "off" }),
    config({ thinking: { pin: "max" } }),
  );
  assert.equal(result.thinking, "max");
});

test("a missing thinking answer uses the ladder", () => {
  const result = compose(
    judgment({ kind: "operate", complexity: 2.6, capability: 2.6, deepReasoning: 1, thinking: undefined }),
    config(),
  );
  assert.equal(result.thinking, "high");
});
