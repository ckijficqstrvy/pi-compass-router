// test/settings-ui.test.ts — 標籤往返、驗證、寫入備份（SPEC Part 12）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  modeFromLabel,
  modeLabel,
  parseAmount,
  parseChain,
  profileFromLabel,
  profileLabel,
  providerFromLabel,
  providerLabel,
  runSettingsWizard,
  type WizardHooks,
} from "../extensions/pi-compass-router/ui/wizard.js";
import { renderEntry } from "../extensions/pi-compass-router/ui/entries.js";
import { writeConfigPatch } from "../extensions/pi-compass-router/config/load.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig, Mode, Profile } from "../extensions/pi-compass-router/schema.js";

// ---------------------------------------------------------------------------
// parseChain / parseAmount（驗證）
// ---------------------------------------------------------------------------

test("parseChain splits on commas, trims, and drops empty segments", () => {
  assert.deepEqual(parseChain("openrouter/a, openrouter/b ,"), [
    { provider: "openrouter", model: "a" },
    { provider: "openrouter", model: "b" },
  ]);
});

test("parseChain treats a bare id as an empty provider", () => {
  assert.deepEqual(parseChain("~z-ai/glm-latest"), [{ provider: "", model: "~z-ai/glm-latest" }]);
  assert.deepEqual(parseChain(""), []);
});

test("parseAmount accepts dollars and rejects garbage", () => {
  assert.equal(parseAmount("5"), 5);
  assert.equal(parseAmount("$5.00"), 5);
  assert.equal(parseAmount("5.5"), 5.5);
  assert.equal(parseAmount("1,000"), 1000);
  assert.equal(parseAmount("-1"), null, "negative is invalid");
  assert.equal(parseAmount("abc"), null);
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount("NaN"), null);
});

// ---------------------------------------------------------------------------
// 標籤往返（Part 10.2）
// ---------------------------------------------------------------------------

test("modeLabel and modeFromLabel round-trip", () => {
  for (const mode of ["auto", "confirm", "notify"] as Mode[]) {
    const label = modeLabel(mode);
    assert.equal(modeFromLabel(label), mode, `${mode} round-trip`);
  }
  assert.equal(modeFromLabel("nonsense"), null);
  assert.equal(modeFromLabel("AUTO (extra)"), "auto", "prefix token, case-insensitive");
});

test("providerLabel and providerFromLabel round-trip", () => {
  for (const provider of ["openrouter", "laya", "typesafe"]) {
    const label = providerLabel(provider);
    assert.equal(providerFromLabel(label), provider, `${provider} round-trip`);
  }
  assert.equal(providerFromLabel("OpenRouter"), "openrouter");
  assert.equal(providerFromLabel("unknown-provider"), null);
});

test("providerLabel passes through an unregistered provider verbatim", () => {
  assert.equal(providerLabel("my-custom"), "my-custom");
});

test("profileLabel and profileFromLabel round-trip, ceilings printed in the label", () => {
  for (const profile of ["cheap", "balanced", "quality"] as Profile[]) {
    const label = profileLabel(profile);
    assert.equal(profileFromLabel(label), profile, `${profile} round-trip`);
    assert.match(label, /\/M 上限：/, "每層天花板要印在標籤上");
    assert.match(label, /quick \$\d/, label);
  }
  assert.equal(profileFromLabel("nonsense"), null);
});

// ---------------------------------------------------------------------------
// renderEntry（Part 10.4）
// ---------------------------------------------------------------------------

test("renderEntry formats the head and detail rows per Part 10.4", () => {
  const text = renderEntry({
    symbol: "→",
    tier: "standard",
    target: { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro" },
    kind: "plan",
    kindConfidence: 0.9,
    complexity: 1.7,
    capability: 1.55,
    deepReasoning: 0.82,
    budgetPressure: 0.74,
    classify: { source: "laya", latencyMs: 12, hit: false },
    thinking: { resolved: "high" },
  });
  const lines = text.split("\n");
  assert.equal(lines[0], "compass → standard  openrouter/xiaomi/mimo-v2.6-pro");
  assert.match(lines[1], /^├ task\s+plan 90%/);
  assert.match(lines[2], /^├ scoring\s+complexity 1\.70\/3/);
  assert.match(lines[2], /capability 1\.55\/3/);
  assert.match(lines[2], /reasoning 0\.82/);
  assert.match(lines[3], /^├ thinking\s+→ high$/);
  assert.match(lines[4], /^├ budget\s+74% of cap/);
  assert.match(lines[5], /^└ classify\s+laya 12ms \(miss\)/);
});

test("renderEntry collapsed view is one summary line with the pulse", () => {
  const text = renderEntry(
    {
      symbol: "→",
      tier: "standard",
      target: { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro" },
      kind: "plan",
      kindConfidence: 0.9,
      demand: 1.63,
      budgetPressure: 0.74,
      classify: { source: "laya", latencyMs: 73, hit: false },
      thinking: { resolved: "off" },
    },
    { expanded: false },
  );
  const lines = text.split("\n");
  assert.equal(lines.length, 2, "head + one summary line");
  assert.match(lines[1], /^plan 90%/);
  assert.match(lines[1], /demand 1\.63/);
  assert.match(lines[1], /thinking → off/);
  assert.match(lines[1], /laya 73ms \(miss\)/);
  assert.ok(!text.includes("├") && !text.includes("└"), "collapsed has no tree rails");
});

test("renderEntry omits absent segments instead of leaving stray separators", () => {
  const text = renderEntry({ symbol: "×", tier: null, target: null, reason: "continuation" });
  const lines = text.split("\n");
  assert.equal(lines[0], "compass ×");
  assert.equal(lines.length, 2, "only head + reason, no empty detail lines");
  assert.match(lines[1], /^└ reason\s+continuation$/);
  assert.ok(!text.includes("· ·"), "no doubled separators");
});

test("renderEntry shows applied-after-clamp when the readback differs", () => {
  const text = renderEntry({
    symbol: "=",
    tier: "high",
    target: { provider: "p", model: "m" },
    thinking: { resolved: "xhigh", applied: "high" },
  });
  assert.match(text, /→ xhigh \(applied high\)/);
});

test("renderEntry lists menu-gate rejection notes", () => {
  const text = renderEntry({
    symbol: "→",
    tier: "quick",
    target: { provider: "p", model: "m" },
    notes: ["price over ceiling", "unrated model"],
  });
  assert.match(text, /price over ceiling · unrated model/);
});

// ---------------------------------------------------------------------------
// writeConfigPatch（Part 3.4 落檔 + 時間戳備份）
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "compass-wizard-"));

