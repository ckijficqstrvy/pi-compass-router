import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONFIG_FILE, loadConfig, validatePatch, WRITABLE_KEYS } from "../extensions/pi-compass-router/config/load.js";
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