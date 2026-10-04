import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ModelHealth,
  classifyModelError,
  coolingReason,
  formatDuration,
  loadHealth,
  remainingSeconds,
  saveHealth,
} from "../extensions/pi-compass-router/health.js";

test("classifyModelError maps provider failures to avoidable classes", () => {
  assert.equal(classifyModelError("HTTP 429 Too Many Requests")?.klass, "rate_limit");
  assert.equal(classifyModelError("429 rate limit exceeded")?.klass, "rate_limit");
  assert.equal(classifyModelError("Monthly quota exceeded")?.klass, "quota");
  assert.equal(classifyModelError("402 Payment Required")?.klass, "quota");
  assert.equal(classifyModelError("insufficient credits")?.klass, "quota");
  assert.equal(classifyModelError("401 Unauthorized")?.klass, "auth");
  assert.equal(classifyModelError("invalid api key")?.klass, "auth");
  assert.equal(classifyModelError("503 Service Unavailable")?.klass, "server");
  assert.equal(classifyModelError("upstream overloaded")?.klass, "server");
  assert.equal(classifyModelError("fetch failed: ETIMEDOUT")?.klass, "timeout");
  assert.equal(classifyModelError("socket hang up")?.klass, "timeout");
});

test("classifyModelError never marks context overflow or unknown errors", () => {
  assert.equal(classifyModelError("context_length_exceeded"), null, "pi compacts and retries");
  assert.equal(classifyModelError("maximum context length is 200000 tokens"), null);
  assert.equal(classifyModelError("too many tokens in the prompt"), null);
  assert.equal(classifyModelError("some unknown provider hiccup"), null);
  assert.equal(classifyModelError(undefined), null);
  assert.equal(classifyModelError("   "), null);
});

test("a token count is not mistaken for a 5xx status", () => {
  assert.equal(classifyModelError("you sent 5000 tokens"), null);
});

test("markFailure cools down a model then expires", () => {
  const health = new ModelHealth();
  const now = 1_000_000;
  const marked = health.markFailure("openrouter", "m1", "rate_limit", now);
  assert.equal(marked.model.until, now + 60_000);
  assert.equal(coolingReason(health, "openrouter", "m1", now)?.klass, "rate_limit");
  assert.equal(health.list(now).length, 1);
  assert.equal(coolingReason(health, "openrouter", "m1", now + 60_000), undefined, "expired");
  assert.equal(health.list(now + 60_000).length, 0);
});

test("quota and auth also cool down the whole provider", () => {
  const health = new ModelHealth();
  const now = 5_000_000;
  const quota = health.markFailure("openrouter", "m1", "quota", now);
  assert.ok(quota.provider, "provider is marked for account-wide failures");
  assert.equal(coolingReason(health, "openrouter", "a-different-model", now)?.scope, "provider");
  assert.equal(quota.provider?.until, now + 30 * 60_000);

  const auth = health.markFailure("openrouter", "m2", "auth", now);
  assert.equal(auth.provider?.until, now + 360 * 60_000);
});

test("a server error cools only that model, not the provider", () => {
  const health = new ModelHealth();
  const now = 7_000_000;
  const marked = health.markFailure("openrouter", "m1", "server", now);
  assert.equal(marked.provider, undefined);
  assert.equal(coolingReason(health, "openrouter", "m2", now), undefined);
});

test("clearing a model restores it immediately", () => {
  const health = new ModelHealth();
  const now = 9_000_000;
  health.markFailure("p", "m", "server", now);
  assert.equal(health.isCoolingDown("p/m", now), true);
  health.clearModel("p", "m");
  assert.equal(health.isCoolingDown("p/m", now), false);
});

test("load/save round-trips and drops entries that expired while away", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-health-"));
  const file = join(dir, "health.json");
  try {
    const health = new ModelHealth();
    health.markFailure("openrouter", "m1", "rate_limit", 10_000);
    saveHealth(health, file);

    const reloaded = loadHealth(file, 10_000);
    assert.equal(reloaded.get("openrouter/m1", 10_000)?.klass, "rate_limit");

    const later = loadHealth(file, 10_000 + 60_001);
    assert.equal(later.list(10_000 + 60_001).length, 0, "expired entries are dropped on load");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHealth tolerates a missing or corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-health-"));
  const file = join(dir, "missing.json");
  try {
    assert.equal(loadHealth(file).list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatDuration switches to minutes past 90s", () => {
  assert.equal(formatDuration(30), "30s");
  assert.equal(formatDuration(89), "89s");
  assert.equal(formatDuration(600), "10m");
  const failure = { key: "x", scope: "model" as const, klass: "server" as const, label: "", until: 5000, at: 0 };
  assert.equal(remainingSeconds(failure, 4000), 1);
});
