// test/stats.test.ts — 決策日誌聚合（D2，/compass log 的資料層）。
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DecisionRecord } from "../extensions/pi-compass-router/decisions.js";
import { formatCounts, summarizeDecisions } from "../extensions/pi-compass-router/stats.js";

const NOW = Date.parse("2026-10-05T00:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * 24 * 60 * 60 * 1000).toISOString();

test("summarizeDecisions counts outcomes, feedback, kinds, tiers and models", () => {
  const records: DecisionRecord[] = [
    { type: "route", outcome: "applied", model: "openrouter/a", tier: "standard", kind: "plan", cacheMissUsd: 0.02, symbol: "→", ts: iso(0) } as never,
    { type: "route", outcome: "applied", model: "openrouter/a", tier: "standard", kind: "plan", symbol: "→", ts: iso(1) } as never,
    { type: "route", outcome: "held", model: "openrouter/b", tier: "high", kind: "review", symbol: "=", ts: iso(2) } as never,
    { type: "route", outcome: "skipped", model: null, tier: null, symbol: "×", ts: iso(3) } as never,
    { type: "route", outcome: "cancelled", model: "openrouter/c", tier: "standard", kind: "chat", symbol: "×", ts: iso(4) } as never,
    { type: "feedback", feedback: "revert", from: "openrouter/a", to: "openrouter/b", ts: iso(5) } as never,
    { type: "feedback", feedback: "manual-override", from: "openrouter/a", to: "openrouter/c", ts: iso(6) } as never,
  ];
  const stats = summarizeDecisions(records, NOW);
  assert.equal(stats.total, 5);
  assert.equal(stats.applied, 2);
  assert.equal(stats.held, 1);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.cancelled, 1);
  assert.equal(stats.revert, 1);
  assert.equal(stats.manualOverride, 1);
  assert.deepEqual(stats.kinds[0], { key: "plan", count: 2 });
  // tier null 歸為 "(unknown)"
  assert.ok(stats.tiers.some((entry) => entry.key === "(unknown)" && entry.count === 1));
  assert.ok(stats.tiers.some((entry) => entry.key === "standard" && entry.count === 3));
  assert.deepEqual(stats.models[0], { key: "openrouter/a", count: 2 });
  assert.equal(stats.cacheMissCount, 1);
  assert.equal(stats.cacheMissAvgUsd, 0.02);
});

test("summarizeDecisions ignores records older than the window", () => {
  const records: DecisionRecord[] = [
    { type: "route", outcome: "applied", model: "openrouter/a", symbol: "→", ts: iso(10) } as never,
    { type: "route", outcome: "applied", model: "openrouter/b", symbol: "→", ts: iso(200) } as never,
  ];
  const stats = summarizeDecisions(records, NOW, 90);
  assert.equal(stats.total, 1);
  assert.deepEqual(stats.models, [{ key: "openrouter/a", count: 1 }]);
});

test("a record without a parsable timestamp is kept (fail-open)", () => {
  const stats = summarizeDecisions(
    [{ type: "route", outcome: "applied", model: "openrouter/x", symbol: "→" } as never],
    NOW,
  );
  assert.equal(stats.total, 1);
});

test("formatCounts joins entries and returns undefined when empty", () => {
  assert.equal(formatCounts([]), undefined);
  assert.equal(
    formatCounts([
      { key: "a", count: 2 },
      { key: "b", count: 1 },
    ]),
    "a 2 · b 1",
  );
});
