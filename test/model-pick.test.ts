// test/model-pick.test.ts — Stage 3 選鏈與 menu 六道閘（SPEC Part 5 Stage 3、Part 12）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  menuKeys,
  selectTargets,
  targetFromKey,
  targetKey,
  tierOfModel,
} from "../extensions/pi-compass-router/route/select.js";
import { ceilingFor } from "../extensions/pi-compass-router/policy/filter.js";
import { factFor } from "../extensions/pi-compass-router/policy/facts.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig } from "../extensions/pi-compass-router/schema.js";
import type { Judgment } from "../extensions/pi-compass-router/classify/types.js";

function config(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return {
    ...DEFAULT_CONFIG,
    classify: { ...DEFAULT_CONFIG.classify },
    budget: { ...DEFAULT_CONFIG.budget },
    cache: { ...DEFAULT_CONFIG.cache },
    taskKinds: { ...DEFAULT_CONFIG.taskKinds },
    kindMinimumTier: { ...DEFAULT_CONFIG.kindMinimumTier },
    kindModels: { ...DEFAULT_CONFIG.kindModels },
    routes: {
      quick: [...DEFAULT_CONFIG.routes.quick],
      standard: [...DEFAULT_CONFIG.routes.standard],
      high: [...DEFAULT_CONFIG.routes.high],
      premium: [...DEFAULT_CONFIG.routes.premium],
      xpremium: [...DEFAULT_CONFIG.routes.xpremium],
    },
    specialistPriority: { ...DEFAULT_CONFIG.specialistPriority },
    prefer: { ...DEFAULT_CONFIG.prefer },
    thinking: { ...DEFAULT_CONFIG.thinking },
    xpremium: { ...DEFAULT_CONFIG.xpremium },
    freePool: { ...DEFAULT_CONFIG.freePool },
    suggest: { ...DEFAULT_CONFIG.suggest },
    ...overrides,
  } as CompassConfig;
}

