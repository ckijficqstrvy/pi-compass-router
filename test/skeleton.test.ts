// test/skeleton.test.ts — 骨架驗收：預設值符合 SPEC Part 3.1、各模組 export 存在。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CONFIG,
  DEFAULT_KIND_MINIMUM_TIER,
  TIER_THINKING,
  TIER_CAPABILITY_FLOOR,
  PROFILE_CEILINGS,
} from "../extensions/pi-compass-router/schema.js";
import { COMPASS_ENV_MAP } from "../extensions/pi-compass-router/config/env.js";
import * as index from "../extensions/pi-compass-router/index.js";
import * as load from "../extensions/pi-compass-router/config/load.js";
import * as env from "../extensions/pi-compass-router/config/env.js";
import * as cache from "../extensions/pi-compass-router/classify/cache.js";
import * as analysis from "../extensions/pi-compass-router/classify/analysis.js";
import * as laya from "../extensions/pi-compass-router/classify/laya.js";
import * as cloud from "../extensions/pi-compass-router/classify/cloud.js";
import * as compose from "../extensions/pi-compass-router/route/compose.js";
import * as select from "../extensions/pi-compass-router/route/select.js";
import * as guard from "../extensions/pi-compass-router/route/guard.js";
import * as apply from "../extensions/pi-compass-router/route/apply.js";
import * as facts from "../extensions/pi-compass-router/policy/facts.js";
import * as filter from "../extensions/pi-compass-router/policy/filter.js";
import * as budget from "../extensions/pi-compass-router/budget.js";
import * as suggest from "../extensions/pi-compass-router/suggest.js";
import * as wizard from "../extensions/pi-compass-router/ui/wizard.js";
import * as entries from "../extensions/pi-compass-router/ui/entries.js";
import type { ClassifyInput, Judgment, Classifier } from "../extensions/pi-compass-router/classify/types.js";

test("DEFAULT_CONFIG follows SPEC Part 3.1 defaults", () => {
  assert.equal(DEFAULT_CONFIG.enabled, true);
  assert.equal(DEFAULT_CONFIG.mode, "notify");
  assert.equal(DEFAULT_CONFIG.useDefaultModels, true);

  assert.equal(DEFAULT_CONFIG.classify.provider, "laya");
  assert.equal(DEFAULT_CONFIG.classify.timeoutMs, 800);
  assert.equal(DEFAULT_CONFIG.classify.minPromptChars, 12);
  assert.equal(DEFAULT_CONFIG.classify.historyTurns, 0);
  assert.equal(DEFAULT_CONFIG.classify.cache, true);
  assert.equal(DEFAULT_CONFIG.classify.cacheTtlSeconds, 300);
  assert.equal(DEFAULT_CONFIG.classify.confidenceThreshold, 0.34);

  assert.equal(DEFAULT_CONFIG.xpremium.enabled, false);
  assert.equal(DEFAULT_CONFIG.freePool.enabled, false);
  assert.deepStrictEqual(DEFAULT_CONFIG.freePool.models, []);

  assert.equal(DEFAULT_CONFIG.budget.dailyUsd, 5);
  assert.equal(DEFAULT_CONFIG.budget.monthlyUsd, 100);
  assert.equal(DEFAULT_CONFIG.budget.softRatio, 0.7);
  assert.equal(DEFAULT_CONFIG.budget.hardRatio, 0.9);
  assert.equal(DEFAULT_CONFIG.profile, "balanced");

  assert.equal(DEFAULT_CONFIG.stickiness, true);
  assert.equal(DEFAULT_CONFIG.cache.aware, true);
  assert.equal(DEFAULT_CONFIG.cache.deadband, 0.25);
  assert.equal(DEFAULT_CONFIG.cache.maxPenaltyUsd, 0.05);
  assert.equal(DEFAULT_CONFIG.cache.bypassTierDelta, 2);
  assert.equal(DEFAULT_CONFIG.cache.cooldownSeconds, 0);

  assert.equal(DEFAULT_CONFIG.modelPick, "off");
  assert.equal(DEFAULT_CONFIG.autoRoutes, true);
  assert.deepStrictEqual(DEFAULT_CONFIG.kindMinimumTier, DEFAULT_KIND_MINIMUM_TIER);
});

