// ui/wizard/items.ts — 選單結構（組/項目）與列渲染、列認列。
import { t } from "./i18n.js";
import { DISPLAY_FIELDS, TIERS, type CompassConfig } from "../../schema.js";
import {
  chainSummary,
  clip,
  factsDate,
  money,
  modeLabel,
  onOff,
  providerLabel,
  staleDays,
  DETAIL_HINT,
} from "./labels.js";

// 選單結構：六組 → 各組項目
// ---------------------------------------------------------------------------

export type Group = "routing" | "budget" | "models" | "classifier" | "policy" | "display" | "diagnostics";

export const GROUPS: ReadonlyArray<{ id: Group; name: string }> = [
  { id: "routing", name: "① 路由行為" },
  { id: "budget", name: "② 預算與花費" },
  { id: "models", name: "③ 模型與層級" },
  { id: "classifier", name: "④ 分類器" },
  { id: "policy", name: "⑤ 政策與過濾" },
  { id: "display", name: "⑥ 顯示與呈現" },
  { id: "diagnostics", name: "⑦ 重設・診斷" },
];

export type MenuItem =
  | "enabled"
  | "mode"
  | "stickiness"
  | "modelPick"
  | "allowUnratedPicks"
  | "thinking"
  | "cache"
  | "advanced"
  | "daily"
  | "monthly"
  | "ratios"
  | "profile"
  | "freeOnly"
  | "strictFreeOnly"
  | "chains"
  | "kindModels"
  | "prefer"
  | "kindTiers"
  | "xpremium"
  | "useDefaultModels"
  | "provider"
  | "checkpoint"
  | "classifyCache"
  | "classifyNums"
  | "filters"
  | "ceilings"
  | "scoresFile"
  | "detail"
  | "fields"
  | "badge"
  | "color"
  | "hint"
  | "rails"
  | "uiLang"
  | "reset"
  | "testClassifier"
  | "chainSource";

export const GROUP_ITEMS: Readonly<Record<Group, readonly MenuItem[]>> = {
  routing: ["enabled", "mode", "advanced", "stickiness", "modelPick", "allowUnratedPicks", "thinking", "cache"],
  budget: ["daily", "monthly", "ratios", "profile", "freeOnly", "strictFreeOnly"],
  models: ["chains", "kindModels", "prefer", "kindTiers", "xpremium", "useDefaultModels"],
  classifier: ["provider", "checkpoint", "classifyCache", "classifyNums"],
  policy: ["filters", "ceilings", "scoresFile"],
  display: ["detail", "fields", "badge", "color", "hint", "rails", "uiLang"],
  diagnostics: ["reset", "testClassifier", "chainSource"],
};

/** 項目 → 顯示名（列前綴；也用來把選到的列認回項目）。 */
export const ITEM_NAMES: Readonly<Record<MenuItem, string>> = {
  enabled: "啟用 compass",
  mode: "路由模式",
  stickiness: "粘住當前模型",
  modelPick: "手動挑模型",
  allowUnratedPicks: "允許未評分模型",
  thinking: "思考層級",
  cache: "切換成本 cache",
  advanced: "進階選項",
  daily: "每日上限",
  monthly: "每月上限",
  ratios: "預算警戒線",
  profile: "價格 profile",
  freeOnly: "特殊情境（free-only）",
  strictFreeOnly: "free-only 嚴格（不付費）",
  chains: "模型鏈",
  kindModels: "專家鏈",
  prefer: "prefer 首選",
  kindTiers: "任務最低層級",
  xpremium: "xpremium 層",
  useDefaultModels: "內建模型鏈",
  provider: "分類後端",
  checkpoint: "分類模型",
  classifyCache: "分類快取",
  classifyNums: "分類參數",
  filters: "過濾規則",
  ceilings: "價格天花板",
  scoresFile: "建議分數檔",
  detail: "呈現密度",
  fields: "收合列欄位",
  badge: "compass 徽章",
  color: "配色",
  hint: "expand 提示",
  rails: "樹狀導軌",
  uiLang: "界面語言",
  reset: "重設某項回預設",
  testClassifier: "測試分類器",
  chainSource: "看鏈的來源",
};

/** 工程師向項目：`advanced: false`（預設）時隱藏，只在「進階選項」開啟後出現。 */
export const ADVANCED_ITEMS: ReadonlySet<MenuItem> = new Set([
  "stickiness", "modelPick", "allowUnratedPicks", "thinking", "cache",
  "ratios", "freeOnly", "strictFreeOnly",
  "chains", "kindModels", "prefer", "kindTiers", "xpremium", "useDefaultModels",
  "checkpoint", "classifyCache", "classifyNums",
  "filters", "ceilings", "scoresFile",
  "chainSource",
]);

