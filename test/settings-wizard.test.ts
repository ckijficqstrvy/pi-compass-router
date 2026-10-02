// test/settings-wizard.test.ts — /compass-set 選單流程（SPEC Part 10.2）。
//
// 驗 2026-10-02 分組重構後的三條鐵律：
//   1. 能枚舉的設定一律走 `pick`（選的），打字只出現在「自訂…」；
//   2. 寫進去要能清（patch `null` = 刪子鍵：改回自動／清除 prefer 等）；
//   3. 看得見誰決定（鏈的來源標記、看鏈的來源診斷）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CUSTOM_OPTION,
  factsAgeDays,
  profileFromLabel,
  profileLabel,
  providerFromLabel,
  providerLabel,
  runSettingsWizard,
  thinkingFromLabel,
  thinkingLabel,
  tierFromLabel,
  tierLabel,
  type CandidateKind,
  type WizardHooks,
} from "../extensions/pi-compass-router/ui/wizard.js";
import { cloudClassifierKeys, localCheckpoints, openRouterModelKeys } from "../extensions/pi-compass-router/ui/sources.js";
import { DEFAULT_CONFIG, TIERS } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig, ThinkingLevel } from "../extensions/pi-compass-router/schema.js";

// ---------------------------------------------------------------------------
// 腳本化 hooks：主選單與組內選單都以 `menu` 依序消費（前綴比對）；
// `answers` 依 label（前綴）回選項（字串或函式）；`inputs` 依序回打字輸入。
// ---------------------------------------------------------------------------

type Answer = string | ((options: string[]) => string);

interface Script {
  /** 選單要選的列前綴，依序消費（主選單 → 組 → 項目）；耗盡 = Esc。 */
  menu?: string[];
  /** 子選單 label（前綴比對）→ 要回的選項。 */
  answers?: Record<string, Answer>;
  /** 打字輸入 label（前綴）→ 依序輸入；耗盡 = Esc（取消）。 */
  inputs?: Record<string, string[]>;
  candidates?: Partial<Record<CandidateKind, string[]>>;
  /** `write()` 回的拒絕訊息（非 null = 拒絕）。 */
  reject?: string;
  /** `reload()` 回的新設定物件（undefined = 就地套用）。 */
  fresh?: CompassConfig;
  /** `probeClassifier()` 的回應。 */
  probe?: string;
}

interface Scripted {
  hooks: WizardHooks;
  writes: Array<[string, unknown]>;
  notices: string[];
  stats: { reloads: number; prompts: number; picks: number };
  /** 每次選單 pick 的 label。 */
  pickLabels: string[];
  /** 每個選單 label 最後一次看到的列（主選單與組內選單分開存）。 */
  rowsSeen: Record<string, string[]>;
  /** 最近一次「選單類」pick 看到的列。 */
  lastRows: string[];
}

/** 主選單與組內選單都是「選單類」pick：都由 `menu` 依序驅動。 */
function isMenuPick(label: string): boolean {
  return label.startsWith("compass 設定") || label.endsWith("：選一項");
}

function scripted(script: Script = {}): Scripted {
  const menu = [...(script.menu ?? [])];
  const answers: Record<string, Answer> = { ...(script.answers ?? {}) };
  const inputs: Record<string, string[]> = { ...(script.inputs ?? {}) };
  const writes: Array<[string, unknown]> = [];
  const notices: string[] = [];
  const stats = { reloads: 0, prompts: 0, picks: 0 };
  const pickLabels: string[] = [];
  const lastRows: string[] = [];
  const rowsSeen: Record<string, string[]> = {};

  const keyOf = (map: Record<string, unknown>, label: string): string | undefined =>
    Object.keys(map).find((key) => label.startsWith(key));

  const hooks: WizardHooks = {
    write(key, value) {
      if (script.reject) return script.reject;
      writes.push([key, value]);
      return null;
    },
    reload() {
      stats.reloads += 1;
      return script.fresh;
    },
    async pick(label, options) {
      stats.picks += 1;
      pickLabels.push(label);
      if (isMenuPick(label)) {
        lastRows.splice(0, lastRows.length, ...options);
        rowsSeen[label] = [...options];
        if (menu.length === 0) return null;
        const entry = menu[0];
        const hit = options.find((row) => row.startsWith(entry));
        if (hit === undefined) return null; // 沒這列 → 當作取消（避免無限迴圈）
        menu.shift();
        return hit;
      }
      const key = keyOf(answers, label);
      if (key === undefined) return null;
      const answer = answers[key];
      // 函式型 answer 可重複呼叫（搜尋→再選會對同一 label 連續問）；字串型用掉即棄。
      if (typeof answer !== "function") delete answers[key];
      return typeof answer === "function" ? answer(options) : answer;
    },
    async prompt(label) {
      stats.prompts += 1;
      const key = keyOf(inputs, label);
      if (key === undefined) return null;
      const queue = inputs[key];
      if (queue.length === 0) return null;
      return queue.shift() as string;
    },
    candidates: (kind) => script.candidates?.[kind] ?? [],
    notify: (message) => {
      notices.push(message);
    },
    probeClassifier: script.probe === undefined ? undefined : () => script.probe as string,
  };

  return { hooks, writes, notices, stats, pickLabels, rowsSeen, lastRows };
}

