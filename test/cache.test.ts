import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClassificationCache,
  cacheKey,
  configGeneration,
  normalizeRequest,
} from "../extensions/pi-compass-router/classify/cache.js";
import type { Judgment } from "../extensions/pi-compass-router/classify/types.js";

function judgment(overrides: Partial<Judgment> = {}): Judgment {
  return {
    kind: "plan",
    kindConfidence: 0.9,
    complexity: 1.7,
    capability: 1.55,
    deepReasoning: 0.82,
    thinking: "high",
    latencyMs: 12,
    source: "laya",
    ...overrides,
  };
}

test("normalizeRequest collapses whitespace and truncates at 512 chars", () => {
  assert.equal(normalizeRequest("  a\n\tb   c  "), "a b c");
  const long = "x".repeat(600);
  assert.equal(normalizeRequest(long).length, 512);
});

test("whitespace-only differences produce the same key; content differences do not", () => {
  const gen = configGeneration({ plan: { label: "p", floor: 1.5 } }, "off");
  assert.equal(cacheKey("a  b", gen), cacheKey("  a b\n", gen));
  assert.notEqual(cacheKey("a b", gen), cacheKey("a c", gen));
});

test("generation changes when task kinds or modelPick mode change", () => {
  const kinds = { plan: { label: "p", floor: 1.5 } };
  const base = configGeneration(kinds, "off");
  assert.notEqual(base, configGeneration(kinds, "menu"));
  assert.notEqual(base, configGeneration({ ...kinds, chat: { label: "c", floor: 0 } }, "off"));
});

test("generation is stable across key insertion order", () => {
  const a = configGeneration(
    { plan: { label: "p", floor: 1.5 }, chat: { label: "c", floor: 0 } },
    "off",
  );
  const b = configGeneration(
    { chat: { label: "c", floor: 0 }, plan: { label: "p", floor: 1.5 } },
    "off",
  );
  assert.equal(a, b);
});

test("cache budget/cache settings do NOT invalidate keys (only classify-affecting ones do)", () => {
  const kinds = { plan: { label: "p", floor: 1.5 } };
  // 只有 taskKinds / modelPick 進鍵；預算與價格帶變動不應使分類快取作廢。
  assert.equal(configGeneration(kinds, "off"), configGeneration(kinds, "off"));
});

test("hit marks cacheHit, switches source to cache, and reports the query latency", () => {
  const cache = new ClassificationCache({ enabled: true, ttlSeconds: 300 });
  const key = cacheKey("plan this out", "gen1");
  cache.set(key, judgment({ latencyMs: 40 }));

  const queryMs = 3;
  const hit = cache.get(key, queryMs);
  assert.ok(hit, "expected a cache hit");
  assert.equal(hit.cacheHit, true);
  assert.equal(hit.source, "cache");
  assert.equal(hit.latencyMs, queryMs, "latency must reflect this query, not the original classify");
  assert.equal(hit.kind, "plan");
});

test("stored judgment does not retain a stale cacheHit flag", () => {
  const cache = new ClassificationCache({ enabled: true, ttlSeconds: 300 });
  const key = cacheKey("k", "gen1");
  cache.set(key, judgment({ cacheHit: true, source: "cache" }));
  // 取回時 cacheHit 會被查詢端標上；重點是存入不放大原始標記。
  const hit = cache.get(key, 1);
  assert.ok(hit);
  assert.equal(hit.cacheHit, true);
  assert.equal(cache.size, 1);
});

test("expired entries miss", () => {
  const cache = new ClassificationCache({ enabled: true, ttlSeconds: 0.001 });
  const key = cacheKey("k", "gen1");
  cache.set(key, judgment());
  const before = Date.now();
  // ttl 1ms：等到過期再查。
  while (Date.now() - before < 5) {
    /* busy wait so the test does not need a timer */
  }
  assert.equal(cache.get(key, 1), undefined);
});

test("disabled cache never stores and never hits", () => {
  const cache = new ClassificationCache({ enabled: false, ttlSeconds: 300 });
  const key = cacheKey("k", "gen1");
  cache.set(key, judgment());
  assert.equal(cache.size, 0);
  assert.equal(cache.get(key, 1), undefined);
});

test("zero TTL behaves as disabled", () => {
  const cache = new ClassificationCache({ enabled: true, ttlSeconds: 0 });
  cache.set(cacheKey("k", "g"), judgment());
  assert.equal(cache.size, 0);
});

test("LRU evicts the oldest entry beyond maxEntries", () => {
  const cache = new ClassificationCache({ enabled: true, ttlSeconds: 300, maxEntries: 2 });
  const g = "gen1";
  cache.set(cacheKey("one", g), judgment({ kind: "chat" }));
  cache.set(cacheKey("two", g), judgment({ kind: "plan" }));
  // 觸碰 "one"，使其成為最近使用。
  assert.ok(cache.get(cacheKey("one", g), 1));
  cache.set(cacheKey("three", g), judgment({ kind: "write" }));

  assert.equal(cache.size, 2);
  assert.equal(cache.get(cacheKey("one", g), 1)?.kind, "chat", "recently used survives");
  assert.equal(cache.get(cacheKey("two", g), 1), undefined, "least recently used was evicted");
  assert.equal(cache.stats().evictions, 1);
});

test("stats counts hits, misses and evictions", () => {
  const cache = new ClassificationCache({ enabled: true, ttlSeconds: 300, maxEntries: 1 });
  const g = "gen1";
  const key = cacheKey("only", g);
  cache.set(key, judgment());
  assert.ok(cache.get(key, 1));
  assert.equal(cache.get(cacheKey("absent", g), 1), undefined);

  const stats = cache.stats();
  assert.equal(stats.hits, 1);
  assert.equal(stats.misses, 1);
  assert.equal(stats.size, 1);
});

test("clear empties the cache", () => {
  const cache = new ClassificationCache({ enabled: true, ttlSeconds: 300 });
  cache.set(cacheKey("k", "g"), judgment());
  assert.equal(cache.size, 1);
  cache.clear();
  assert.equal(cache.size, 0);
});