function judgment(overrides: Partial<Judgment> = {}): Judgment {
  return {
    kind: "plan",
    kindConfidence: 0.9,
    complexity: 1.7,
    capability: 1.55,
    thinking: "high",
    latencyMs: 5,
    source: "laya",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// targetKey 編碼（menu id 的形狀）
// ---------------------------------------------------------------------------

test("targetKey encodes provider/model and passes through a bare model", () => {
  assert.equal(targetKey({ provider: "openrouter", model: "openai/gpt-6-sol" }), "openrouter/openai/gpt-6-sol");
  assert.equal(targetKey({ provider: "", model: "~z-ai/glm-latest" }), "~z-ai/glm-latest");
});

test("targetFromKey round-trips both shapes", () => {
  assert.deepEqual(targetFromKey("openrouter/openai/gpt-6-sol"), {
    provider: "openrouter",
    model: "openai/gpt-6-sol",
  });
  assert.deepEqual(targetFromKey("~z-ai/glm-latest"), { provider: "", model: "~z-ai/glm-latest" });
});

// ---------------------------------------------------------------------------
// Stage 3 組鏈順序：專家 → 層級 → 池
// ---------------------------------------------------------------------------

test("specialists come before the tier chain and minTier > tier is filtered", () => {
  const cfg = config({
    kindModels: {
      plan: [
        { provider: "openrouter", model: "a", minTier: "premium" },
        { provider: "openrouter", model: "b", minTier: "standard" },
      ],
    },
    routes: { ...config().routes, high: [{ provider: "openrouter", model: "t1" }] },
  });
  const { chain } = selectTargets("high", judgment(), cfg);
  // premium 專家被 minTier 過濾，standard 專家留下並在層級鏈之前。
  assert.deepEqual(
    chain.map((t) => t.model),
    ["b", "t1"],
  );
});

test("specialistPriority orders specialists ahead of the tier chain", () => {
  const cfg = config({
    kindModels: {
      plan: [
        { provider: "openrouter", model: "second" },
        { provider: "openrouter", model: "first" },
      ],
    },
    specialistPriority: { plan: ["first", "second"] },
    routes: { ...config().routes, high: [{ provider: "openrouter", model: "t" }] },
  });
  const { chain } = selectTargets("high", judgment(), cfg);
  assert.deepEqual(
    chain.map((x) => x.model),
    ["first", "second", "t"],
  );
});

test("selectTargets dedupes a model that appears in both specialist and tier chains (F7)", () => {
  const cfg = config({
    kindModels: { plan: [{ provider: "openrouter", model: "dup" }] },
    routes: {
      ...config().routes,
      high: [{ provider: "openrouter", model: "dup" }, { provider: "openrouter", model: "t1" }],
    },
  });
  const { chain } = selectTargets("high", judgment(), cfg);
  assert.deepStrictEqual(chain.map((t) => t.model), ["dup", "t1"]);
});

test("tierOfModel ignores a non-last null ceiling instead of returning it (F2)", () => {
  const cfg = config({ ceilings: { quick: null } });
  assert.notEqual(tierOfModel(cfg, "openrouter", "openai/gpt-6.1-sol"), "quick");
  assert.equal(tierOfModel(cfg, "openrouter", "openai/gpt-6.1-sol"), "premium");
});

test("freePool enters only when the tier chain is empty", () => {
  const withPool = config({
    freePool: { enabled: true, models: [{ provider: "openrouter", model: "free1" }] },
    routes: { ...config().routes, quick: [{ provider: "openrouter", model: "paid" }] },
    kindModels: {},
  });
  const emptyTier = config({
    freePool: { enabled: true, models: [{ provider: "openrouter", model: "free1" }] },
    routes: { ...config().routes, quick: [] },
    kindModels: {},
  });
  assert.ok(selectTargets("quick", undefined, withPool).chain.some((t) => t.model === "paid"));
  assert.ok(selectTargets("quick", undefined, emptyPool(emptyTier)).chain.some((t) => t.model === "free1"));
});

/** freePool.enabled 為真但 routes 空 → 池進場（helper 便於閱讀）。 */
function emptyPool(cfg: CompassConfig): CompassConfig {
  return { ...cfg, routes: { ...cfg.routes, quick: [] } };
}

// ---------------------------------------------------------------------------
// freeOnly 與 freePool 是兩個獨立的池
// ---------------------------------------------------------------------------

test("freeOnly with no zero-price facts falls back to freePool then tier chain", () => {
  // model-facts 目前零元模型 0 筆 → freeOnly 走 freePool 回退。
  const cfg = config({
    freeOnly: true,
    freePool: { enabled: true, models: [{ provider: "openrouter", model: "zero" }] },
    routes: { ...config().routes, high: [{ provider: "openrouter", model: "paid" }] },
    kindModels: {},
  });
  const { chain } = selectTargets("high", undefined, cfg);
  assert.ok(chain.some((t) => t.model === "zero"), "freeOnly falls back to the free pool");
  assert.ok(!chain.some((t) => t.model === "paid"), "freeOnly must not reach the paid tier chain");
});

test("freeOnly keeps explicit prefer entries (L3 beats L2 policy)", () => {
  const cfg = config({
    freeOnly: true,
    prefer: { high: ["my/preferred"] },
    freePool: { enabled: true, models: [{ provider: "openrouter", model: "zero" }] },
    kindModels: {},
    routes: { ...config().routes, high: [] },
  });
  const { chain } = selectTargets("high", undefined, cfg);
  assert.equal(chain[0]?.model, "my/preferred", "explicit prefer survives freeOnly");
  assert.equal(chain[0]?.explicit, true);
});

test("strictFreeOnly turns the paid fallback into no route (C4)", () => {
  const cfg = config({
    freeOnly: true,
    strictFreeOnly: true,
    freePool: { enabled: false, models: [] },
    routes: { ...config().routes, high: [{ provider: "openrouter", model: "paid" }] },
    kindModels: {},
  });
  const { chain, notes } = selectTargets("high", undefined, cfg);
  assert.deepEqual(chain, [], "no verified $0 model and no freePool → empty chain");
  assert.ok(notes.some((note) => note.includes("strictFreeOnly")), "the reason is recorded");
});

test("strictFreeOnly still honours explicit prefer entries (L3)", () => {
  const cfg = config({
    freeOnly: true,
    strictFreeOnly: true,
    prefer: { high: ["my/preferred"] },
    kindModels: {},
    routes: { ...config().routes, high: [] },
  });
  const { chain } = selectTargets("high", undefined, cfg);
  assert.equal(chain[0]?.model, "my/preferred", "explicit prefer survives strict free-only");
});

// ---------------------------------------------------------------------------
// menu 六道閘
// ---------------------------------------------------------------------------

test("a menu pick inside the band is hoisted to the head", () => {
  const cfg = config({
    modelPick: "menu",
    routes: { ...config().routes, high: [{ provider: "openrouter", model: "t1" }] },
    kindModels: {},
  });
  // grok-latest 在事實檔（~ 前綴），capability 46 ≥ high 門檻 38，blended 14 ≤ ceiling 15。
  const j = judgment({ modelPick: "openrouter/~x-ai/grok-latest" });
  const result = selectTargets("high", j, cfg);
  assert.equal(result.picked?.model, "~x-ai/grok-latest");
  assert.equal(result.chain[0]?.model, "~x-ai/grok-latest", "picked hoisted to head");
  assert.deepEqual(result.notes, []);
});

test("a menu pick above the tier ceiling is rejected with a note", () => {
  const cfg = config({ modelPick: "menu", kindModels: {}, routes: { ...config().routes, quick: [] } });
  // ~anthropic/claude-opus-latest blended 44 > quick ceiling 1.5 → price over ceiling。
  const j = judgment({ modelPick: "openrouter/~anthropic/claude-opus-latest" });
  const result = selectTargets("quick", j, cfg);
  assert.equal(result.picked, undefined, "rejected pick is not hoisted");
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /price over ceiling/);
});

test("an unrated menu pick is rejected unless allowUnratedPicks", () => {
  const cfg = config({ modelPick: "menu", kindModels: {}, routes: { ...config().routes, quick: [] } });
  const j = judgment({ modelPick: "openrouter/unknown/model-x" });
  const rejected = selectTargets("quick", j, cfg);
  assert.equal(rejected.picked, undefined);
  // 未評分且未允許 → 无法通过 registry 閘（gates 1/3 同看事实檔）。
  assert.match(rejected.notes[0], /not in registry|unrated model/);

  const allowed = config({
    modelPick: "menu",
    allowUnratedPicks: true,
    kindModels: {},
    routes: { ...config().routes, quick: [] },
  });
  const passed = selectTargets("quick", j, allowed);
  assert.deepEqual(passed.notes, [], "allowUnratedPicks clears both registry gates");
  assert.equal(passed.picked?.model, "unknown/model-x", "unrated pick passes when allowed");
});

test("a menu pick denied by policy is rejected with a note", () => {
  const cfg = config({
    modelPick: "menu",
    deny: ["*grok*"],
    kindModels: {},
    routes: { ...config().routes, high: [] },
  });
  const j = judgment({ modelPick: "openrouter/~x-ai/grok-latest" });
  const result = selectTargets("high", j, cfg);
  assert.equal(result.picked, undefined);
  assert.match(result.notes[0], /denied by policy/);
});

test("a menu pick that is an explicit prefer head keeps explicit and passes policy (F6)", () => {
  const cfg = config({
    modelPick: "menu",
    allowProviders: ["openrouter"],
    kindModels: {},
    routes: { ...config().routes, high: [{ provider: "", model: "~x-ai/grok-latest", explicit: true }] },
  });
  const result = selectTargets("high", judgment({ modelPick: "~x-ai/grok-latest" }), cfg);
  assert.equal(result.picked?.model, "~x-ai/grok-latest");
  assert.equal(result.picked?.explicit, true, "explicit survives the allowProviders gate");
  assert.equal(result.chain[0]?.explicit, true, "the hoisted head keeps the flag");
});

test("modelPick: off ignores judgment.modelPick entirely", () => {
  const cfg = config({ modelPick: "off", kindModels: {}, routes: { ...config().routes, quick: [{ provider: "p", model: "m" }] } });
  const j = judgment({ modelPick: "openrouter/~x-ai/grok-latest" });
  const result = selectTargets("quick", j, cfg);
  assert.equal(result.picked, undefined);
  assert.deepEqual(result.notes, []);
  assert.equal(result.chain[0]?.model, "m", "chain unchanged when menu is off");
});

// ---------------------------------------------------------------------------
// menuKeys 組裝（Stage 1 傳入）
// ---------------------------------------------------------------------------

test("menuKeys returns undefined when modelPick is off", () => {
  assert.equal(menuKeys("high", judgment(), config()), undefined);
});

test("menuKeys dedupes and only forms when there is more than one candidate", () => {
  const one = config({
    modelPick: "menu",
    kindModels: {},
    routes: { ...config().routes, quick: [{ provider: "p", model: "only" }] },
  });
  assert.equal(menuKeys("quick", undefined, one), undefined, "one candidate → no sixth question");

  const many = config({
    modelPick: "menu",
    kindModels: {},
    routes: {
      ...config().routes,
      quick: [
        { provider: "p", model: "a" },
        { provider: "p", model: "b" },
        { provider: "p", model: "a" },
      ],
    },
  });
  const keys = menuKeys("quick", undefined, many);
  assert.deepEqual(keys, ["p/a", "p/b"], "dedupes to two ids");
});

// ---------------------------------------------------------------------------
// ceilingFor（menu gate 第 5 道與 load 共用）
// ---------------------------------------------------------------------------

test("ceilingFor prefers an explicit ceiling over the profile table", () => {
  const cfg = config();
  assert.equal(ceilingFor(cfg, "quick"), 1.5, "balanced profile quick ceiling");
  const explicit = config({ ceilings: { quick: 9 } });
  assert.equal(ceilingFor(explicit, "quick"), 9, "explicit ceiling wins");
  const quality = config({ profile: "quality" });
  assert.equal(ceilingFor(quality, "premium"), null, "quality premium is unbounded (null)");
});

test("factFor resolves the facts used by the gate", () => {
  const fact = factFor("openrouter", "~x-ai/grok-latest");
  assert.ok(fact, "grok-latest must be in the facts file");
  assert.ok(fact.capability.intelligence >= 38, "grok capability clears the high floor");
});
test("factFor never borrows another provider's fact (W8 regression)", () => {
  // 取一個真實 facts 條目，用錯的 provider 查 → 必須 undefined（不再跨 provider 誤配）。
  const known = factFor("openrouter", "~x-ai/grok-latest");
  assert.ok(known, "fixture fact exists");
  assert.equal(factFor("some-other-provider", "~x-ai/grok-latest"), undefined);
  // 裸 id 且唯一 → 允許（provider 無法得知）；不存在或歧義 → undefined。
  assert.equal(factFor("", "definitely-not-a-real-model-xyz"), undefined);
});
