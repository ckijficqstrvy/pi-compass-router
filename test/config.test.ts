import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_FILE, loadConfig, validatePatch, WRITABLE_KEYS } from "../extensions/pi-compass-router/config/load.js";
import { blendedOf, factsValid, rankedFacts, sliceBands } from "../extensions/pi-compass-router/policy/facts.js";
import { COMPASS_ENV_MAP, parseEnvOverrides } from "../extensions/pi-compass-router/config/env.js";

/** 空環境：不繼承 process.env，測試結果才可重現。 */
const NO_ENV = {};

function withTempConfig(content: string | object): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "compass-config-"));
  const path = join(dir, "config.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("CONFIG_FILE is fixed at ~/.pi/agent/pi-compass/config.json (no project-level config)", () => {
  assert.ok(CONFIG_FILE.endsWith(join(".pi", "agent", "pi-compass", "config.json")));
});

test("empty env yields the SPEC Part 3.1 defaults with no warnings", () => {
  const { config, warnings } = loadConfig(NO_ENV, { filePath: "/nonexistent/config.json" });
  assert.deepStrictEqual(warnings, []);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, "notify");
  assert.equal(config.classify.provider, "laya");
  assert.equal(config.classify.timeoutMs, 800);
  assert.equal(config.classify.minPromptChars, 12);
  assert.equal(config.budget.dailyUsd, 5);
  assert.equal(config.budget.monthlyUsd, 100);
  assert.equal(config.profile, "balanced");
  assert.equal(config.cache.deadband, 0.25);
  assert.equal(config.xpremium.enabled, false);
  assert.equal(config.freePool.enabled, false);
});

test("every COMPASS_* name in the map has a parser", () => {
  for (const name of Object.keys(COMPASS_ENV_MAP)) {
    const { warnings } = parseEnvOverrides({ [name]: "definitely-invalid-@@@" });
    assert.equal(warnings.length, 1, `${name} should produce exactly one warning`);
    assert.ok(warnings[0].startsWith(`${name}: `), `warning must name the variable: ${warnings[0]}`);
  }
});

test("a valid env value overrides the default", () => {
  const { config, warnings } = loadConfig({ COMPASS_MODE: "auto", COMPASS_PROVIDER: "cloud" }, { filePath: "/nope" });
  assert.deepStrictEqual(warnings, []);
  assert.equal(config.mode, "auto");
  assert.equal(config.classify.provider, "cloud");
});

test("an invalid env value is dropped and the default stands", () => {
  const { config, warnings } = loadConfig({ COMPASS_MODE: "sideways", COMPASS_TIMEOUT_MS: "soon" }, { filePath: "/nope" });
  assert.equal(config.mode, "notify", "invalid value must not reach the config");
  assert.equal(config.classify.timeoutMs, 800);
  assert.equal(warnings.length, 2);
  assert.ok(warnings[0].includes("COMPASS_MODE"));
  assert.ok(warnings[0].includes("expected auto, confirm, or notify"));
});

test("an empty env value counts as unset, not invalid", () => {
  const { warnings, config } = loadConfig({ COMPASS_MODE: "", COMPASS_PROFILE: "   " }, { filePath: "/nope" });
  assert.deepStrictEqual(warnings, []);
  assert.equal(config.mode, "notify");
  assert.equal(config.profile, "balanced");
});

test("raw values are echoed only when short printable ASCII", () => {
  const { warnings } = parseEnvOverrides({ COMPASS_MODE: "a".repeat(50) });
  assert.ok(warnings[0].includes("(value hidden)"), `long value must be hidden: ${warnings[0]}`);

  const short = parseEnvOverrides({ COMPASS_MODE: "nope" });
  assert.ok(short.warnings[0].includes('"nope"'), "short printable value is echoed");

  const binary = parseEnvOverrides({ COMPASS_MODE: "\u001b[31mred\u001b[0m" });
  assert.ok(binary.warnings[0].includes("(value hidden)"), "control bytes must be hidden");
});

test('budget caps accept "none" to clear the dimension', () => {
  const { config, warnings } = loadConfig(
    { COMPASS_BUDGET_DAILY_USD: "none", COMPASS_BUDGET_MONTHLY_USD: "unlimited" },
    { filePath: "/nope" },
  );
  assert.deepStrictEqual(warnings, []);
  assert.equal(config.budget.dailyUsd, null);
  assert.equal(config.budget.monthlyUsd, null);
});

test("a negative cap is rejected", () => {
  const { config, warnings } = loadConfig({ COMPASS_BUDGET_DAILY_USD: "-1" }, { filePath: "/nope" });
  assert.equal(config.budget.dailyUsd, 5, "invalid cap leaves the default");
  assert.equal(warnings.length, 1);
});

