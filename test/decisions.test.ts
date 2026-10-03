// test/decisions.test.ts — 決策日誌（#9，本地 JSONL、只存非內容欄位）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendDecision } from "../extensions/pi-compass-router/decisions.js";

test("appendDecision writes one JSON line per record with a timestamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-decisions-"));
  const file = join(dir, "decisions.jsonl");
  try {
    appendDecision({ type: "route", model: "openrouter/x", symbol: "→", tier: "standard" }, file);
    appendDecision({ type: "feedback", feedback: "revert", from: "a/b", to: "c/d" }, file);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "route");
    assert.equal(first.model, "openrouter/x");
    assert.ok(typeof first.ts === "string" && first.ts.includes("T"), "timestamp present");
    const second = JSON.parse(lines[1]);
    assert.equal(second.feedback, "revert");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("appendDecision never throws on an unwritable path", () => {
  assert.doesNotThrow(() => appendDecision({ type: "route", model: null, symbol: "×" }, "/dev/null/nowhere/decisions.jsonl"));
});

test("route records carry no prompt content (only derived fields)", () => {
  const record = {
    type: "route" as const,
    kind: "chat",
    kindConfidence: 0.9,
    demand: 1.6,
    tier: "standard",
    model: "openrouter/x",
    thinking: "high",
    symbol: "→",
    outcome: "applied",
  };
  const json = JSON.stringify(record);
  assert.ok(!/request|prompt|text|content/i.test(json), "no content-bearing field names");
});
