import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STATE_FILE,
  computePressure,
  loadSpend,
  recordSpend,
} from "../extensions/pi-compass-router/budget.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig } from "../extensions/pi-compass-router/schema.js";

function config(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget }, ...overrides } as CompassConfig;
}

function tempLedgerDir(): { stateFile: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "compass-ledger-"));
  return { stateFile: join(dir, "state.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// 壓力公式（Part 8）
// ---------------------------------------------------------------------------

test("pressure is max(today/daily, month/monthly)", () => {
  const cfg = config({ budget: { dailyUsd: 5, monthlyUsd: 100, softRatio: 0.7, hardRatio: 0.9 } });
  assert.equal(computePressure({ todayUsd: 2.5, monthUsd: 10 }, cfg), 0.5);
  // daily 維度更高
  assert.equal(computePressure({ todayUsd: 4.5, monthUsd: 10 }, cfg), 0.9);
  // monthly 維度更高
  assert.ok(computePressure({ todayUsd: 1, monthUsd: 95 }, cfg) > 0.9);
});

test("a null or zero cap removes that dimension", () => {
  const noDaily = config({ budget: { dailyUsd: null, monthlyUsd: 100, softRatio: 0.7, hardRatio: 0.9 } });
  assert.equal(computePressure({ todayUsd: 9999, monthUsd: 0 }, noDaily), 0);

  const zeroDaily = config({ budget: { dailyUsd: 0, monthlyUsd: 100, softRatio: 0.7, hardRatio: 0.9 } });
  assert.equal(computePressure({ todayUsd: 9999, monthUsd: 0 }, zeroDaily), 0);
});

test("no caps at all means zero pressure", () => {
  const uncapped = config({ budget: { dailyUsd: null, monthlyUsd: null, softRatio: 0.7, hardRatio: 0.9 } });
  assert.equal(computePressure({ todayUsd: 1e9, monthUsd: 1e9 }, uncapped), 0);
});

test("zero spend means zero pressure under any cap", () => {
  assert.equal(computePressure({ todayUsd: 0, monthUsd: 0 }, config()), 0);
});

// ---------------------------------------------------------------------------
// 記帳（state.json）
// ---------------------------------------------------------------------------

test("recordSpend accumulates and loadSpend reads it back", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    const at = new Date("2026-10-01T12:00:00Z");
    recordSpend(0.25, at, stateFile);
    recordSpend(0.5, at, stateFile);
    const spend = loadSpend(at, stateFile);
    assert.ok(Math.abs(spend.todayUsd - 0.75) < 1e-9);
    assert.ok(Math.abs(spend.monthUsd - 0.75) < 1e-9);
  } finally {
    cleanup();
  }
});

test("the ledger is created with mode 0600", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    recordSpend(0.1, new Date("2026-10-01T12:00:00Z"), stateFile);
    assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test("a UTC day rollover resets the daily total but keeps the monthly one", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    recordSpend(1, new Date("2026-10-01T23:59:00Z"), stateFile);
    assert.equal(loadSpend(new Date("2026-10-01T23:59:30Z"), stateFile).todayUsd, 1);

    const nextDay = new Date("2026-10-02T00:01:00Z");
    const spend = loadSpend(nextDay, stateFile);
    assert.equal(spend.todayUsd, 0, "the UTC day rolled over");
    assert.equal(spend.monthUsd, 1, "same month, so the monthly total survives");

    recordSpend(0.5, nextDay, stateFile);
    const after = loadSpend(nextDay, stateFile);
    assert.equal(after.todayUsd, 0.5);
    assert.equal(after.monthUsd, 1.5);
  } finally {
    cleanup();
  }
});

test("a UTC month rollover resets both dimensions", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    recordSpend(3, new Date("2026-10-31T23:59:00Z"), stateFile);
    const spend = loadSpend(new Date("2026-11-01T00:01:00Z"), stateFile);
    assert.equal(spend.todayUsd, 0);
    assert.equal(spend.monthUsd, 0);
  } finally {
    cleanup();
  }
});

