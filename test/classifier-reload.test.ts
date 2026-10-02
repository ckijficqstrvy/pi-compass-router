// test/classifier-reload.test.ts — reload 的分類器重建決策（SPEC Part 4.2、Part 11）。
//
// 驗的是：reload **不能**無條件殺分類器（改個預算就把載好的 laya 模型丟掉），
// 但 classify/taskKinds/modelPick 任一變動時必須重建並預熱。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifierInputsChanged,
  reloadClassifier,
} from "../extensions/pi-compass-router/classify/lifecycle.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig } from "../extensions/pi-compass-router/schema.js";

function config(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides } as CompassConfig;
}

/** 會記帳的假分類器（只看 dispose/warm 被叫幾次）。 */
interface Fake {
  disposals: number;
  warms: number;
  dispose?(): void;
  warm?(): void;
}

function fake(): Fake {
  return {
    disposals: 0,
    warms: 0,
    dispose() {
      this.disposals += 1;
    },
    warm() {
      this.warms += 1;
    },
  };
}

/** `taskKinds` 的變體：新增一個種類（用在「輸入變動」測試）。 */
const EXTRA_TASK_KINDS = {
  ...DEFAULT_CONFIG.taskKinds,
  triage: { label: "Triage", floor: 0.5 },
};

// ---------------------------------------------------------------------------
// 輸入比對：哪些設定變動要重建
// ---------------------------------------------------------------------------

test("路由/預算/政策類設定變動不算分類器輸入變動", () => {
  const base = config();
  const untouched = [
    config({ budget: { ...DEFAULT_CONFIG.budget, dailyUsd: 99 } }),
    config({ mode: "auto" }),
    config({ deny: ["openrouter/*"] }),
    config({ freeOnly: true }),
    config({ stickiness: false }),
    config({ routes: { ...DEFAULT_CONFIG.routes, quick: [] } }),
  ];
  for (const next of untouched) {
    assert.equal(classifierInputsChanged(base, next), false, JSON.stringify(next.budget.dailyUsd));
  }
});

test("classify 區塊的任一欄位變動都要重建", () => {
  const base = config();
  const variants: Array<[string, CompassConfig]> = [
    ["provider", config({ classify: { ...DEFAULT_CONFIG.classify, provider: "cloud" } })],
    ["model", config({ classify: { ...DEFAULT_CONFIG.classify, model: "other/checkpoint" } })],
    ["python", config({ classify: { ...DEFAULT_CONFIG.classify, python: "/usr/bin/python3" } })],
    ["timeoutMs", config({ classify: { ...DEFAULT_CONFIG.classify, timeoutMs: 5000 } })],
    ["cache", config({ classify: { ...DEFAULT_CONFIG.classify, cache: false } })],
    ["cacheTtlSeconds", config({ classify: { ...DEFAULT_CONFIG.classify, cacheTtlSeconds: 60 } })],
    [
      "cloud.provider",
      config({
        classify: { ...DEFAULT_CONFIG.classify, cloud: { provider: "other", model: "m" } },
      }),
    ],
    ["taskKinds", config({ taskKinds: EXTRA_TASK_KINDS })],
    ["modelPick", config({ modelPick: "menu" })],
  ];
  for (const [name, next] of variants) {
    assert.equal(classifierInputsChanged(base, next), true, name);
  }
});

test("沒有前一份設定（首次載入）= 要重建", () => {
  assert.equal(classifierInputsChanged(undefined, config()), true);
});

// ---------------------------------------------------------------------------
// reloadClassifier：保留 / 重建 / 預熱
// ---------------------------------------------------------------------------

test("輸入沒變 → 保留分類器：不 dispose、不 warm、不重建", () => {
  const original = fake();
  const state: { config: CompassConfig; classifier?: Fake } = { config: config(), classifier: original };
  const next = config({ budget: { ...DEFAULT_CONFIG.budget, dailyUsd: 42 } });

  let created = 0;
  const rebuilt = reloadClassifier(state, next, () => {
    created += 1;
    return fake();
  });

  assert.equal(rebuilt, false, "輸入沒變就不要重建");
  assert.equal(created, 0, "不該呼叫 factory");
  assert.equal(original.disposals, 0, "暖好的子行程不能被殺");
  assert.equal(original.warms, 0, "沒重建就不該重複預熱");
  assert.equal(state.classifier, original, "分類器實例不變");
  assert.equal(state.config.budget.dailyUsd, 42, "路由設定一律換成新值");
});

test("classify 變動 → dispose 舊的、重建、立刻預熱", () => {
  const original = fake();
  const replacement = fake();
  const state: { config: CompassConfig; classifier?: Fake } = { config: config(), classifier: original };
  const next = config({ classify: { ...DEFAULT_CONFIG.classify, model: "new/checkpoint" } });

  const rebuilt = reloadClassifier(state, next, () => replacement);

  assert.equal(rebuilt, true);
  assert.equal(original.disposals, 1, "舊分類器要拆");
  assert.equal(original.warms, 0);
  assert.equal(state.classifier, replacement);
  assert.equal(replacement.warms, 1, "重建後要預熱，否則第一次分類現載模型");
  assert.equal(replacement.disposals, 0);
});

test("沒有分類器（session 啟動）→ 建立並預熱，即使輸入沒變", () => {
  const state: { config: CompassConfig; classifier?: Fake } = { config: config() };
  const created = fake();

  const rebuilt = reloadClassifier(state, config(), () => created);

  assert.equal(rebuilt, true);
  assert.equal(state.classifier, created);
  assert.equal(created.warms, 1, "session 啟動的預熱行為要保留在這條路徑上");
});

test("未知後端（factory 回 undefined）→ 舊的拆掉、不建新的、也不炸", () => {
  const original = fake();
  const state: { config: CompassConfig; classifier?: Fake } = { config: config(), classifier: original };
  // provider 被改成 factory 不認得的值（laya/cloud 之外），比對先發現輸入變動。
  const next = config({
    classify: { ...DEFAULT_CONFIG.classify, provider: "mystery" as unknown as "laya" },
  });

  const rebuilt = reloadClassifier(state, next, () => undefined);

  assert.equal(rebuilt, true, "輸入變了就該動手");
  assert.equal(original.disposals, 1, "舊分類器要拆");
  assert.equal(state.classifier, undefined, "沒建新的也不留舊的");
});