/** 每個測試都從乾淨的 DEFAULT_CONFIG 深拷貝出發（不污染共用預設值）。 */
function freshConfig(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...overrides } as CompassConfig;
}

// ---------------------------------------------------------------------------
// 值 ↔ 標籤往返
// ---------------------------------------------------------------------------

test("modeLabel/tierLabel/profileLabel/thinkingLabel 標籤往返一致", () => {
  for (const tier of TIERS) {
    assert.equal(tierFromLabel(tierLabel(tier)), tier, `${tier} round-trip`);
  }
  for (const profile of ["cheap", "balanced", "quality"] as const) {
    assert.equal(profileFromLabel(profileLabel(profile)), profile, `${profile} round-trip`);
  }
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]) {
    assert.equal(thinkingFromLabel(thinkingLabel(level)), level, `${level} round-trip`);
  }
  assert.equal(tierFromLabel("沒有這個層級"), null);
  assert.equal(thinkingFromLabel("沒有這個層級"), null);
});

test("分類後端的 cloud 代號也要有標籤往返（不露裸代號）", () => {
  assert.equal(providerFromLabel(providerLabel("cloud")), "cloud");
  assert.notEqual(providerLabel("cloud"), "cloud", "選單上不該直接看到代號");
});

// ---------------------------------------------------------------------------
// 分組導航
// ---------------------------------------------------------------------------

test("主選單是七個分組列，各列帶狀態摘要", async () => {
  const config = freshConfig();
  const s = scripted({ menu: [] }); // 只看主選單
  await runSettingsWizard(config, s.hooks);

  const main = Object.entries(s.rowsSeen).find(([label]) => label.startsWith("compass 設定"))?.[1] ?? [];
  assert.equal(main.length, 8, "七組 + 結束");
  assert.ok(main[0].startsWith("① 路由行為"), main[0]);
  assert.ok(main[2].includes("自動"), `③ 標列要帶來源摘要：${main[2]}`);
  assert.ok(main[2].includes("專家 10 種"), main[2]);
  assert.ok(main[5].startsWith("⑥ 顯示與呈現"), main[5]);
  assert.equal(main[7], "結束");
});

test("組內選單列顯示目前值，項目靠列前綴認列", async () => {
  const config = freshConfig();
  const s = scripted({ menu: ["④ 分類器"] });
  await runSettingsWizard(config, s.hooks);

  const rows = s.rowsSeen["④ 分類器：選一項"] ?? [];
  assert.ok(
    rows.some((row) => row.startsWith("分類模型 …… laya · aac6fef/laya-multilingual-mlx")),
    `項目列帶目前值：${rows.join(" | ")}`,
  );
  assert.equal(rows[rows.length - 1], "← 返回");
});

