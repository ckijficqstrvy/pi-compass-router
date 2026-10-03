// ui/wizard/labels.ts — 值 ↔ 標籤、顯示小工具、事實檔輔助（無 hooks、無 I/O 副作用）。
import { MODEL_FACTS, factsValid } from "../../policy/facts.js";
import { PROFILE_CEILINGS, THINKING_LEVELS, TIERS } from "../../schema.js";
import type {
  CompassConfig,
  DisplayDetail,
  Mode,
  Profile,
  Target,
  ThinkingLevel,
  Tier,
} from "../../schema.js";
import { t } from "./i18n.js";

// 值 ↔ 標籤（Part 10.2 helper 白名單 + 2026-10-02 新增）
// ---------------------------------------------------------------------------

/**
 * 解析「模型鏈」字串為候選列表（選單顯示與檔案間的往返）。
 *
 * 形狀：`"provider/model, provider/model, ..."`——逗號分隔、去前後空白、
 * 跳過空段。單段無 `/` 時 provider 為 `""`（裸 model id，與 `targetKey`
 * 的編碼一致）。
 */
export function parseChain(input: string): Target[] {
  const out: Target[] = [];
  for (const segment of input.split(",")) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    out.push(splitTarget(trimmed));
  }
  return out;
}

/**
 * `"provider/model"` → `Target`。**前導 `~` 的 `/` 不是 provider 分隔**
 * （如 `~z-ai/glm-latest`）——與 `route/select.ts` 的 `targetFromKey` 同一
 * 規則，兩處編碼不一致會破壞 menu id 往返。
 */
export function splitTarget(text: string): Target {
  if (text.startsWith("~")) return { provider: "", model: text };
  const slash = text.indexOf("/");
  if (slash <= 0) return { provider: "", model: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

/** `Target` → 選單字串（`targetKey` 的同義；不跨層相依，自帶一份）。 */
export function keyOf(target: Target): string {
  return target.provider ? `${target.provider}/${target.model}` : target.model;
}

/**
 * 解析輸入的金額字串；不合法回 `null`（選單驗證用）。
 *
 * 接受 `"5"`、`"5.5"`、`"$5.00"`（前導 `$` 可有可無、千分位逗號忽略）；
 * 負數、`NaN`、`Infinity`、非數字 → `null`。
 */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/** 已登記的 provider 顯示標籤（Part 10.2 選單顯示）。 */
export const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  // 分類後端的標籤要講清楚「用的是哪個分類器」（2026-10-02）：原本只寫
  // 「本機／遠端」或裸代號，看不出 cloud 就是遠端 typesafe 分類器。
  laya: "laya — 本地 Laya-MLX（離線、免 key）",
  typesafe: "TypeSafe",
  vercel: "Vercel AI",
  cloud: "cloud — 雲端 typesafe 分類器（需 API key）",
};

/**
 * provider 代號 → 顯示標籤。**未登記的 provider 原樣回傳**（不丟失名字，
 * 顯示層不該吞掉使用者的自訂 provider）。
 */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] !== undefined ? t(PROVIDER_LABELS[provider]) : provider;
}

/**
 * 顯示標籤 → provider 代號（不分大小寫）；未登記回 `null`。
 *
 * **允許前綴比對**：選項可以在登記標籤後面接動態資訊（如 cloud 分類器的
 * 目前模型 `… · typesafe/jev-latest`），仍要認得回代號。
 */
export function providerFromLabel(label: string): string | null {
  const lowered = label.toLowerCase();
  for (const [code, text] of Object.entries(PROVIDER_LABELS)) {
    const registered = t(text).toLowerCase();
    if (lowered === registered || lowered === code || lowered.startsWith(registered)) return code;
  }
  return null;
}

/** mode → 顯示標籤（含短語說明，Part 10.2 選單格式）。 */
export function modeLabel(mode: Mode): string {
  switch (mode) {
    case "auto":
      return t("auto — 自動切換");
    case "confirm":
      return t("confirm — 每次切換前先問你");
    case "notify":
      return t("notify — 只提醒不切換");
  }
}

/** 顯示標籤 → mode：取前綴 token（不分大小寫）；不認識回 `null`。 */
export function modeFromLabel(label: string): Mode | null {
  const token = label.trim().split(/\s+/)[0]?.toLowerCase();
  if (token === "auto" || token === "confirm" || token === "notify") return token;
  return null;
}

/** 層級 → 顯示標籤（含短語說明）。 */
export function tierLabel(tier: Tier): string {
  switch (tier) {
    case "quick":
      return t("quick — 最快最省");
    case "standard":
      return t("standard — 一般預設");
    case "high":
      return t("high — 困難任務");
    case "premium":
      return t("premium — 旗艦");
    case "xpremium":
      return t("xpremium — 需 xpremium.enabled");
  }
}

/** 顯示標籤 → 層級：取前綴 token；不認識回 `null`。 */
export function tierFromLabel(label: string): Tier | null {
  const token = label.trim().split(/\s+/)[0]?.toLowerCase();
  return (TIERS as readonly string[]).includes(token) ? (token as Tier) : null;
}

/**
 * 價格帶 → 顯示標籤：**三種定義直接印在選項上**（Part 10.2：選 profile
 * 時要在畫面上看到每層天花板的定義）。數字是該帶的每層上限，指標
 * `input + 2×output` USD/M（Part 9 價格帶表）；`∞` = 該層不設上限。
 */