test("non-positive and non-finite amounts are ignored without writing", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    recordSpend(0, new Date(), stateFile);
    recordSpend(-5, new Date(), stateFile);
    recordSpend(Number.NaN, new Date(), stateFile);
    recordSpend(Number.POSITIVE_INFINITY, new Date(), stateFile);
    assert.deepEqual(loadSpend(new Date(), stateFile), { todayUsd: 0, monthUsd: 0 });
  } finally {
    cleanup();
  }
});

test("a corrupt ledger degrades to zero instead of throwing", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    writeFileSync(stateFile, "{ not json at all");
    assert.deepEqual(loadSpend(new Date(), stateFile), { todayUsd: 0, monthUsd: 0 });
    // 記一筆仍可進行
    recordSpend(1, new Date(), stateFile);
    assert.equal(loadSpend(new Date(), stateFile).todayUsd, 1);
  } finally {
    cleanup();
  }
});

test("a ledger whose day stamp is stale does not leak into today", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    mkdirSync(join(stateFile, ".."), { recursive: true });
    writeFileSync(
      stateFile,
      JSON.stringify({ day: "2020-01-01", todayUsd: 500, month: "2020-01", monthUsd: 500 }),
    );
    const spend = loadSpend(new Date("2026-10-01T12:00:00Z"), stateFile);
    assert.equal(spend.todayUsd, 0, "a stale day stamp must not be trusted");
    assert.equal(spend.monthUsd, 0, "a stale month stamp must not be trusted");
  } finally {
    cleanup();
  }
});

test("an unreadable path never throws", () => {
  const { stateFile, cleanup } = tempLedgerDir();
  try {
    // 目錄本身當成檔案 → JSON.parse 讀取失敗，應回零且不拋。
    mkdirSync(stateFile, { recursive: true });
    assert.deepEqual(loadSpend(new Date(), stateFile), { todayUsd: 0, monthUsd: 0 });
    assert.doesNotThrow(() => recordSpend(1, new Date(), stateFile));
  } finally {
    cleanup();
  }
});

test("STATE_FILE is fixed under ~/.pi/agent/pi-compass", () => {
  assert.ok(STATE_FILE.endsWith(join(".pi", "agent", "pi-compass", "state.json")));
  assert.ok(readFileSync, "readFileSync is available");
});
// ---------------------------------------------------------------------------
// 併發安全（2026-10-03）：讀-改-寫互斥 + 原子寫
// ---------------------------------------------------------------------------

test("recordSpend serialises through a lock dir and never leaves it behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-budget-lock-"));
  const file = join(dir, "state.json");
  try {
    recordSpend(1, new Date(), file);
    recordSpend(2, new Date(), file);
    const snapshot = loadSpend(new Date(), file);
    assert.equal(snapshot.todayUsd, 3, "both writes accumulate");
    assert.ok(!existsSync(`${file}.lock`), "lock is released");
    assert.ok(!readdirSync(dir).some((name) => name.includes(".tmp-")), "no temp file left behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh foreign lock does not make recordSpend throw (best-effort)", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-budget-held-"));
  const file = join(dir, "state.json");
  try {
    mkdirSync(`${file}.lock`);
    assert.doesNotThrow(() => recordSpend(1, new Date(), file));
    // 別人的鎖不該被我們拿掉。
    assert.ok(existsSync(`${file}.lock`), "fresh foreign lock is respected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stale lock is reclaimed so accounting resumes", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-budget-stale-"));
  const file = join(dir, "state.json");
  try {
    mkdirSync(`${file}.lock`);
    // 把鎖目錄 mtime 調老（> 2s），模擬持有者已死。
    const old = new Date(Date.now() - 10_000);
    utimesSync(`${file}.lock`, old, old);
    recordSpend(4, new Date(), file);
    assert.equal(loadSpend(new Date(), file).todayUsd, 4, "stale lock reclaimed and write landed");
    assert.ok(!existsSync(`${file}.lock`), "released after use");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
