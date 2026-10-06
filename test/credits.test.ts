import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CREDIT_MAX_AGE_MS,
  CreditBook,
  loadCredits,
  parseOpenRouterCredits,
  probeProvider,
  saveCredits,
  type FetchLike,
} from "../extensions/pi-compass-router/credits.js";

test("parseOpenRouterCredits subtracts usage from credits", () => {
  assert.equal(parseOpenRouterCredits({ data: { total_credits: 137, total_usage: 137.04 } }), -0.03999999999999204);
  assert.equal(parseOpenRouterCredits({ data: { total_credits: 10, total_usage: 4 } }), 6);
  assert.equal(parseOpenRouterCredits({ data: { total_credits: 0, total_usage: 0 } }), 0);
});

test("parseOpenRouterCredits rejects malformed or non-numeric payloads", () => {
  assert.equal(parseOpenRouterCredits(undefined), undefined);
  assert.equal(parseOpenRouterCredits({}), undefined);
  assert.equal(parseOpenRouterCredits({ data: {} }), undefined);
  assert.equal(parseOpenRouterCredits({ data: { total_credits: "137", total_usage: 4 } }), undefined);
  assert.equal(parseOpenRouterCredits({ data: { total_credits: 10, total_usage: null } }), undefined);
  assert.equal(parseOpenRouterCredits({ data: { total_credits: NaN, total_usage: 4 } }), undefined);
});

test("probeProvider calls the credits endpoint with the bearer key", async () => {
  let seen: { url: string; headers: Record<string, string> } | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    seen = { url, headers: init.headers };
    return { ok: true, json: async () => ({ data: { total_credits: 5, total_usage: 5.5 } }) };
  };
  const remaining = await probeProvider("openrouter", "sk-or-test", { fetchImpl });
  assert.equal(seen?.url, "https://openrouter.ai/api/v1/credits");
  assert.equal(seen?.headers.Authorization, "Bearer sk-or-test");
  assert.equal(remaining, -0.5);
});

test("probeProvider is fail-open on non-2xx, network error, unknown provider, empty key", async () => {
  const notOk: FetchLike = async () => ({ ok: false, json: async () => ({}) });
  const throws: FetchLike = async () => {
    throw new Error("offline");
  };
  const malformed: FetchLike = async () => ({ ok: true, json: async () => ({ data: { total_credits: 1 } }) });
  assert.equal(await probeProvider("openrouter", "k", { fetchImpl: notOk }), undefined);
  assert.equal(await probeProvider("openrouter", "k", { fetchImpl: throws }), undefined);
  assert.equal(await probeProvider("openrouter", "k", { fetchImpl: malformed }), undefined);
  assert.equal(await probeProvider("deepseek", "k", { fetchImpl: notOk }), undefined, "no probe defined");
  assert.equal(await probeProvider("openrouter", "", { fetchImpl: notOk }), undefined, "no key");
});

test("exhausted blocks zero or negative balances and allows positive", () => {
  const now = 1_000_000;
  const book = new CreditBook([
    { provider: "openrouter", remainingUsd: -0.04, checkedAt: now, source: "test" },
    { provider: "deepseek", remainingUsd: 0, checkedAt: now, source: "test" },
    { provider: "nous-portal", remainingUsd: 12.5, checkedAt: now, source: "test" },
  ]);
  assert.equal(book.exhausted("openrouter", { now })?.remainingUsd, -0.04, "negative balance is blocked");
  assert.equal(book.exhausted("deepseek", { now })?.remainingUsd, 0, "exactly 0 is blocked too");
  assert.equal(book.exhausted("nous-portal", { now }), undefined, "positive balance is allowed");
  assert.equal(book.exhausted("unknown", { now }), undefined, "no data == fail-open");
  assert.equal(book.exhausted("", { now }), undefined);
});

test("exhausted forgets a stale negative balance (fail-open after max age)", () => {
  const now = 10_000_000;
  const book = new CreditBook([
    { provider: "openrouter", remainingUsd: -1, checkedAt: now - CREDIT_MAX_AGE_MS - 1, source: "test" },
  ]);
  assert.equal(book.exhausted("openrouter", { now }), undefined, "older than max age does not block");
  assert.equal(book.get("openrouter")?.remainingUsd, -1, "the cached entry is still there");
  const fresh = new CreditBook([
    { provider: "openrouter", remainingUsd: -1, checkedAt: now - CREDIT_MAX_AGE_MS + 1, source: "test" },
  ]);
  assert.equal(fresh.exhausted("openrouter", { now })?.remainingUsd, -1, "within max age still blocks");
});

test("stale reports missing and aged entries as needing a refresh", () => {
  const now = 2_000_000;
  const book = new CreditBook([{ provider: "openrouter", remainingUsd: 1, checkedAt: now - 1000, source: "t" }]);
  assert.equal(book.stale("openrouter", now, 5 * 60_000), false);
  assert.equal(book.stale("openrouter", now, 500), true);
  assert.equal(book.stale("deepseek", now, 5 * 60_000), true, "no data is stale");
});

test("loadCredits/saveCredits round-trip through 0600 file and survive corruption", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-credits-"));
  try {
    const file = join(dir, "provider-balance.json");
    const book = new CreditBook([
      { provider: "openrouter", remainingUsd: -0.0438, checkedAt: 1234, source: "https://example.test" },
    ]);
    saveCredits(book, file);
    const loaded = loadCredits(file);
    const entry = loaded.get("openrouter");
    assert.equal(entry?.remainingUsd, -0.0438);
    assert.equal(entry?.checkedAt, 1234);
    assert.equal(loaded.exhausted("openrouter", { now: 1234, maxAgeMs: 10 })?.provider, "openrouter");

    writeFileSync(file, "{ not json");
    assert.equal(loadCredits(file).list().length, 0, "corrupt file -> empty book, never throws");
    assert.equal(loadCredits(join(dir, "missing.json")).list().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCredits drops invalid entries but keeps valid ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-credits-"));
  try {
    const file = join(dir, "provider-balance.json");
    writeFileSync(
      file,
      JSON.stringify({
        entries: [
          { provider: "openrouter", remainingUsd: -1, checkedAt: 5, source: "t" },
          { provider: "", remainingUsd: -1, checkedAt: 5, source: "t" },
          { provider: "x", remainingUsd: "nope", checkedAt: 5, source: "t" },
          { provider: "y", remainingUsd: 2, checkedAt: "soon", source: "t" },
        ],
      }),
    );
    const loaded = loadCredits(file);
    assert.deepEqual(
      loaded.list().map((e) => e.provider),
      ["openrouter"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