export function profileLabel(profile: Profile): string {
  const ceilings = PROFILE_CEILINGS[profile];
  const bands = TIERS.map((tier) => `${tier} ${ceilings[tier] === null ? "∞" : `$${ceilings[tier]}`}`).join(" · ");
  const intent: Record<Profile, string> = {
    cheap: t("上限下修，更早用便宜模型"),
    balanced: t("折衷預設"),
    quality: t("放寬上限，品質優先"),
  };
  return t`${profile} — ${intent[profile]}（$/M 上限：${bands}）`;
}

/** 顯示標籤 → profile：取前綴 token（不分大小寫）；不認識回 `null`。 */
export function profileFromLabel(label: string): Profile | null {
  const token = label.trim().split(/\s+/)[0]?.toLowerCase();
  return token === "cheap" || token === "balanced" || token === "quality" ? token : null;
}

/** 思考層級 → 顯示標籤。 */
export function thinkingLabel(level: ThinkingLevel): string {
  const intent: Record<ThinkingLevel, string> = {
    off: t("不思考"),
    minimal: t("最少"),
    low: t("少"),
    medium: t("中"),
    high: t("多"),
    xhigh: t("很多"),
    max: t("最多"),
  };
  return `${level} — ${intent[level]}`;
}

/** 顯示標籤 → 思考層級：取前綴 token；不認識回 `null`。 */
export function thinkingFromLabel(label: string): ThinkingLevel | null {
  const token = label.trim().split(/\s+/)[0]?.toLowerCase();
  return (THINKING_LEVELS as readonly string[]).includes(token) ? (token as ThinkingLevel) : null;
}

/**
 * 選單裡僅有的兩個打字入口：**只有選到其中之一才會出現 prompt**。
 * `CUSTOM_OPTION` 直接打值；`SEARCH_OPTION` 打關鍵字**縮小清單**再選。
 */
export const CUSTOM_OPTION = "自訂…（打字輸入）";
export const SEARCH_OPTION = "搜尋…（打關鍵字縮小清單）";

/** 清除類選項：patch `null` = 刪子鍵（回預設／回自動派生）。 */
export const CLEAR_OPTION = "清除（回預設／自動）";

/** 候選安全上限（registry + OpenRouter 可到數百筆；超出走「搜尋…」）。 */
export const MAX_CANDIDATES = 1000;

/** 金額預設值（兩種上限各自的常用檔位）。 */
export const DAILY_PRESETS = [1, 2, 3, 5, 8, 10, 20, 50] as const;
export const MONTHLY_PRESETS = [10, 20, 50, 100, 200, 500] as const;

/** 預算比例預設值（softRatio/hardRatio）。 */
export const RATIO_PRESETS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const;

/** 分類參數預設值。 */
export const CLASSIFY_NUM_PRESETS: Readonly<Record<string, readonly number[]>> = {
  timeoutMs: [300, 500, 800, 1200, 2000, 3000],
  confidenceThreshold: [0.2, 0.25, 0.34, 0.4, 0.5, 0.7],
  minPromptChars: [0, 6, 12, 24, 40],
  historyTurns: [0, 1, 2, 4],
};

// ---------------------------------------------------------------------------
export const money = (n: number | null): string => (n === null ? t("無上限") : `$${n.toFixed(2)}`);
export const onOff = (value: boolean): string => (value ? t("開") : t("關"));

/** 呈現密度 → 白話說明（項目列顯示用）。 */
export const DETAIL_HINT: Record<DisplayDetail, () => string> = {
  compact: () => t("只看決策首行"),
  standard: () => t("脈絡一列（預設）"),
  full: () => t("直接攤開明細"),
};

/** 去重（保序）：候選清單合併用。 */
/** 過長字串截斷（避免選單列在 80 欄折行破壞對齊）。 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** 事實檔的 `provider/model` 清單（能力排序由檔內順序決定）。 */
export function factKeys(): string[] {
  if (!factsValid(MODEL_FACTS)) return [];
  return MODEL_FACTS.models.map((fact) => `${fact.provider}/${fact.model}`);
}

/** 事實檔快照日期（「看鏈的來源」顯示用）。 */
export function factsDate(): string {
  return factsValid(MODEL_FACTS) ? MODEL_FACTS.generatedAt.slice(0, 10) : "不可用";
}

/** 快照過舊門檻（天）：超過就在選單標警示，提醒跑 `npm run refresh-facts`。 */
export const STALE_FACTS_DAYS = 14;

/**
 * 事實檔快照年齡（天，無條件捨去）；`generatedAt` 不合法回 `null`。
 * 純函式（時間可注入）供測試。
 */
export function factsAgeDays(generatedAt: string, nowMs: number = Date.now()): number | null {
  const at = Date.parse(generatedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 86_400_000));
}

/** 快照過舊天數（超過門檻回年齡，否則 `null`）。 */
export function staleDays(): number | null {
  const age = factsValid(MODEL_FACTS) ? factsAgeDays(MODEL_FACTS.generatedAt) : null;
  return age !== null && age > STALE_FACTS_DAYS ? age : null;
}

/** 一條鏈的摘要：`（自動2·你寫1）`——L1/L3 誰在決定。 */
export function chainSummary(chain: readonly Target[]): string {
  const own = chain.filter((target) => target.explicit).length;
  const derived = chain.length - own;
  const parts: string[] = [];
  if (derived > 0) parts.push(t`自動${derived}`);
  if (own > 0) parts.push(t`你寫${own}`);
  return t`${chain.length}（${parts.join("·") || t("空")}）`;
}

// ---------------------------------------------------------------------------