function freshConfigFile(body: unknown): string {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(body, null, 2));
  return path;
}

test("writeConfigPatch rejects an unknown key without writing anything", () => {
  const path = freshConfigFile({ mode: "notify" });
  const before = readFileSync(path, "utf8");
  const problem = writeConfigPatch({ nope: 1 }, path);
  assert.match(String(problem), /unknown setting/);
  assert.equal(readFileSync(path, "utf8"), before, "atomic: nothing written on rejection");
});

test("writeConfigPatch rejects an invalid value and writes nothing", () => {
  const path = freshConfigFile({ mode: "notify" });
  const before = readFileSync(path, "utf8");
  const problem = writeConfigPatch({ budget: { dailyUsd: "lots" } }, path);
  assert.match(String(problem), /budget/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("writeConfigPatch merges only the patched keys and backs up the old file", () => {
  const path = freshConfigFile({ mode: "notify", profile: "balanced" });
  const problem = writeConfigPatch({ mode: "auto" }, path);
  assert.equal(problem, null);

  const written = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(written.mode, "auto", "patched key lands");
  assert.equal(written.profile, "balanced", "untouched key preserved (patch, not overwrite)");

  const backups = Object.keys(written).length > 0;
  assert.ok(backups);
  const siblings = readdirSync(dir);
  const backup = siblings.find((name) => name.startsWith("config-") && name.includes(".bak-"));
  assert.ok(backup, `a timestamped backup exists (found: ${siblings.join(", ")})`);
  const backupBody = JSON.parse(readFileSync(join(dir, backup as string), "utf8"));
  assert.equal(backupBody.mode, "notify", "backup holds the pre-write content");
});

test.after?.(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// runSettingsWizard（選單迴圈：驗證 → 寫 → 重載 → 重繪）
// ---------------------------------------------------------------------------

test("runSettingsWizard writes a picked mode, reloads, and quits on Esc", async () => {
  const config: CompassConfig = { ...DEFAULT_CONFIG } as CompassConfig;
  const written: Array<[string, unknown]> = [];
  let reloads = 0;
  let picks = 0;

  const hooks: WizardHooks = {
    write(key, value) {
      written.push([key, value]);
      return null;
    },
    reload() {
      reloads += 1;
    },
    async prompt() {
      return null;
    },
    async pick(_label, options) {
      picks += 1;
      if (picks === 1) return options.find((row) => row.startsWith("① 路由行為")) ?? null; // 主選單 → 組
      if (picks === 2) return options.find((row) => row.startsWith("路由模式")) ?? null; // 組內 → 項目
      if (picks === 3) return "confirm — 每次切換前先問你"; // 選值
      return null; // Esc（組內 → 主選單）
    },
  };

  await runSettingsWizard(config, hooks);
  assert.equal(written.length, 1);
  assert.equal(written[0][0], "mode");
  assert.equal(written[0][1], "confirm");
  assert.equal(reloads, 1, "reload fires after a successful write");
  assert.equal(config.mode, "confirm", "config reflects the change");
});

test("runSettingsWizard skips reload when a write is rejected", async () => {
  const config: CompassConfig = { ...DEFAULT_CONFIG } as CompassConfig;
  let reloads = 0;
  let picks = 0;

  const hooks: WizardHooks = {
    write() {
      return "mode: rejected in test";
    },
    reload() {
      reloads += 1;
    },
    async prompt() {
      return null;
    },
    async pick(_label, options) {
      picks += 1;
      if (picks === 1) return options.find((row) => row.startsWith("① 路由行為")) ?? null;
      if (picks === 2) return options.find((row) => row.startsWith("路由模式")) ?? null;
      if (picks === 3) return "auto — 自動切換";
      return null;
    },
  };

  await runSettingsWizard(config, hooks);
  assert.equal(reloads, 0, "a rejected write must not reload");
  assert.equal(config.mode, "notify", "config unchanged");
});