test("cloud 後端：組內列顯示 cloud 的分類模型", async () => {
  const config = freshConfig({ classify: { ...DEFAULT_CONFIG.classify, provider: "cloud" } });
  const s = scripted({ menu: ["④ 分類器"] });
  await runSettingsWizard(config, s.hooks);

  const rows = s.rowsSeen["④ 分類器：選一項"] ?? [];
  assert.ok(
    rows.some((row) => row.startsWith("分類模型 …… cloud · typesafe/jev-latest")),
    `cloud 後端要顯示 cloud 的值，實際：${rows.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// ② 預算：選的金額、警戒線
// ---------------------------------------------------------------------------

test("預設金額是選的：選 $20 直接寫入，不出現打字輸入", async () => {
  const config = freshConfig();
  const s = scripted({ menu: ["② 預算與花費", "每日上限"], answers: { 每日上限: "$20.00" } });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.prompts, 0, "全程不該打字");
  assert.deepEqual(s.writes[0], ["budget", { dailyUsd: 20 }], "只寫被改的維度（patch 非覆寫）");
  assert.equal(s.stats.reloads, 1);
  assert.equal(config.budget.dailyUsd, 20);
});

test("自訂金額：輸入無效要回饋並重問，不是靜默吞掉", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["② 預算與花費", "每月上限"],
    answers: { 每月上限: CUSTOM_OPTION },
    inputs: { 每月上限: ["nonsense", "$7.5"] },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.prompts, 2, "壞輸入要重問一次");
  assert.equal(
    s.notices.filter((message) => message.includes("不是有效金額")).length,
    1,
    "要告訴使用者錯在哪",
  );
  assert.ok(s.notices.some((message) => message.includes("已寫入")), "成功後有回饋");
  assert.deepEqual(s.writes[0][1], { monthlyUsd: 7.5 });
});

test("自訂金額按 Esc：取消不寫檔也不重載", async () => {
  const config = freshConfig();
  const s = scripted({ menu: ["② 預算與花費", "每日上限"], answers: { 每日上限: CUSTOM_OPTION } });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.writes.length, 0);
  assert.equal(s.stats.reloads, 0);
});

test("預算警戒線：softRatio/hardRatio 用選的", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["② 預算與花費", "預算警戒線"],
    answers: {
      "預算警戒線：選欄位": (options) => options.find((row) => row.startsWith("強制線")) as string,
      強制線: "0.8",
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.prompts, 0);
  assert.deepEqual(s.writes[0], ["budget", { hardRatio: 0.8 }]);
  assert.equal(config.budget.hardRatio, 0.8);
  assert.equal(config.budget.softRatio, 0.7, "軟警戒線不受影響");
});

// ---------------------------------------------------------------------------
// ③ 模型：鏈編輯（選的）、改回自動、prefer、專家鏈
// ---------------------------------------------------------------------------

test("模型鏈：設為首選走候選清單，只寫被改的那一層", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["③ 模型與層級", "模型鏈"],
    answers: {
      "模型鏈：選層級": (options) => options.find((row) => row.startsWith("quick")) as string,
      "quick 鏈 · 目前": "設為首選…",
      "quick 鏈：選首選模型": (options) => options.find((row) => row.includes("deepseek")) as string,
    },
    candidates: { model: ["openrouter/does-not-matter"] },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.prompts, 0, "有候選就不打字");
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0][0], "routes");
  const patch = s.writes[0][1] as Record<string, unknown[]>;
  assert.deepEqual(Object.keys(patch), ["quick"], "只寫 quick，其他層不動");
  const chain = patch.quick as Array<{ model: string; explicit?: boolean }>;
  assert.equal(chain[0].model, "deepseek/deepseek-v4-flash", "選到的排到鏈首");
  assert.equal(chain.length, 3, "去重不增生");
  assert.ok(chain.every((target) => target.explicit === true), "寫入的條目標顯式");
});

test("模型鏈：改回自動（清除你寫的）→ patch null 刪整層", async () => {
  const config = freshConfig({
    routes: {
      ...DEFAULT_CONFIG.routes,
      quick: [{ provider: "openrouter", model: "my/pinned", explicit: true }],
    },
  });
  const s = scripted({
    menu: ["③ 模型與層級", "模型鏈"],
    answers: {
      "模型鏈：選層級": (options) => options.find((row) => row.startsWith("quick")) as string,
      "quick 鏈 · 目前": "改回自動（清除你寫的）",
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.deepEqual(s.writes[0], ["routes", { quick: null }], "null = 刪子鍵（回自動派生）");
  assert.ok(
    config.routes.quick.every((target) => !target.explicit),
    "就地反映的鏈不再标显式",
  );
});

test("模型鏈：移除最後一個會被擋下（空鏈不可寫），回饋原因且不落檔", async () => {
  const config = freshConfig(); // xpremium 只有一個模型
  const s = scripted({
    menu: ["③ 模型與層級", "模型鏈"],
    answers: {
      "模型鏈：選層級": (options) => options.find((row) => row.startsWith("xpremium")) as string,
      "xpremium 鏈 · 目前": "移除一個模型…",
      "xpremium 鏈：移除哪一個？": (options) => options[0],
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.writes.length, 0);
  assert.equal(s.stats.reloads, 0);
  assert.equal(s.notices.length, 1);
  assert.match(s.notices[0], /鏈不能是空的/);
});

test("模型鏈：沒有候選來源時用「自訂整條字串…」才打字", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["③ 模型與層級", "模型鏈"],
    answers: {
      "模型鏈：選層級": (options) => options.find((row) => row.startsWith("standard")) as string,
      "standard 鏈 · 目前": "自訂整條字串…",
    },
    inputs: { "standard 鏈": ["openrouter/a, openrouter/b"] },
    candidates: {},
  });

  await runSettingsWizard(config, s.hooks);

  const patch = s.writes[0][1] as Record<string, unknown[]>;
  assert.equal(patch.standard.length, 2);
});

test("prefer 首選：設定與清除（null）", async () => {
  const config = freshConfig();
  const set = scripted({
    menu: ["③ 模型與層級", "prefer 首選"],
    answers: {
      "prefer 首選：選層級": (options) => options.find((row) => row.startsWith("quick")) as string,
      "quick 的偏好首選": "openrouter/xiaomi/mimo-v2.6-flash",
    },
    candidates: { model: ["openrouter/xiaomi/mimo-v2.6-flash"] },
  });
  await runSettingsWizard(config, set.hooks);
  assert.deepEqual(set.writes[0], ["prefer", { quick: ["openrouter/xiaomi/mimo-v2.6-flash"] }]);

  const clear = scripted({
    menu: ["③ 模型與層級", "prefer 首選"],
    answers: {
      "prefer 首選：選層級": (options) => options.find((row) => row.startsWith("quick")) as string,
      "quick 的偏好首選": "清除（回預設／自動）",
    },
  });
  await runSettingsWizard(config, clear.hooks);
  assert.deepEqual(clear.writes[0], ["prefer", { quick: null }], "null = 清除");
});

test("專家鏈：設為首選與改回層級鏈", async () => {
  const config = freshConfig();
  const set = scripted({
    menu: ["③ 模型與層級", "專家鏈"],
    answers: {
      "專家鏈：選任務種類": (options) => options.find((row) => row.startsWith("plan")) as string,
      "plan 鏈 · 目前": "設為首選…",
      "plan 鏈：選首選模型": (options) => options.find((row) => row.includes("gpt-6-sol")) as string,
    },
    candidates: { model: ["openrouter/openai/gpt-6-sol"] },
  });
  await runSettingsWizard(config, set.hooks);
  assert.equal(set.writes[0][0], "kindModels");
  const patch = set.writes[0][1] as Record<string, unknown[]>;
  assert.deepEqual(Object.keys(patch), ["plan"]);
  assert.equal(config.kindModels.plan[0].model, "openai/gpt-6-sol", "選到的排到專家鏈首");
  assert.equal(config.kindModels.plan.length, 2, "原有專家（含 minTier）保留");

  const clear = scripted({
    menu: ["③ 模型與層級", "專家鏈"],
    answers: {
      "專家鏈：選任務種類": (options) => options.find((row) => row.startsWith("plan")) as string,
      "plan 鏈 · 目前": "改回自動（清除你寫的）",
    },
  });
  await runSettingsWizard(config, clear.hooks);
  assert.deepEqual(clear.writes[0], ["kindModels", { plan: null }]);
});

test("任務最低層級：先選種類再選層級，兩段都是選的", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["③ 模型與層級", "任務最低層級"],
    answers: {
      "任務最低層級：選種類": (options) => options.find((row) => row.startsWith("plan")) as string,
      "plan 的最低層級": tierLabel("standard"),
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.prompts, 0);
  assert.deepEqual(s.writes[0], ["kindMinimumTier", { plan: "standard" }]);
  assert.equal(config.kindMinimumTier.plan, "standard");
  assert.equal(config.kindMinimumTier.chat, "quick", "其他種類不受影響");
});

// ---------------------------------------------------------------------------
// ④ 分類器
// ---------------------------------------------------------------------------

test("Laya checkpoint：有候選就用選的", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["④ 分類器", "分類模型"],
    answers: { "Laya checkpoint": (options) => options.find((row) => row === "other/checkpoint") as string },
    candidates: { checkpoint: ["other/checkpoint"] },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.prompts, 0);
  assert.deepEqual(s.writes[0], ["classify", { model: "other/checkpoint" }]);
});

test("Laya checkpoint：候選來源空 → 仍用選的（預設當種子），選「自訂…」才打字", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["④ 分類器", "分類模型"],
    answers: { "Laya checkpoint": CUSTOM_OPTION },
    inputs: { "Laya checkpoint": ["~/models/my-checkpoint"] },
    candidates: { checkpoint: [] },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(
    s.pickLabels.some((label) => label === "Laya checkpoint"),
    true,
    "候選來源空也還是一個選單（內建預設當種子），不是直接把你丟去打字",
  );
  assert.equal(s.stats.prompts, 1, "打字只出現在「自訂…」之後");
  assert.deepEqual(s.writes[0], ["classify", { model: "~/models/my-checkpoint" }]);
});

test("cloud 分類模型寫進 classify.cloud，laya checkpoint 不被改到", async () => {
  const config = freshConfig({ classify: { ...DEFAULT_CONFIG.classify, provider: "cloud" } });
  const s = scripted({
    menu: ["④ 分類器", "分類模型"],
    answers: { "分類模型（cloud）": "typesafe/other-model" },
    candidates: { classifier: ["typesafe/other-model"] },
  });

  await runSettingsWizard(config, s.hooks);

  assert.deepEqual(s.writes[0], ["classify", { cloud: { provider: "typesafe", model: "other-model" } }]);
  assert.equal(config.classify.cloud.model, "other-model");
  assert.equal(config.classify.model, DEFAULT_CONFIG.classify.model);
});

test("分類後端：選項講清楚用哪個分類器，並帶 cloud 目前的模型", async () => {
  const config = freshConfig();
  let seen: string[] = [];
  const s = scripted({
    menu: ["④ 分類器", "分類後端"],
    answers: {
      分類後端: (options) => {
        seen = options;
        return options.find((row) => row.startsWith("cloud")) as string;
      },
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(seen.length, 2, "兩種後端都在畫面上");
  assert.ok(seen.some((row) => row.includes("Laya-MLX")), `laya 標籤：${seen.join(" | ")}`);
  assert.ok(seen.some((row) => row.includes("typesafe/jev-latest")), `cloud 標籤要帶分類器模型：${seen.join(" | ")}`);
  assert.deepEqual(s.writes[0], ["classify", { provider: "cloud" }]);
});

test("分類快取：秒數用選的，只寫被改的欄位", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["④ 分類器", "分類快取"],
    answers: { "分類快取：選欄位": "快取秒數（TTL）— 300s", "分類快取秒數（TTL）": "600" },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.prompts, 0, "秒數是選的");
  assert.deepEqual(s.writes[0], ["classify", { cacheTtlSeconds: 600 }]);
  assert.equal(config.classify.cacheTtlSeconds, 600);
  assert.equal(config.classify.cache, true, "其他欄位不受影響");
});

test("分類參數：timeoutMs 用選的", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["④ 分類器", "分類參數"],
    answers: {
      "分類參數：選欄位": (options) => options.find((row) => row.startsWith("分類逾時")) as string,
      分類逾時: "1200",
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.deepEqual(s.writes[0], ["classify", { timeoutMs: 1200 }]);
  assert.equal(config.classify.timeoutMs, 1200);
});

// ---------------------------------------------------------------------------
// ① 路由 / ⑤ 政策
// ---------------------------------------------------------------------------

test("切換冷卻秒數：選單裡有更多可選秒數（不只 0↔300）", async () => {
  const config = freshConfig({ cache: { ...DEFAULT_CONFIG.cache, cooldownSeconds: 300 } });
  let seen: string[] = [];
  const s = scripted({
    menu: ["① 路由行為", "切換成本 cache"],
    answers: {
      "切換成本 cache：選欄位": "冷卻秒數 — 300s",
      冷卻秒數: (options) => {
        seen = options;
        return "120";
      },
    },
  });

  await runSettingsWizard(config, s.hooks);

  for (const seconds of ["0", "30", "120", "600"]) {
    assert.ok(seen.includes(seconds), `候選要有 ${seconds}s：${seen.join(", ")}`);
  }
  assert.deepEqual(s.writes[0], ["cache", { cooldownSeconds: 120 }]);
});

test("粘住當前模型：單項直接切換", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["① 路由行為", "粘住當前模型"],
    answers: { 粘住當前模型: "關" },
  });

  await runSettingsWizard(config, s.hooks);

  assert.deepEqual(s.writes[0], ["stickiness", false]);
  assert.equal(config.stickiness, false);
});

test("思考層級：pin 設定與清除（null）", async () => {
  const config = freshConfig();
  const set = scripted({
    menu: ["① 路由行為", "思考層級"],
    answers: {
      "思考層級：選範圍": (options) => options[0], // pin（全域覆蓋）
      "pin 的思考層級": thinkingLabel("high"),
    },
  });
  await runSettingsWizard(config, set.hooks);
  assert.deepEqual(set.writes[0], ["thinking", { pin: "high" }]);

  const clear = scripted({
    menu: ["① 路由行為", "思考層級"],
    answers: {
      "思考層級：選範圍": (options) => options[0],
      "pin 的思考層級": "清除（回預設／自動）",
    },
  });
  await runSettingsWizard(config, clear.hooks);
  assert.deepEqual(clear.writes[0], ["thinking", { pin: null }], "null = 清除 pin");
});

test("價格 profile：三種定義（每層天花板）直接印在選項上", async () => {
  const config = freshConfig();
  let seen: string[] = [];
  const s = scripted({
    menu: ["② 預算與花費", "價格 profile"],
    answers: {
      價格: (options) => {
        seen = options;
        return options.find((row) => row.startsWith("balanced")) as string;
      },
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(seen.length, 3, "三種定義同畫面");
  assert.ok(seen[0].includes("quick $1") && seen[0].includes("xpremium $50"), seen[0]);
  assert.ok(seen[1].includes("premium $44") && seen[1].includes("xpremium ∞"), seen[1]);
  assert.ok(seen[2].includes("premium ∞") && seen[2].includes("quality"), seen[2]);
  assert.deepEqual(s.writes[0], ["profile", "balanced"]);
});

test("價格天花板：自訂與清除（回 profile）", async () => {
  const config = freshConfig();
  const set = scripted({
    menu: ["⑤ 政策與過濾", "價格天花板"],
    answers: {
      "價格天花板：選層級": (options) => options.find((row) => row.startsWith("quick")) as string,
      "quick 的天花板": "1.5",
    },
  });
  await runSettingsWizard(config, set.hooks);
  assert.deepEqual(set.writes[0], ["ceilings", { quick: 1.5 }]);
  assert.equal(config.ceilings.quick, 1.5);

  const clear = scripted({
    menu: ["⑤ 政策與過濾", "價格天花板"],
    answers: {
      "價格天花板：選層級": (options) => options.find((row) => row.startsWith("quick")) as string,
      "quick 的天花板": "依 profile（清除自訂）",
    },
  });
  await runSettingsWizard(config, clear.hooks);
  assert.deepEqual(clear.writes[0], ["ceilings", { quick: null }], "null = 清除");
});

test("過濾規則：deny 清單切換（✓ 標記），只寫被改的清單", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["⑤ 政策與過濾", "過濾規則"],
    answers: {
      "過濾規則：選一份清單": (options) => options.find((row) => row.startsWith("deny")) as string,
      "deny：選一項切換": (options) => options.find((row) => row.includes("openrouter/~z-ai/glm-latest")) as string,
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.deepEqual(s.writes[0], ["deny", ["openrouter/~z-ai/glm-latest"]]);
});

// ---------------------------------------------------------------------------
// ⑦ 重設・診斷
// ---------------------------------------------------------------------------

test("重設：選鍵 → 確認 → 寫回 DEFAULT 值", async () => {
  const config = freshConfig({ mode: "auto", budget: { ...DEFAULT_CONFIG.budget, dailyUsd: 999 } });
  const s = scripted({
    menu: ["⑦ 重設・診斷", "重設"],
    answers: { "重設哪一項": (options) => options.find((row) => row.startsWith("budget")) as string, "重設 budget 回預設？": "確定，重設" },
  });

  await runSettingsWizard(config, s.hooks);

  assert.deepEqual(s.writes[0], ["budget", DEFAULT_CONFIG.budget]);
  assert.deepEqual(config.budget, DEFAULT_CONFIG.budget);
  assert.equal(config.mode, "auto", "沒選到的鍵不動");
});

test("重設：選「取消」就不寫檔", async () => {
  const config = freshConfig({ mode: "auto" });
  const s = scripted({
    menu: ["⑦ 重設・診斷", "重設"],
    answers: { "重設哪一項": (options) => options.find((row) => row.startsWith("mode")) as string, "重設 mode 回預設？": "取消" },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.writes.length, 0);
  assert.equal(config.mode, "auto");
});

test("看鏈的來源：標出你寫的 vs 自動派生", async () => {
  const config = freshConfig({
    routes: {
      ...DEFAULT_CONFIG.routes,
      quick: [
        { provider: "openrouter", model: "my/pinned", explicit: true },
        { provider: "openrouter", model: "derived/one" },
      ],
    },
  });
  const s = scripted({
    menu: ["⑦ 重設・診斷", "看鏈的來源"],
    answers: { "看鏈的來源：選層級": (options) => options.find((row) => row.startsWith("quick")) as string },
  });

  await runSettingsWizard(config, s.hooks);

  const report = s.notices.join("\n");
  assert.match(report, /my\/pinned — 你寫的/);
  assert.match(report, /derived\/one — 自動派生/);
  assert.match(report, /事實檔 \d{4}-\d{2}-\d{2}/);
  assert.equal(s.writes.length, 0, "診斷不寫檔");
});

test("測試分類器：有掛點跑一輪，沒掛點明說", async () => {
  const withHook = scripted({ menu: ["⑦ 重設・診斷", "測試分類器"], probe: "laya 21ms · kind chat 95% · cache miss" });
  await runSettingsWizard(freshConfig(), withHook.hooks);
  assert.match(withHook.notices.join("\n"), /laya 21ms · kind chat 95%/);

  const withoutHook = scripted({ menu: ["⑦ 重設・診斷", "測試分類器"] });
  await runSettingsWizard(freshConfig(), withoutHook.hooks);
  assert.match(withoutHook.notices.join("\n"), /不支援測試分類器/);
});

// ---------------------------------------------------------------------------
// ⑥ 顯示與呈現
// ---------------------------------------------------------------------------

test("顯示：呈現密度寫 display patch（只帶被改的子鍵）", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["⑥ 顯示與呈現", "呈現密度"],
    answers: { "呈現密度（目前：standard）": "full — 直接攤開明細" },
  });

  await runSettingsWizard(config, s.hooks);

  assert.deepEqual(s.writes[0], ["display", { detail: "full" }]);
  assert.equal(config.display.detail, "full", "活設定反映編輯");
  assert.equal(config.display.badge, true, "沒動的子鍵不變");
});

test("顯示：收合列欄位 toggle 迴圈，完成才一次落檔", async () => {
  const config = freshConfig();
  let calls = 0;
  const s = scripted({
    menu: ["⑥ 顯示與呈現", "收合列欄位"],
    answers: {
      "收合列欄位：選一項切換": (options) => {
        calls += 1;
        return calls === 1
          ? (options.find((row) => row === "✓ demand") as string)
          : (options.find((row) => row.startsWith("←")) as string);
      },
    },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.writes.length, 1, "完成才寫一次");
  assert.deepEqual(s.writes[0], [
    "display",
    { fields: ["kind", "thinking", "classify", "budget", "reason", "notes"] },
  ]);
});

test("顯示：欄位 toggle 沒動就不寫檔", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["⑥ 顯示與呈現", "收合列欄位"],
    answers: { "收合列欄位：選一項切換": (options) => options.find((row) => row.startsWith("←")) as string },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.writes.length, 0, "無變更 → 取消");
});

// ---------------------------------------------------------------------------
// 寫入被拒 / reload 回新物件
// ---------------------------------------------------------------------------

test("寫入被拒：顯示原因、不重載、不就地改設定", async () => {
  const config = freshConfig();
  const s = scripted({
    menu: ["① 路由行為", "路由模式"],
    answers: { 路由模式: "auto — 自動切換" },
    reject: "mode: rejected in test",
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(s.stats.reloads, 0);
  assert.equal(config.mode, DEFAULT_CONFIG.mode);
  assert.equal(s.notices.length, 1);
  assert.match(s.notices[0], /未寫入：mode: rejected in test/);
});

test("reload 回新設定物件時，選單改畫新物件", async () => {
  const oldConfig = freshConfig(); // budget.dailyUsd = 5
  const fresh = freshConfig({ budget: { ...DEFAULT_CONFIG.budget, monthlyUsd: 42 } });
  const s = scripted({
    menu: ["② 預算與花費", "每日上限", "每月上限"],
    answers: { 每日上限: "$1.00" },
    fresh,
  });

  await runSettingsWizard(oldConfig, s.hooks);

  const rows = s.rowsSeen["② 預算與花費：選一項"] ?? [];
  assert.ok(rows.some((row) => row.startsWith("每日上限 …… $1.00")), `本輪的寫入要反映在行上：${rows.join(" | ")}`);
  assert.ok(rows.some((row) => row.startsWith("每月上限 …… $42.00")), "reload 回的新物件要被接住");
  assert.equal(oldConfig.budget.dailyUsd, 5, "舊物件不再被畫（也不該被改）");
});

// ---------------------------------------------------------------------------
// 候選來源（sources）
// ---------------------------------------------------------------------------

test("cloudClassifierKeys 只放 typesafe 分類模型（其他 provider 會讓分類失效）", () => {
  const models = [
    { provider: "openrouter", id: "~typesafe/jev-latest" },
    { provider: "typesafe", id: "jev-latest" },
    { provider: "opencode", id: "jev-1.13" },
    { provider: "vercel-ai-gateway", id: "typesafe-ai/jev" },
  ];
  assert.deepEqual(cloudClassifierKeys(models), ["typesafe/jev-latest"]);
});

test("localCheckpoints 把 HF 快取目錄翻成 org/name，找不到目錄回空", () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-hub-"));
  try {
    mkdirSync(join(dir, "models--aac6fef--laya-multilingual-mlx"));
    mkdirSync(join(dir, "models--some--org--weird--name")); // 名字裡有 -- 也只切第一組
    mkdirSync(join(dir, "blobs"));

    assert.deepEqual(localCheckpoints({ hubDir: dir }), [
      "aac6fef/laya-multilingual-mlx",
      "some/org--weird--name",
    ]);
    assert.deepEqual(localCheckpoints({ hubDir: join(dir, "missing-subdir") }), [], "掃不到 = 空，不 throw");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("factsAgeDays 算快照年齡（供過舊提醒）", () => {
  assert.equal(factsAgeDays("2026-10-01", Date.parse("2026-10-02T12:00:00Z")), 1);
  assert.equal(factsAgeDays("2026-10-01", Date.parse("2026-10-01T00:00:00Z")), 0);
  assert.equal(factsAgeDays("2026-10-01", Date.parse("2026-10-20T00:00:00Z")), 19, "過舊時年齡要夠大");
  assert.equal(factsAgeDays("not-a-date", Date.now()), null, "壞日期回 null");
});

// ---------------------------------------------------------------------------
// 搜尋（大清單找得到新模型）與 OpenRouter 線上清單
// ---------------------------------------------------------------------------

test("模型鏈：候選不截斷（第 294 筆也在），「搜尋…」縮小清單後用選的", async () => {
  const config = freshConfig();
  const many = Array.from({ length: 300 }, (_, i) => `openrouter/pack/model-${String(i).padStart(3, "0")}`);
  many[293] = "openrouter/openai/gpt-6.1-sol"; // 舊版 48 筆上限會漏掉的位置
  let modelPicks = 0;
  const s = scripted({
    menu: ["③ 模型與層級", "模型鏈"],
    answers: {
      "模型鏈：選層級": (options) => options.find((row) => row.startsWith("quick")) as string,
      "quick 鏈 · 目前": "設為首選…",
      "quick 鏈：選首選模型": (options) => {
        modelPicks += 1;
        assert.ok(options.includes("openrouter/openai/gpt-6.1-sol"), `第 294 筆也要在清單裡：${options.length} 筆`);
        assert.ok(options.includes("搜尋…（打關鍵字縮小清單）"), "要有搜尋入口");
        // 第一次（大清單）→ 選搜尋；第二次（命中清單）→ 選模型。
        return options.length > 10 ? "搜尋…（打關鍵字縮小清單）" : "openrouter/openai/gpt-6.1-sol";
      },
    },
    inputs: { "quick 鏈：選首選模型": ["zzz-沒有命中", "6.1-sol"] },
    candidates: { model: many },
  });

  await runSettingsWizard(config, s.hooks);

  assert.equal(modelPicks, 3, "沒命中 → 重搜 → 命中再選");
  assert.ok(s.notices.some((message) => message.includes("沒有符合的模型")), "沒命中要回饋");
  assert.equal(s.stats.prompts, 2, "兩次都只是打關鍵字，不是打模型 id");
  const patch = s.writes[0][1] as Record<string, Array<{ model: string }>>;
  assert.equal(patch.quick[0].model, "openai/gpt-6.1-sol", "搜尋選到的排鏈首");
});

test("openRouterModelKeys：抓最新清單、濾 :batch、寫 24h 快取", async () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-or-"));
  const cachePath = join(dir, "cache.json");
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ id: "openai/gpt-6.1-sol" }, { id: "openai/x:batch" }, { id: "deepseek/v4" }] }), {
      status: 200,
    });
  }) as typeof fetch;

  try {
    const keys = await openRouterModelKeys({ cachePath, fetchImpl, now: 1_000 });
    assert.deepEqual(keys, ["openrouter/openai/gpt-6.1-sol", "openrouter/deepseek/v4"], ":batch 不進清單");
    assert.equal(calls, 1);

    const again = await openRouterModelKeys({ cachePath, fetchImpl, now: 1_000 + 60 * 60 * 1000 });
    assert.deepEqual(again, keys);
    assert.equal(calls, 1, "TTL 內走快取，不打 API");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("openRouterModelKeys：stale-if-error（抓失敗回舊快取；沒快取回空）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "compass-or-"));
  const cachePath = join(dir, "cache.json");
  const ok = (async () => new Response(JSON.stringify({ data: [{ id: "a/b" }] }), { status: 200 })) as typeof fetch;
  const offline = (async () => {
    throw new Error("offline");
  }) as typeof fetch;

  try {
    await openRouterModelKeys({ cachePath, fetchImpl: ok, now: 0 });
    const stale = await openRouterModelKeys({ cachePath, fetchImpl: offline, now: 3 * 24 * 60 * 60 * 1000 });
    assert.deepEqual(stale, ["openrouter/a/b"], "過期後抓失敗 → 回舊快取");

    const none = await openRouterModelKeys({ cachePath: join(dir, "missing.json"), fetchImpl: offline, now: 0 });
    assert.deepEqual(none, [], "沒快取回空（不假裝有候選）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});