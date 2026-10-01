// test/suggest.test.ts — 分數檔 → 路由提議（SPEC Part 10.1「分數檔格式」、Part 12）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { suggest } from "../extensions/pi-compass-router/suggest.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig } from "../extensions/pi-compass-router/schema.js";

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

const dir = mkdtempSync(join(tmpdir(), "compass-suggest-"));

function writeScores(name: string, body: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

test.after?.(() => rmSync(dir, { recursive: true, force: true }));

test("an empty scoresFile returns [] without reading anything", async () => {
  const result = await suggest(config());
  assert.deepEqual(result, []);
});

test("a missing scores file throws (the user asked, silence would mislead)", async () => {
  await assert.rejects(() => suggest(config(), "/nonexistent/scores.json"), /cannot read scores file/);
});

test("a non-JSON scores file throws", async () => {
  const path = writeScores("bad.json", "{ not json");
  await assert.rejects(() => suggest(config(), path), /not valid JSON/);
});

test("an object without a scores map throws", async () => {
  const path = writeScores("nomap.json", { generatedAt: "2026-10-01" });
  await assert.rejects(() => suggest(config(), path), /must be an object with a "scores" map/);
});

test("scores are sorted descending, ties broken by model id", async () => {
  const path = writeScores("sorted.json", {
    scores: {
      "openrouter/b": { score: 0.5, tier: "quick" },
      "openrouter/a": { score: 0.9, tier: "quick" },
      "openrouter/c": { score: 0.9, tier: "quick" },
    },
  });
  const result = await suggest(config(), path);
  assert.equal(result.length, 3);
  assert.equal(result[0].target.model, "a");
  assert.equal(result[1].target.model, "c");
  assert.equal(result[2].target.model, "b");
  assert.equal(result[0].reason, "score 0.90");
});

test("an entry with a note carries it into the reason", async () => {
  const path = writeScores("note.json", { scores: { "openrouter/x": { score: 0.7, tier: "high", note: "long-context" } } });
  const [first] = await suggest(config(), path);
  assert.equal(first.reason, "score 0.70 · long-context");
  assert.equal(first.tier, "high");
});

test("an invalid score is skipped without dropping the rest", async () => {
  const path = writeScores("invalid-score.json", {
    scores: {
      "openrouter/bad": { score: 1.5, tier: "quick" },
      "openrouter/good": { score: 0.8, tier: "quick" },
    },
  });
  const result = await suggest(config(), path);
  assert.equal(result.length, 1, "only the valid entry survives");
  assert.equal(result[0].target.model, "good");
});

test("an unknown tier is skipped", async () => {
  const path = writeScores("bad-tier.json", {
    scores: {
      "openrouter/bad": { score: 0.9, tier: "ultra" },
      "openrouter/good": { score: 0.8, tier: "quick" },
    },
  });
  const result = await suggest(config(), path);
  assert.deepEqual(result.map((s) => s.target.model), ["good"]);
});

test("an unrated entry with no tier is skipped (facts derive the tier)", async () => {
  const path = writeScores("unrated.json", {
    scores: {
      "openrouter/unknown-model": { score: 0.9 },
      "openrouter/~z-ai/glm-latest": { score: 0.95 },
    },
  });
  const result = await suggest(config(), path);
  // glm-latest 在事實檔、cap 45 → 推到 high；unknown 無事實 → 跳過。
  assert.deepEqual(result.map((s) => s.target.model), ["~z-ai/glm-latest"]);
  assert.equal(result[0].tier, "high");
});

test("suggested targets are never marked explicit", async () => {
  const path = writeScores("explicit.json", { scores: { "openrouter/x": { score: 0.5, tier: "quick" } } });
  const [first] = await suggest(config(), path);
  assert.notEqual(first.target.explicit, true, "a proposal is not a config entry");
});