test("softRatio > hardRatio from env drops BOTH env ratios and warns", () => {
  const { config, warnings } = loadConfig(
    { COMPASS_BUDGET_SOFT_RATIO: "0.95", COMPASS_BUDGET_HARD_RATIO: "0.3" },
    { filePath: "/nope" },
  );
  assert.equal(config.budget.softRatio, 0.7, "file/default value stands");
  assert.equal(config.budget.hardRatio, 0.9);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("must be <="), warnings[0]);
});

test("kindMinimumTier parses comma-separated kind=tier pairs", () => {
  const { config, warnings } = loadConfig({ COMPASS_KIND_MIN_TIER: "plan=high,chat=quick" }, { filePath: "/nope" });
  assert.deepStrictEqual(warnings, []);
  assert.equal(config.kindMinimumTier.plan, "high");
  assert.equal(config.kindMinimumTier.chat, "quick");
  assert.equal(config.kindMinimumTier.review, "high", "unmentioned kinds keep their default");
});

test("a malformed kindMinimumTier pair is rejected", () => {
  for (const raw of ["plan", "plan=tierx", "=high", "plan=high=extra"]) {
    const { warnings } = parseEnvOverrides({ COMPASS_KIND_MIN_TIER: raw });
    assert.equal(warnings.length, 1, `expected rejection for ${JSON.stringify(raw)}`);
  }
});

test("a trailing comma in kindMinimumTier is tolerated (shell artifacts)", () => {
  const { config, warnings } = loadConfig({ COMPASS_KIND_MIN_TIER: "plan=high," }, { filePath: "/nope" });
  assert.deepStrictEqual(warnings, []);
  assert.equal(config.kindMinimumTier.plan, "high");
});

test("variables outside the map are ignored", () => {
  const { warnings, overrides } = parseEnvOverrides({ COMPASS_NOT_A_REAL_KEY: "x", RANDOM_THING: "y" });
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(overrides, {
    classify: {},
    budget: {},
    cache: {},
    xpremium: {},
    freePool: {},
  });
});

// ---------------------------------------------------------------------------
// config.json 層
// ---------------------------------------------------------------------------

test("an unknown top-level key in config.json is dropped by name", () => {
  const temp = withTempConfig({ enabled: false, totallyMadeUp: 123 });
  try {
    const { config, warnings } = loadConfig(NO_ENV, { filePath: temp.path });
    assert.equal(config.enabled, false, "known key applies");
    assert.ok(warnings.some((w) => w.includes('"totallyMadeUp"') && w.includes("whitelist")), warnings.join(" | "));
  } finally {
    temp.cleanup();
  }
});

test("budget.dailyUsd: null clears the cap, an omitted key keeps it", () => {
  const cleared = withTempConfig({ budget: { dailyUsd: null } });
  const kept = withTempConfig({ budget: { monthlyUsd: 42 } });
  try {
    assert.equal(loadConfig(NO_ENV, { filePath: cleared.path }).config.budget.dailyUsd, null);
    const keptConfig = loadConfig(NO_ENV, { filePath: kept.path }).config;
    assert.equal(keptConfig.budget.monthlyUsd, 42);
    assert.equal(keptConfig.budget.dailyUsd, 5, "omitted keys are not baked in");
  } finally {
    cleared.cleanup();
    kept.cleanup();
  }
});

test("config.json routes entries are marked explicit (Part 9 L3)", () => {
  const temp = withTempConfig({
    routes: { quick: [{ provider: "openrouter", model: "some/model" }] },
  });
  try {
    const { config } = loadConfig(NO_ENV, { filePath: temp.path });
    assert.equal(config.routes.quick.length, 1);
    assert.equal(config.routes.quick[0].explicit, true, "explicit entries must survive deny/price filtering");
  } finally {
    temp.cleanup();
  }
});

test("a malformed config.json is ignored with a warning and defaults stand", () => {
  const temp = withTempConfig("{ this is not json");
  try {
    const { config, warnings } = loadConfig(NO_ENV, { filePath: temp.path });
    assert.equal(config.enabled, true);
    assert.ok(warnings.some((w) => w.includes("invalid JSON")), warnings.join(" | "));
  } finally {
    temp.cleanup();
  }
});

test("type errors inside config.json are rejected per-key with a warning", () => {
  const temp = withTempConfig({
    enabled: "yes",
    mode: "chaotic",
    budget: { softRatio: 5 },
    deny: ["ok", 42],
  });
  try {
    const { config, warnings } = loadConfig(NO_ENV, { filePath: temp.path });
    assert.equal(config.enabled, true, "string is not a boolean");
    assert.equal(config.mode, "notify", "unknown mode rejected");
    assert.equal(config.budget.softRatio, 0.7, "out-of-range ratio rejected");
    assert.deepStrictEqual(config.deny, [], "mixed array rejected");
    assert.equal(warnings.length, 4, warnings.join(" | "));
  } finally {
    temp.cleanup();
  }
});

