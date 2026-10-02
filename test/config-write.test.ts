// test/config-write.test.ts — writeConfigPatch 的結構化合併語意（2026-10-02）。
//
// 兩件新事：
//   1. **不物化預設值**——只寫「現檔 ∪ patch」的鍵；舊版把整個預設設定寫進
//      檔，使所有鏈變 explicit（L1 自動推導停擺、deny 失效）。
//   2. **`null` = 刪除子鍵**——回預設／回自動派生（單向門解藥）；
//      例外 `budget.dailyUsd/monthlyUsd` 的 null 是值（無上限）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, writeConfigPatch } from "../extensions/pi-compass-router/config/load.js";
import { DEFAULT_CONFIG, PROFILE_CEILINGS } from "../extensions/pi-compass-router/schema.js";

const dir = mkdtempSync(join(tmpdir(), "compass-write-"));

function freshFile(body: unknown): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test.after?.(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

test("寫入只動被提到的鍵：預設值不物化進檔案", () => {
  const path = freshFile({ mode: "notify" });

  const problem = writeConfigPatch({ budget: { dailyUsd: 10 } }, path);
  assert.equal(problem, null);

  const written = readJson(path);
  assert.deepEqual(Object.keys(written).sort(), ["budget", "mode"], `實際：${Object.keys(written).join(", ")}`);
  assert.deepEqual(written.budget, { dailyUsd: 10 }, "只帶被改的子鍵");
});

test("routes.<tier> 給 null = 刪掉該層（回自動派生，非显式）", () => {
  const path = freshFile({
    routes: { quick: [{ provider: "openrouter", model: "my/pinned", explicit: true }] },
  });

  const problem = writeConfigPatch({ routes: { quick: null } }, path);
  assert.equal(problem, null);

  const written = readJson(path);
  assert.deepEqual(written.routes, undefined, "整層被移除，空物件不留");

  const loaded = loadConfig({}, { filePath: path }).config;
  assert.ok(loaded.routes.quick.length > 0, "載入後回內建/派生鏈");
  assert.ok(
    loaded.routes.quick.every((target) => !target.explicit),
    "不能被標显式——否則 L1 事實推導不會接管",
  );
});

test("prefer.<tier> 給 null = 清除偏好首選", () => {
  const path = freshFile({ prefer: { quick: ["my/fav"] } });

  const problem = writeConfigPatch({ prefer: { quick: null } }, path);
  assert.equal(problem, null);

  const written = readJson(path);
  assert.deepEqual(written.prefer, undefined, "空的 prefer 整個移除");
  const loaded = loadConfig({}, { filePath: path }).config;
  assert.deepEqual(loaded.prefer.quick, undefined);
});

test("thinking.<kind> 與 pin 給 null = 清除", () => {
  const path = freshFile({ thinking: { pin: "high", plan: "max" } });

  const problem = writeConfigPatch({ thinking: { pin: null } }, path);
  assert.equal(problem, null);

  let written = readJson(path);
  assert.deepEqual(written.thinking, { plan: "max" }, "只刪 pin，plan 保留");

  writeConfigPatch({ thinking: { plan: null } }, path);
  written = readJson(path);
  assert.deepEqual(written.thinking, undefined);
});

test("ceilings.<tier> 給 null = 清除自訂（回 profile 價格帶）", () => {
  const path = freshFile({ profile: "cheap", ceilings: { quick: 99 } });

  const problem = writeConfigPatch({ ceilings: { quick: null } }, path);
  assert.equal(problem, null);

  const written = readJson(path);
  assert.deepEqual(written.ceilings, undefined);
  const loaded = loadConfig({}, { filePath: path }).config;
  assert.deepEqual(loaded.ceilings.quick, undefined);
  assert.equal(PROFILE_CEILINGS[loaded.profile].quick, PROFILE_CEILINGS.cheap.quick);
});

test("budget.dailyUsd 的 null 是值（無上限），不是刪除", () => {
  const path = freshFile({ budget: { dailyUsd: 10 } });

  const problem = writeConfigPatch({ budget: { dailyUsd: null } }, path);
  assert.equal(problem, null);

  const written = readJson(path);
  assert.deepEqual(written.budget, { dailyUsd: null }, "null 落檔 = 無上限");
  const loaded = loadConfig({}, { filePath: path }).config;
  assert.equal(loaded.budget.dailyUsd, null);
});

test("kindMinimumTier.<kind> 給 null = 回預設下限", () => {
  const path = freshFile({ kindMinimumTier: { plan: "premium" } });

  const problem = writeConfigPatch({ kindMinimumTier: { plan: null } }, path);
  assert.equal(problem, null);

  const loaded = loadConfig({}, { filePath: path }).config;
  assert.equal(loaded.kindMinimumTier.plan, DEFAULT_CONFIG.kindMinimumTier.plan);
});

test("物件鍵的子鍵合併是 patch 非覆寫（其他子鍵保留）", () => {
  const path = freshFile({ classify: { model: "keep/me", timeoutMs: 900 } });

  const problem = writeConfigPatch({ classify: { timeoutMs: 1500 } }, path);
  assert.equal(problem, null);

  const written = readJson(path);
  assert.deepEqual(written.classify, { model: "keep/me", timeoutMs: 1500 });
});

test("null 刪除仍受白名單驗證保護：未知鍵照樣整筆拒", () => {
  const path = freshFile({ mode: "notify" });
  const before = readFileSync(path, "utf8");

  const problem = writeConfigPatch({ nope: null }, path);
  assert.match(String(problem), /unknown setting/);
  assert.equal(readFileSync(path, "utf8"), before);
});