/** 整組都是工程師向：Basic 模式下整個分組不顯示。 */
export const ADVANCED_GROUPS: ReadonlySet<Group> = new Set(["models", "policy"]);

export const MENU_LABEL = "compass 設定（↑↓ 選組，Enter 進入，Esc 結束）";
export const BACK_OPTION = "← 返回";
export const DONE_OPTION = "結束";

// 顯示列
// ---------------------------------------------------------------------------

/** 組列（主選單）。 */
export function renderGroupRow(group: Group, config: CompassConfig): string {
  switch (group) {
    case "routing":
      return config.advanced
        ? t`① 路由行為 ........... ${config.mode} · 粘住 ${onOff(config.stickiness)} · 挑模型 ${config.modelPick}`
        : t`① 路由行為 ........... ${config.mode}`;
    case "budget":
      return t`② 預算與花費 .......... ${money(config.budget.dailyUsd)}/日 · ${money(config.budget.monthlyUsd)}/月 · ${config.profile}`;
    case "models": {
      const stale = staleDays();
      return t`③ 模型與層級 .......... quick ${chainSummary(config.routes.quick)} · 專家 ${Object.keys(config.kindModels).length} 種${stale === null ? "" : t` ⚠快照 ${stale}天`}`;
    }
    case "classifier":
      return config.advanced
        ? t`④ 分類器 ............. ${config.classify.provider} · TTL ${config.classify.cacheTtlSeconds}s · timeout ${config.classify.timeoutMs}ms`
        : t`④ 分類器 ............. ${config.classify.provider}`;
    case "policy": {
      const preferCount = Object.values(config.prefer).reduce((n, list) => n + (list?.length ?? 0), 0);
      const ceilingsCount = Object.keys(config.ceilings).length;
      return t`⑤ 政策與過濾 .......... deny ${config.deny.length} · ceilings ${ceilingsCount === 0 ? t("依 profile") : t`${ceilingsCount} 自訂`} · prefer ${preferCount}`;
    }
    case "display": {
      const d = config.display;
      return t`⑥ 顯示與呈現 ........... ${d.detail} · 欄位 ${d.fields.length} · ${d.color}${d.badge ? t(" · 徽章") : ""}`;
    }
    case "diagnostics":
      return config.advanced
        ? t("⑦ 重設・診斷 .......... 重設某項 · 測試分類器 · 看鏈的來源")
        : t("⑦ 重設・診斷 .......... 重設某項 · 測試分類器");
  }
}