test("env beats config.json", () => {
  const temp = withTempConfig({ mode: "auto" });
  try {
    assert.equal(loadConfig({ COMPASS_MODE: "confirm" }, { filePath: temp.path }).config.mode, "confirm");
    assert.equal(loadConfig(NO_ENV, { filePath: temp.path }).config.mode, "auto");
  } finally {
    temp.cleanup();
  }
});

// ---------------------------------------------------------------------------
// validatePatch（Part 3.4）
// ---------------------------------------------------------------------------

test("validatePatch rejects unknown keys by name", () => {
  assert.match(String(validatePatch("totallyMadeUp", 1)), /^totallyMadeUp: unknown setting/);
  assert.match(String(validatePatch("apiKey", "sk-...")), /whitelist/);
});

test("validatePatch rejects malformed values with a reason", () => {
  assert.match(String(validatePatch("enabled", "yes")), /expected true or false/);
  assert.match(String(validatePatch("mode", "sideways")), /expected one of auto\|confirm\|notify/);
  assert.match(String(validatePatch("budget", { softRatio: 9 })), /within 0-1/);
  assert.match(String(validatePatch("deny", ["a", 1])), /array of non-empty strings/);
  assert.match(String(validatePatch("routes", { quick: [{ model: "x" }] })), /provider and model/);
  assert.match(String(validatePatch("classify", { timeoutMs: -1 })), /integer >= 0/);
  assert.match(String(validatePatch("cache", { bogus: 1 })), /unknown setting/);
});

test("validatePatch accepts well-formed values", () => {
  assert.equal(validatePatch("enabled", false), null);
  assert.equal(validatePatch("mode", "auto"), null);
  assert.equal(validatePatch("budget", { dailyUsd: null }), null);
  assert.equal(validatePatch("budget", { monthlyUsd: 10 }), null);
  assert.equal(validatePatch("routes", { high: [{ provider: "openrouter", model: "m", minTier: "high" }] }), null);
  assert.equal(validatePatch("kindMinimumTier", { plan: "premium" }), null);
  assert.equal(validatePatch("taskKinds", { data: { label: "Data work", floor: 1 } }), null);
  assert.equal(validatePatch("freePool", { enabled: true }), null);
  assert.equal(validatePatch("ceilings", { quick: null }), null);
  assert.equal(validatePatch("thinking", { plan: "max" }), null);
  assert.equal(validatePatch("classify", { provider: "laya", timeoutMs: 400 }), null);
});

test("WRITABLE_KEYS matches the SPEC Part 3.1 whitelist", () => {
  const expected = [
    "enabled",
    "useDefaultModels",
    "autoRoutes",
    "allowUnratedPicks",
    "freeOnly",
    "stickiness",
    "mode",
    "modelPick",
    "profile",
    "classify",
    "routes",
    "kindModels",
    "kindMinimumTier",
    "taskKinds",
    "xpremium",
    "freePool",
    "specialistPriority",
    "suggest",
    "budget",
    "ceilings",
    "deny",
    "allowProviders",
    "prefer",
    "cache",
    "thinking",
  ];
  for (const key of expected) {
    assert.ok(WRITABLE_KEYS.includes(key), `missing writable key: ${key}`);
  }
});

// ---------------------------------------------------------------------------
// L1 facts + L2 policy 組合（Part 9）
// ---------------------------------------------------------------------------

test("autoRoutes derives tier chains from the facts file", () => {
  const { config } = loadConfig(NO_ENV, { filePath: "/nonexistent" });
  assert.ok(config.routes.quick.length > 0, "quick band must be derived");
  assert.ok(config.routes.standard.length > 0);
  assert.ok(config.routes.premium.length > 0);
  // 快帶第一位應是能力最高的平價模型（glm-flash，cap 42，blended 0.52）。
  assert.match(config.routes.quick[0].model, /glm-flash/);
});

test("a tier written in config.json is not overwritten by derivation (L3 wins)", () => {
  const temp = withTempConfig({ routes: { quick: [{ provider: "openrouter", model: "my/own-model" }] } });
  try {
    const { config } = loadConfig(NO_ENV, { filePath: temp.path });
    assert.deepStrictEqual(
      config.routes.quick.map((t) => t.model),
      ["my/own-model"],
      "a tier the user owns is never re-derived",
    );
  } finally {
    temp.cleanup();
  }
});

test("deny strips derived chains but not explicit ones", () => {
  const temp = withTempConfig({
    deny: ["*claude-opus*"],
    routes: { premium: [{ provider: "openrouter", model: "~anthropic/claude-opus-latest" }] },
  });
  try {
    const { config } = loadConfig(NO_ENV, { filePath: temp.path });
    const models = config.routes.premium.map((t) => t.model);
    assert.ok(models.includes("~anthropic/claude-opus-latest"), "explicit survives its own deny");
    assert.equal(models.filter((m) => m.includes("claude-opus")).length, 1, "no derived duplicate was added");
  } finally {
    temp.cleanup();
  }
});