test("tier tables match SPEC Part 5 / Stage 3 / Part 9", () => {
  assert.deepStrictEqual(TIER_THINKING, {
    quick: "off",
    standard: "low",
    high: "medium",
    premium: "high",
    xpremium: "max",
  });
  assert.deepStrictEqual(TIER_CAPABILITY_FLOOR, {
    quick: 20,
    standard: 35,
    high: 38,
    premium: 44,
    xpremium: 46,
  });
  // PROFILE_CEILINGS 必須含 xpremium 欄位（Part 9 價格帶表）。
  for (const profile of ["cheap", "balanced", "quality"] as const) {
    assert.ok("xpremium" in PROFILE_CEILINGS[profile], `${profile} 缺 xpremium`);
  }
  assert.equal(PROFILE_CEILINGS.balanced.xpremium, null); // ∞ → null
  assert.equal(PROFILE_CEILINGS.cheap.quick, 1);
});

test("COMPASS_ENV_MAP covers SPEC Part 3.3 keys", () => {
  const keys = Object.keys(COMPASS_ENV_MAP);
  assert.equal(keys.length, 28);
  for (const name of ["COMPASS_ENABLED", "COMPASS_MODE", "COMPASS_PROFILE", "COMPASS_KIND_MIN_TIER"]) {
    assert.ok(name in COMPASS_ENV_MAP, `缺少 ${name}`);
  }
  assert.ok(keys.every((k) => k.startsWith("COMPASS_")));
});

test("classify/types exposes the Part 4.1 interface shapes", () => {
  // 型別存在性：以滿足介面的空值驗證（compile-time）。
  const input: ClassifyInput = { request: "hello", kinds: ["chat"] };
  assert.equal(input.request, "hello");
  const classifier: Partial<Classifier> = { id: "laya" };
  assert.equal(classifier.id, "laya");
  const judgment: Partial<Judgment> = { kind: "chat", kindConfidence: 0.9 };
  assert.equal(judgment.kind, "chat");
});

test("every module exposes its skeleton exports", () => {
  const expected: Array<[string, unknown, string]> = [
    ["index", index.register, "function"],
    ["config/load", load.loadConfig, "function"],
    ["config/load", load.validatePatch, "function"],
    ["config/env", env.parseEnvOverrides, "function"],
    ["classify/cache", cache.cacheKey, "function"],
    ["classify/cache", cache.configGeneration, "function"],
    ["classify/cache", cache.normalizeRequest, "function"],
    ["classify/cache", cache.ClassificationCache, "function"],
    ["classify/analysis", analysis.buildQuestions, "function"],
    ["classify/analysis", analysis.parseAnalysis, "function"],
    ["classify/analysis", analysis.sanitizeRemote, "function"],
    ["classify/analysis", analysis.ClassifyError, "function"],
    ["classify/laya", laya.createLayaClassifier, "function"],
    ["classify/cloud", cloud.createCloudClassifier, "function"],
    ["route/compose", compose.compose, "function"],
    ["route/compose", compose.DEMAND_LADDER, "object"],
    ["route/select", select.selectTargets, "function"],
    ["route/guard", guard.guard, "function"],
    ["route/apply", apply.applyRoute, "function"],
    ["policy/facts", facts.factsValid, "function"],
    ["policy/facts", facts.factFor, "function"],
    ["policy/facts", facts.rankedFacts, "function"],
    ["policy/facts", facts.blendedOf, "function"],
    ["policy/facts", facts.sliceBands, "function"],
    ["policy/filter", filter.filterChain, "function"],
    ["policy/filter", filter.insertPrefer, "function"],
    ["budget", budget.computePressure, "function"],
    ["budget", budget.recordSpend, "function"],
    ["suggest", suggest.suggest, "function"],
    ["ui/wizard", wizard.parseChain, "function"],
    ["ui/wizard", wizard.parseAmount, "function"],
    ["ui/wizard", wizard.providerLabel, "function"],
    ["ui/wizard", wizard.providerFromLabel, "function"],
    ["ui/wizard", wizard.modeLabel, "function"],
    ["ui/wizard", wizard.modeFromLabel, "function"],
    ["ui/wizard", wizard.runSettingsWizard, "function"],
    ["ui/entries", entries.renderEntry, "function"],
  ];
  for (const [mod, value, type] of expected) {
    assert.equal(typeof value, type, `${mod} 缺少 export`);
  }
});

test("skeleton functions throw not-implemented", () => {
  // 尚未實作的入口（其餘模組已落地，見各模組測試）。
  assert.throws(() => index.register(), /not implemented/);
});