/** 項目列（組內選單）：`名 … 目前值`；名即前綴，供 itemOf 認列。 */
export function renderItemRow(item: MenuItem, config: CompassConfig): string {
  const name = t(ITEM_NAMES[item]);
  const pad = " …… ";
  switch (item) {
    case "enabled":
      return `${name}${pad}${onOff(config.enabled)}`;
    case "mode":
      return `${name}${pad}${modeLabel(config.mode)}`;
    case "stickiness":
      return t`${name}${pad}${onOff(config.stickiness)}（避免反覆切換）`;
    case "modelPick":
      return t`${name}${pad}${config.modelPick}（menu = 每次用選單挑）`;
    case "allowUnratedPicks":
      return t`${name}${pad}${onOff(config.allowUnratedPicks)}（事實檔沒有的模型也能被選）`;
    case "thinking": {
      const pin = config.thinking.pin;
      return `${name}${pad}${pin ? `pin ${pin}` : t("依層級預設")}`;
    }
    case "cache":
      return t`${name}${pad}${onOff(config.cache.aware)} · 冷卻 ${config.cache.cooldownSeconds}s`;
    case "daily":
      return `${name}${pad}${money(config.budget.dailyUsd)}`;
    case "monthly":
      return `${name}${pad}${money(config.budget.monthlyUsd)}`;
    case "ratios":
      return t`${name}${pad}${Math.round(config.budget.softRatio * 100)}%（警戒）/ ${Math.round(config.budget.hardRatio * 100)}%（強制）`;
    case "profile":
      return `${name}${pad}${config.profile}`;
    case "freeOnly":
      return t`${name}${pad}${onOff(config.freeOnly)}（只用 $0 模型）`;
    case "strictFreeOnly":
      return t`${name}${pad}${onOff(config.strictFreeOnly)}（沒有可驗證的 $0 模型就不路由）`;
    case "chains":
      return `${name}${pad}quick ${chainSummary(config.routes.quick)} · high ${chainSummary(config.routes.high)}`;
    case "kindModels":
      return t`${name}${pad}${Object.keys(config.kindModels).length} 種有專家鏈`;
    case "prefer": {
      const count = Object.values(config.prefer).reduce((n, list) => n + (list?.length ?? 0), 0);
      return `${name}${pad}${count === 0 ? t("未設定") : t`${count} 層有偏好首選`}`;
    }
    case "kindTiers": {
      const parts = Object.entries(config.kindMinimumTier).map(([kind, tier]) => `${kind}≥${tier}`);
      // 10 種類的完整清單在 80 欄會折行；截斷保留前段可讀性。
      return `${name}${pad}${clip(parts.join(" · "), 58)}`;
    }
    case "xpremium":
      return t`${name}${pad}${onOff(config.xpremium.enabled)}（premium 之上再一層）`;
    case "useDefaultModels":
      return t`${name}${pad}${onOff(config.useDefaultModels)}（關 = 只用你自帶的模型）`;
    case "provider":
      return `${name}${pad}${providerLabel(config.classify.provider)}`;
    case "checkpoint": {
      const cloud = config.classify.provider === "cloud";
      const value = cloud
        ? `${config.classify.cloud.provider}/${config.classify.cloud.model}`
        : config.classify.model;
      return `${name}${pad}${cloud ? "cloud" : "laya"} · ${value}`;
    }
    case "classifyCache":
      return `${name}${pad}${onOff(config.classify.cache)} · TTL ${config.classify.cacheTtlSeconds}s`;
    case "classifyNums":
      return t`${name}${pad}timeout ${config.classify.timeoutMs}ms · 門檻 ${config.classify.confidenceThreshold} · 最短 ${config.classify.minPromptChars} 字`;
    case "filters":
      return `${name}${pad}deny ${config.deny.length} · allowProviders ${config.allowProviders.length}`;
    case "ceilings": {
      const count = Object.keys(config.ceilings).length;
      return `${name}${pad}${count === 0 ? t("依 profile 價格帶") : t`${count} 層自訂`}`;
    }
    case "advanced":
      return t`${name}${pad}${onOff(config.advanced)}（顯示工程師向選項）`;
    case "scoresFile":
      return `${name}${pad}${config.suggest.scoresFile === "" ? t("未設定") : config.suggest.scoresFile}`;
    case "detail":
      return t`${name}${pad}${config.display.detail} · ${DETAIL_HINT[config.display.detail]()}`;
    case "fields": {
      const shown = config.display.fields;
      const chips = DISPLAY_FIELDS.map((f) => (shown.includes(f) ? f : `-${f}`)).join(" ");
      return t`${name}${pad}${chips}（- = 不顯示）`;
    }
    case "badge":
      return `${name}${pad}${onOff(config.display.badge)}`;
    case "color":
      return `${name}${pad}${config.display.color === "mono" ? t("mono（單色，只留明暗）") : t("rich（全彩）")}`;
    case "hint":
      return `${name}${pad}${onOff(config.display.hint)}`;
    case "rails":
      return `${name}${pad}${onOff(config.display.rails)}`;
    case "uiLang":
      return `${name}${pad}${config.display.language === "en" ? "English" : t("中文")}`;
    case "reset":
      return `${name}${pad}…`;
    case "testClassifier":
      return t`${name}${pad}跑一輪真分類（不切換）`;
    case "chainSource":
      return t`${name}${pad}哪一層在決定每條鏈`;
  }
}

// ---------------------------------------------------------------------------
export function groupName(group: Group): string {
  return t(GROUPS.find((entry) => entry.id === group)?.name ?? group);
}

/** 組列 → Group（列首就是組圈號，語言中立，前綴比對）。 */
export function groupOf(row: string): Group | null {
  for (const group of GROUPS) {
    if (row.startsWith(group.name.slice(0, 1))) return group.id;
  }
  return null;
}

/** 項目列 → MenuItem（`ITEM_NAMES` 前綴比對，值變了也認得；兩端同語言）。 */
export function itemOf(group: Group, row: string): MenuItem | null {
  for (const item of GROUP_ITEMS[group]) {
    if (row.startsWith(t(ITEM_NAMES[item]))) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