test("prefer heads land first in the chain", () => {
  const temp = withTempConfig({ prefer: { quick: ["moonshotai/kimi-k3"] } });
  try {
    const { config } = loadConfig(NO_ENV, { filePath: temp.path });
    assert.equal(config.routes.quick[0].model, "moonshotai/kimi-k3");
    assert.equal(config.routes.quick[0].explicit, true);
  } finally {
    temp.cleanup();
  }
});

test("useDefaultModels:false empties the built-in chains", () => {
  const { config } = loadConfig({ COMPASS_USE_DEFAULT_MODELS: "0" }, { filePath: "/nonexistent" });
  assert.equal(config.useDefaultModels, false);
  assert.deepStrictEqual(config.routes.quick, [], "no built-in model may remain");
  assert.deepStrictEqual(config.routes.premium, []);
  assert.deepStrictEqual(config.kindModels, {}, "kind specialists are built-in too");
  assert.ok(Object.keys(config.taskKinds).length > 0, "kind *taxonomy* is not a model chain, it stays");
});

test("useDefaultModels:false still keeps the chains the user wrote", () => {
  const temp = withTempConfig({
    useDefaultModels: false,
    routes: { high: [{ provider: "openrouter", model: "my/bring-your-own" }] },
  });
  try {
    const { config } = loadConfig(NO_ENV, { filePath: temp.path });
    assert.deepStrictEqual(config.routes.high.map((t) => t.model), ["my/bring-your-own"]);
    assert.deepStrictEqual(config.routes.quick, []);
  } finally {
    temp.cleanup();
  }
});

test("useDefaultModels:false is not back-filled by the facts file", () => {
  const { config } = loadConfig({ COMPASS_USE_DEFAULT_MODELS: "false" }, { filePath: "/nonexistent" });
  assert.deepStrictEqual(config.routes.quick, [], "facts must not re-fill an emptied chain");
});

// ---------------------------------------------------------------------------
// facts 層（Part 9 L1）
// ---------------------------------------------------------------------------

test("blendedOf is input + 2×output (the ceiling metric)", () => {
  assert.equal(blendedOf({ input: 2, output: 3 }), 8);
  assert.equal(blendedOf({ input: 0, output: 0 }), 0);
});

test("factsValid rejects empty, malformed and negative facts", () => {
  const good = { generatedAt: "2026-10-01", source: "s", models: [{ provider: "p", model: "m", capability: 40 }] };
  assert.equal(factsValid(good), true);
  assert.equal(factsValid({ ...good, models: [] }), false, "an empty file is unusable");
  assert.equal(factsValid({ ...good, generatedAt: 1 }), false);
  assert.equal(factsValid({ ...good, models: [{ provider: "p", model: "m", capability: Number.NaN }] }), false);
  assert.equal(factsValid({ ...good, models: [{ provider: "p", model: "m", capability: 1, price: { input: -1, output: 0 } }] }), false);
  assert.equal(factsValid(undefined), false);
});

test("rankedFacts sorts by capability descending and keeps ties stable", () => {
  const facts = {
    generatedAt: "2026-10-01",
    source: "s",
    models: [
      { provider: "p", model: "low", capability: 10 },
      { provider: "p", model: "tie-a", capability: 40 },
      { provider: "p", model: "tie-b", capability: 40 },
      { provider: "p", model: "high", capability: 90 },
    ],
  };
  assert.deepStrictEqual(rankedFacts(facts).map((m) => m.model), ["high", "tie-a", "tie-b", "low"]);
});

test("sliceBands puts each priced fact in the first band that covers it", () => {
  const ranked = [
    { provider: "p", model: "cheap", capability: 10, price: { input: 0.5, output: 0.1 } },
    { provider: "p", model: "mid", capability: 20, price: { input: 3, output: 1 } },
    { provider: "p", model: "rich", capability: 30, price: { input: 100, output: 100 } },
  ];
  const bands = sliceBands(ranked, [1, 5, 15, 44, null]);
  assert.deepStrictEqual(bands[0].map((m) => m.model), ["cheap"]);
  assert.deepStrictEqual(bands[1].map((m) => m.model), ["mid"]);
  assert.deepStrictEqual(bands[4].map((m) => m.model), ["rich"], "the open-ended band catches everything else");
});

test("a fact without a price is never banded (capability alone must not place it)", () => {
  const ranked = [{ provider: "p", model: "unpriced", capability: 99 }];
  const bands = sliceBands(ranked, [1, 5, 15, 44, null]);
  assert.ok(bands.every((band) => band.length === 0), "an unpriced model appears in no derived chain");
});