// ui/wizard.ts — /compass-set 設定選單（SPEC Part 10.2）。
//
// 2026-10-02 重構為**分組六列**（使用者拍板），三條鐵律：
//
//   1. **能選就不打**：候選能枚舉（枚舉、預設值、事實檔、registry、本機
//      快取、層級）一律 `hooks.pick`；打字只出現在明寫的「自訂…（打字
//      輸入）」之後。
//   2. **寫進去要能清**：配合 config 寫入層的「patch `null` = 刪子鍵」
//      （`config/load.ts`），prefer／ceilings／thinking／模型鏈都能
//      「改回自動／清除」——不再有單向門。
//   3. **看得見誰決定**：模型鏈列顯示來源（自動派生／你寫的）——新
//      compass-router 的核心是 L1 事實／L2 政策／L3 显式分層，選單必須
//      讓你看得到現在是哪一層在決定。
//
// 候選來源（registry、本機 HF 快取等 I/O）在接線層，經 `hooks.candidates`
// 注入；未實作或回空 → 該項仍以內建預設為種子（不打字）。
import { MODEL_FACTS, factsValid } from "../policy/facts.js";
import { DEFAULT_CONFIG, PROFILE_CEILINGS, TIERS } from "../schema.js";
import type {
  CompassConfig,
  Mode,
  Profile,
  Target,
  ThinkingLevel,
  Tier,
} from "../schema.js";

/** `hooks.candidates()` 的候選種類（接線層決定來源，本模組只負責呈現）。 */
export type CandidateKind =
  /** 路由模型 `provider/model`：registry 可用模型 ∪ 事實檔 ∪ 現有鏈。 */
  | "model"
  /** laya checkpoint：本機快取掃描。 */
  | "checkpoint"
  /** cloud 分類模型：registry 的 typesafe 分類模型。 */
  | "classifier";

/** 供 TUI 選單與寫入落地的掛點（Part 10.2「hooks 形狀」節）。 */
export interface WizardHooks {
  /** 逐項寫入驗證與落地（Part 3.4 白名單）。回 `null` 成功，回 `key: reason` 拒絕。 */
  write(key: string, value: unknown): string | null;
  /**
   * 寫入後重載進執行中 session。**回傳重載後的設定**（可選）：接線層
   * reload 會換掉 session 的設定物件，不回傳選單就畫在舊物件上。
   */
  reload(): CompassConfig | void | Promise<CompassConfig | void>;
  /** TUI 取一列輸入。回 `null` = 使用者取消（Esc）。 */
  prompt(label: string, initial?: string): Promise<string | null>;
  /** TUI 從清單選一項。回 `null` = 取消。 */
  pick(label: string, options: string[]): Promise<string | null>;
  /**
   * 候選清單（可選）。回空或未實作 → 該項以內建預設為種子、仍用選單
   * （「能選就不打」）。
   */
  candidates?(kind: CandidateKind): string[] | Promise<string[]>;
  /** 給使用者的回饋（可選）：寫入被拒、輸入無效、診斷結果。 */
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  /** 測試分類器（可選）：跑一輪真分類，回一列結果；未實作 → 該項目不動作。 */
  probeClassifier?(): Promise<string> | string;
}

// ---------------------------------------------------------------------------
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
function splitTarget(text: string): Target {
  if (text.startsWith("~")) return { provider: "", model: text };
  const slash = text.indexOf("/");
  if (slash <= 0) return { provider: "", model: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

/** `Target` → 選單字串（`targetKey` 的同義；不跨層相依，自帶一份）。 */
function keyOf(target: Target): string {
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
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
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
  return PROVIDER_LABELS[provider] ?? provider;
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
    const registered = text.toLowerCase();
    if (lowered === registered || lowered === code || lowered.startsWith(registered)) return code;
  }
  return null;
}

/** mode → 顯示標籤（含短語說明，Part 10.2 選單格式）。 */
export function modeLabel(mode: Mode): string {
  switch (mode) {
    case "auto":
      return "auto — 自動切換";
    case "confirm":
      return "confirm — 每次切換前先問你";
    case "notify":
      return "notify — 只提醒不切換";
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
      return "quick — 最快最省";
    case "standard":
      return "standard — 一般預設";
    case "high":
      return "high — 困難任務";
    case "premium":
      return "premium — 旗艦";
    case "xpremium":
      return "xpremium — 需 xpremium.enabled";
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
    cheap: "上限下修，更早用便宜模型",
    balanced: "折衷預設",
    quality: "放寬上限，品質優先",
  };
  return `${profile} — ${intent[profile]}（$/M 上限：${bands}）`;
}

/** 顯示標籤 → profile：取前綴 token（不分大小寫）；不認識回 `null`。 */
export function profileFromLabel(label: string): Profile | null {
  const token = label.trim().split(/\s+/)[0]?.toLowerCase();
  return token === "cheap" || token === "balanced" || token === "quality" ? token : null;
}

/** 思考層級全體（schema 的 `ThinkingLevel` 對應）。 */
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 思考層級 → 顯示標籤。 */
export function thinkingLabel(level: ThinkingLevel): string {
  const intent: Record<ThinkingLevel, string> = {
    off: "不思考",
    minimal: "最少",
    low: "少",
    medium: "中",
    high: "多",
    xhigh: "很多",
    max: "最多",
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
const SEARCH_OPTION = "搜尋…（打關鍵字縮小清單）";

/** 清除類選項：patch `null` = 刪子鍵（回預設／回自動派生）。 */
const CLEAR_OPTION = "清除（回預設／自動）";

/** 候選安全上限（registry + OpenRouter 可到數百筆；超出走「搜尋…」）。 */
const MAX_CANDIDATES = 1000;

/** 金額預設值（兩種上限各自的常用檔位）。 */
const DAILY_PRESETS = [1, 2, 3, 5, 8, 10, 20, 50] as const;
const MONTHLY_PRESETS = [10, 20, 50, 100, 200, 500] as const;

/** 預算比例預設值（softRatio/hardRatio）。 */
const RATIO_PRESETS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95] as const;

/** 分類參數預設值。 */
const CLASSIFY_NUM_PRESETS: Readonly<Record<string, readonly number[]>> = {
  timeoutMs: [300, 500, 800, 1200, 2000, 3000],
  confidenceThreshold: [0.2, 0.25, 0.34, 0.4, 0.5, 0.7],
  minPromptChars: [0, 6, 12, 24, 40],
  historyTurns: [0, 1, 2, 4],
};

// ---------------------------------------------------------------------------
// 選單結構：六組 → 各組項目
// ---------------------------------------------------------------------------

type Group = "routing" | "budget" | "models" | "classifier" | "policy" | "diagnostics";

const GROUPS: ReadonlyArray<{ id: Group; name: string }> = [
  { id: "routing", name: "① 路由行為" },
  { id: "budget", name: "② 預算與花費" },
  { id: "models", name: "③ 模型與層級" },
  { id: "classifier", name: "④ 分類器" },
  { id: "policy", name: "⑤ 政策與過濾" },
  { id: "diagnostics", name: "⑥ 重設・診斷" },
];

type MenuItem =
  | "enabled"
  | "mode"
  | "stickiness"
  | "modelPick"
  | "allowUnratedPicks"
  | "thinking"
  | "cache"
  | "daily"
  | "monthly"
  | "ratios"
  | "profile"
  | "freeOnly"
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
  | "reset"
  | "testClassifier"
  | "chainSource";

const GROUP_ITEMS: Readonly<Record<Group, readonly MenuItem[]>> = {
  routing: ["enabled", "mode", "stickiness", "modelPick", "allowUnratedPicks", "thinking", "cache"],
  budget: ["daily", "monthly", "ratios", "profile", "freeOnly"],
  models: ["chains", "kindModels", "prefer", "kindTiers", "xpremium", "useDefaultModels"],
  classifier: ["provider", "checkpoint", "classifyCache", "classifyNums"],
  policy: ["filters", "ceilings"],
  diagnostics: ["reset", "testClassifier", "chainSource"],
};

/** 項目 → 顯示名（列前綴；也用來把選到的列認回項目）。 */
const ITEM_NAMES: Readonly<Record<MenuItem, string>> = {
  enabled: "啟用 compass",
  mode: "路由模式",
  stickiness: "粘住當前模型",
  modelPick: "手動挑模型",
  allowUnratedPicks: "允許未評分模型",
  thinking: "思考層級",
  cache: "切換成本 cache",
  daily: "每日上限",
  monthly: "每月上限",
  ratios: "預算警戒線",
  profile: "價格 profile",
  freeOnly: "特殊情境（free-only）",
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
  reset: "重設某項回預設",
  testClassifier: "測試分類器",
  chainSource: "看鏈的來源",
};

const MENU_LABEL = "compass 設定（↑↓ 選組，Enter 進入，Esc 結束）";
const BACK_OPTION = "← 返回";
const DONE_OPTION = "結束";

const money = (n: number | null): string => (n === null ? "無上限" : `$${n.toFixed(2)}`);
const onOff = (value: boolean): string => (value ? "開" : "關");

/** 去重（保序）：候選清單合併用。 */
function dedupe(values: readonly string[]): string[] {
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
function factKeys(): string[] {
  if (!factsValid(MODEL_FACTS)) return [];
  return MODEL_FACTS.models.map((fact) => `${fact.provider}/${fact.model}`);
}

/** 事實檔快照日期（「看鏈的來源」顯示用）。 */
function factsDate(): string {
  return factsValid(MODEL_FACTS) ? MODEL_FACTS.generatedAt.slice(0, 10) : "不可用";
}

/** 快照過舊門檻（天）：超過就在選單標警示，提醒跑 `npm run refresh-facts`。 */
const STALE_FACTS_DAYS = 14;

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
function staleDays(): number | null {
  const age = factsValid(MODEL_FACTS) ? factsAgeDays(MODEL_FACTS.generatedAt) : null;
  return age !== null && age > STALE_FACTS_DAYS ? age : null;
}

/** 設定裡已出現的所有模型（已在用的最該出現在候選裡）。 */
function ownModelKeys(config: CompassConfig): string[] {
  const out: string[] = [];
  for (const chain of Object.values(config.routes)) out.push(...chain.map(keyOf));
  for (const chain of Object.values(config.kindModels)) out.push(...chain.map(keyOf));
  out.push(...config.freePool.models.map(keyOf));
  return out;
}

/** 設定裡已出現的 provider（`allowProviders` 候選）。 */
function ownProviders(config: CompassConfig): string[] {
  const out: string[] = [...config.allowProviders];
  for (const chain of Object.values(config.routes)) out.push(...chain.map((t) => t.provider));
  for (const chain of Object.values(config.kindModels)) out.push(...chain.map((t) => t.provider));
  out.push(...factKeys().map((key) => splitTarget(key).provider));
  return dedupe(out.filter((p) => p !== ""));
}

/** 提示（`notify` 未實作時靜默——不因缺 UI 而崩）。 */
function notice(
  hooks: WizardHooks,
  message: string,
  type: "info" | "warning" | "error" = "warning",
): void {
  hooks.notify?.(message, type);
}

/**
 * 取一項。回 `undefined` = 取消（Esc）；回 `null` = hooks 丟了非選項字串
 * （非規格行為，視為這次編輯作廢）。
 */
async function pickFrom(
  hooks: WizardHooks,
  label: string,
  options: string[],
): Promise<string | undefined | null> {
  const picked = await hooks.pick(label, options);
  if (picked === null) return undefined;
  return options.includes(picked) ? picked : null;
}

/**
 * 打字輸入迴圈（**只在使用者選「自訂…」時到達**）。
 *
 * `check` 回 `null` = 合法，否則回錯誤訊息並**重問**（保留原輸入）；
 * Esc 回 `undefined`。空字串是否合法由 `check` 決定。
 */
async function promptLoop(
  hooks: WizardHooks,
  label: string,
  initial: string,
  check: (text: string) => string | null,
): Promise<string | undefined> {
  let text = initial;
  for (;;) {
    const raw = await hooks.prompt(label, text);
    if (raw === null) return undefined;
    const trimmed = raw.trim();
    const problem = check(trimmed);
    if (problem === null) return trimmed;
    notice(hooks, `${problem}——再試一次（Esc 取消）`, "warning");
    text = raw;
  }
}

/**
 * 模型候選：設定現用 ∪ 事實檔（**精選，先排**）∪ registry ∪ OpenRouter
 * 最新清單（`hooks.candidates`）。
 *
 * 兩組精選**永不被截掉**；registry/線上清單依字典序排在後面，讓
 * `openai/gpt-6.1-sol` 這種新模型找得到（2026-10-02：舊版只給 48 筆，
 * 第 294 位的新模型直接消失）；整體設 1000 筆安全上限，超出走「搜尋…」。
 */
async function modelCandidates(config: CompassConfig, hooks: WizardHooks): Promise<string[]> {
  const provided = (await hooks.candidates?.("model")) ?? [];
  const curated = dedupe([...ownModelKeys(config), ...factKeys()]);
  const chosen = new Set(curated);
  const extra = dedupe(provided)
    .filter((key) => !chosen.has(key))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_CANDIDATES);
  return [...curated, ...extra];
}

/**
 * 有「搜尋…」的模型選單（迴圈：關鍵字縮小清單 → 從命中裡選 → 可再搜）。
 * `prefix` 是清單開頭的固定項（如「清除…」）。回 `undefined` = 取消、
 * `null` = 非規格回傳、字串 = 選到的項目（含 `CUSTOM_OPTION`，由呼叫端
 * 決定打字後續）。
 */
async function pickModelFrom(
  hooks: WizardHooks,
  label: string,
  candidates: string[],
  prefix: readonly string[] = [],
): Promise<string | undefined | null> {
  let pool = candidates;
  for (;;) {
    const picked = await pickFrom(hooks, label, [...prefix, ...pool, SEARCH_OPTION, CUSTOM_OPTION]);
    if (picked === undefined || picked === null) return picked;
    if (picked !== SEARCH_OPTION) return picked;

    const keyword = await promptLoop(
      hooks,
      `${label}：關鍵字（篩選 ${candidates.length} 筆）`,
      "",
      (text) => (text === "" ? "關鍵字不能是空字串" : null),
    );
    if (keyword === undefined) return undefined;
    const hits = candidates.filter((key) => key.toLowerCase().includes(keyword.toLowerCase()));
    if (hits.length === 0) {
      notice(hooks, `「${keyword}」沒有符合的模型——再搜一次（Esc 取消）`, "warning");
      pool = candidates;
      continue;
    }
    pool = hits;
  }
}

/**
 * 選一個模型：有候選 → 選單（「搜尋…」可縮小清單、末項 `CUSTOM_OPTION`
 * 可打字）；沒候選 → 退回打字輸入。
 *
 * 回 `undefined` = 取消，回 `null` = 非規格回傳，回字串 = 選定。
 */
async function chooseModel(
  hooks: WizardHooks,
  config: CompassConfig,
  label: string,
  initial: string,
): Promise<string | undefined | null> {
  const candidates = await modelCandidates(config, hooks);
  const check = (text: string): string | null => (text === "" ? "模型 id 不能是空字串" : null);
  if (candidates.length === 0) {
    const typed = await promptLoop(hooks, `${label}（provider/model）`, initial, check);
    return typed === undefined ? undefined : typed;
  }
  const picked = await pickModelFrom(hooks, label, candidates);
  if (picked === undefined || picked === null) return picked;
  if (picked !== CUSTOM_OPTION) return picked;
  const typed = await promptLoop(hooks, `${label}（provider/model）`, initial, check);
  return typed === undefined ? undefined : typed;
}

/** 一條鏈的摘要：`（自動2·你寫1）`——L1/L3 誰在決定。 */
function chainSummary(chain: readonly Target[]): string {
  const own = chain.filter((target) => target.explicit).length;
  const derived = chain.length - own;
  const parts: string[] = [];
  if (derived > 0) parts.push(`自動${derived}`);
  if (own > 0) parts.push(`你寫${own}`);
  return `${chain.length}（${parts.join("·") || "空"}）`;
}

// ---------------------------------------------------------------------------
// 顯示列
// ---------------------------------------------------------------------------

/** 組列（主選單）。 */
function renderGroupRow(group: Group, config: CompassConfig): string {
  switch (group) {
    case "routing":
      return `① 路由行為 ........... ${config.mode} · 粘住 ${onOff(config.stickiness)} · 挑模型 ${config.modelPick}`;
    case "budget":
      return `② 預算與花費 .......... ${money(config.budget.dailyUsd)}/日 · ${money(config.budget.monthlyUsd)}/月 · ${config.profile}`;
    case "models": {
      const stale = staleDays();
      return `③ 模型與層級 .......... quick ${chainSummary(config.routes.quick)} · 專家 ${Object.keys(config.kindModels).length} 種${stale === null ? "" : ` ⚠快照 ${stale}天`}`;
    }
    case "classifier":
      return `④ 分類器 ............. ${config.classify.provider} · TTL ${config.classify.cacheTtlSeconds}s · timeout ${config.classify.timeoutMs}ms`;
    case "policy": {
      const preferCount = Object.values(config.prefer).reduce((n, list) => n + (list?.length ?? 0), 0);
      const ceilingsCount = Object.keys(config.ceilings).length;
      return `⑤ 政策與過濾 .......... deny ${config.deny.length} · ceilings ${ceilingsCount === 0 ? "依 profile" : `${ceilingsCount} 自訂`} · prefer ${preferCount}`;
    }
    case "diagnostics":
      return `⑥ 重設・診斷 .......... 重設某項 · 測試分類器 · 看鏈的來源`;
  }
}

/** 項目列（組內選單）：`名 … 目前值`；名即前綴，供 itemOf 認列。 */
function renderItemRow(item: MenuItem, config: CompassConfig): string {
  const name = ITEM_NAMES[item];
  const pad = " …… ";
  switch (item) {
    case "enabled":
      return `${name}${pad}${onOff(config.enabled)}`;
    case "mode":
      return `${name}${pad}${modeLabel(config.mode)}`;
    case "stickiness":
      return `${name}${pad}${onOff(config.stickiness)}（避免反覆切換）`;
    case "modelPick":
      return `${name}${pad}${config.modelPick}（menu = 每次用選單挑）`;
    case "allowUnratedPicks":
      return `${name}${pad}${onOff(config.allowUnratedPicks)}（事實檔沒有的模型也能被選）`;
    case "thinking": {
      const pin = config.thinking.pin;
      return `${name}${pad}${pin ? `pin ${pin}` : "依層級預設"}`;
    }
    case "cache":
      return `${name}${pad}${onOff(config.cache.aware)} · 冷卻 ${config.cache.cooldownSeconds}s`;
    case "daily":
      return `${name}${pad}${money(config.budget.dailyUsd)}`;
    case "monthly":
      return `${name}${pad}${money(config.budget.monthlyUsd)}`;
    case "ratios":
      return `${name}${pad}${Math.round(config.budget.softRatio * 100)}%（警戒）/ ${Math.round(config.budget.hardRatio * 100)}%（強制）`;
    case "profile":
      return `${name}${pad}${config.profile}`;
    case "freeOnly":
      return `${name}${pad}${onOff(config.freeOnly)}（只用 $0 模型）`;
    case "chains":
      return `${name}${pad}quick ${chainSummary(config.routes.quick)} · high ${chainSummary(config.routes.high)}`;
    case "kindModels":
      return `${name}${pad}${Object.keys(config.kindModels).length} 種有專家鏈`;
    case "prefer": {
      const count = Object.values(config.prefer).reduce((n, list) => n + (list?.length ?? 0), 0);
      return `${name}${pad}${count === 0 ? "未設定" : `${count} 層有偏好首選`}`;
    }
    case "kindTiers": {
      const parts = Object.entries(config.kindMinimumTier).map(([kind, tier]) => `${kind}≥${tier}`);
      return `${name}${pad}${parts.join(" · ")}`;
    }
    case "xpremium":
      return `${name}${pad}${onOff(config.xpremium.enabled)}（premium 之上再一層）`;
    case "useDefaultModels":
      return `${name}${pad}${onOff(config.useDefaultModels)}（關 = 只用你自帶的模型）`;
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
      return `${name}${pad}timeout ${config.classify.timeoutMs}ms · 門檻 ${config.classify.confidenceThreshold} · 最短 ${config.classify.minPromptChars} 字`;
    case "filters":
      return `${name}${pad}deny ${config.deny.length} · allowProviders ${config.allowProviders.length}`;
    case "ceilings": {
      const count = Object.keys(config.ceilings).length;
      return `${name}${pad}${count === 0 ? "依 profile 價格帶" : `${count} 層自訂`}`;
    }
    case "reset":
      return `${name}${pad}…`;
    case "testClassifier":
      return `${name}${pad}跑一輪真分類（不切換）`;
    case "chainSource":
      return `${name}${pad}哪一層在決定每條鏈`;
  }
}

// ---------------------------------------------------------------------------
// 主迴圈
// ---------------------------------------------------------------------------

/**
 * 執行 /compass-set 選單（Part 10.2）：組 → 項目 → 編輯 → 寫 config.json
 * （時間戳備份）→ 重載 → 重繪。
 *
 * 本函式是**選單迴圈**，TUI 顯示與檔案落地全交給 `hooks`（純資料 + 掛點，
 * 便於測試）。寫入被拒（`write()` 回 `key: reason`）→ 顯示原因、不落檔。
 */
export async function runSettingsWizard(
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<void> {
  let live = config;
  for (;;) {
    const groupRows = GROUPS.map((group) => renderGroupRow(group.id, live));
    const chosen = await hooks.pick(MENU_LABEL, [...groupRows, DONE_OPTION]);
    if (chosen === null || chosen === DONE_OPTION) return;
    const group = groupOf(chosen);
    if (group === null) {
      notice(hooks, `未識別的選單項目：${chosen.slice(0, 40)}`, "error");
      return;
    }

    for (;;) {
      const itemRows = GROUP_ITEMS[group].map((item) => renderItemRow(item, live));
      const picked = await hooks.pick(`${groupName(group)}：選一項`, [...itemRows, BACK_OPTION]);
      if (picked === null || picked === BACK_OPTION) break;
      const item = itemOf(group, picked);
      if (item === null) {
        notice(hooks, `未識別的項目：${picked.slice(0, 40)}`, "error");
        break;
      }

      const edited = await editItem(item, live, hooks);
      if (edited === undefined || edited === null) continue; // 取消 / 寫入被拒
      const problem = hooks.write(edited.key, edited.value);
      if (problem !== null) {
        notice(hooks, `未寫入：${problem}`, "error");
        continue;
      }
      notice(hooks, `已寫入 ${edited.key}`, "info");
      const fresh = await hooks.reload();
      if (fresh !== null && fresh !== undefined && typeof fresh === "object") live = fresh;
      Object.assign(live, edited.applyTo(live));
    }
  }
}

function groupName(group: Group): string {
  return GROUPS.find((entry) => entry.id === group)?.name ?? group;
}

/** 組列 → Group（列首就是組名，前綴比對）。 */
function groupOf(row: string): Group | null {
  for (const group of GROUPS) {
    if (row.startsWith(group.name)) return group.id;
  }
  return null;
}

/** 項目列 → MenuItem（`ITEM_NAMES` 前綴比對，值變了也認得）。 */
function itemOf(group: Group, row: string): MenuItem | null {
  for (const item of GROUP_ITEMS[group]) {
    if (row.startsWith(ITEM_NAMES[item])) return item;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 各項編輯
// ---------------------------------------------------------------------------

/** 一項設定的編輯結果：要寫的 key/value + 寫入後如何反映到 config。 */
interface EditResult {
  /** 落檔的 patch（**只帶要改的鍵**；`null` 子鍵 = 刪除，Part 3.4）。 */
  key: string;
  value: unknown;
  applyTo(config: CompassConfig): Partial<CompassConfig>;
}

/** `classify` 區塊的編輯結果（patch 只帶被改的鍵；`applyTo` 套在活設定上）。 */
function classifyEdit(value: Partial<CompassConfig["classify"]>): EditResult {
  return {
    key: "classify",
    value,
    applyTo: (live) => ({ classify: { ...live.classify, ...value } }),
  };
}

/** 單鍵整值替換的編輯結果（布林或枚舉）。 */
function simpleEdit(key: string, value: unknown, apply: Partial<CompassConfig>): EditResult {
  return { key, value, applyTo: () => apply };
}

/** 依項目提示使用者編輯；回 `undefined` 取消、`null` 已被 hooks 呈現拒絕。 */
async function editItem(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ① 路由
    case "enabled": {
      const picked = await pickFrom(hooks, "啟用 compass", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const enabled = picked === "開";
      return simpleEdit("enabled", enabled, { enabled });
    }

    case "mode": {
      const picked = await pickFrom(
        hooks,
        `路由模式（目前：${config.mode}）`,
        (["auto", "confirm", "notify"] as Mode[]).map(modeLabel),
      );
      if (picked === undefined || picked === null) return picked;
      const mode = modeFromLabel(picked);
      if (mode === null) return null;
      return { key: "mode", value: mode, applyTo: () => ({ mode }) };
    }

    case "stickiness": {
      const picked = await pickFrom(hooks, "粘住當前模型", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const stickiness = picked === "開";
      return simpleEdit("stickiness", stickiness, { stickiness });
    }

    case "modelPick": {
      const picked = await pickFrom(hooks, "手動挑模型", ["off — 不挑，走自動路由", "menu — 每次用選單挑"]);
      if (picked === undefined || picked === null) return picked;
      const modelPick = picked.startsWith("menu") ? ("menu" as const) : ("off" as const);
      return simpleEdit("modelPick", modelPick, { modelPick });
    }

    case "allowUnratedPicks": {
      const picked = await pickFrom(hooks, "允許未評分模型", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const allowUnratedPicks = picked === "開";
      return simpleEdit("allowUnratedPicks", allowUnratedPicks, { allowUnratedPicks });
    }

    case "thinking": {
      const scopes = ["pin（全域覆蓋）", ...Object.keys(config.taskKinds)];
      const scopeRow = await pickFrom(hooks, "思考層級：選範圍", scopes);
      if (scopeRow === undefined || scopeRow === null) return scopeRow;
      const isPin = scopeRow.startsWith("pin");
      const kind = isPin ? "pin" : scopeRow;

      const levelRows = [CLEAR_OPTION, ...THINKING_LEVELS.map(thinkingLabel)];
      const levelRow = await pickFrom(hooks, `${kind} 的思考層級`, levelRows);
      if (levelRow === undefined || levelRow === null) return levelRow;
      const level = levelRow === CLEAR_OPTION ? null : thinkingFromLabel(levelRow);
      if (level === undefined || (levelRow !== CLEAR_OPTION && level === null)) return null;
      const value: Partial<Record<string, ThinkingLevel | null>> = { [kind]: level };
      return {
        key: "thinking",
        value,
        applyTo: (live) => {
          const next = { ...live.thinking };
          const level = value[kind];
          if (level === null) delete next[kind];
          else next[kind] = level ?? undefined;
          return { thinking: next };
        },
      };
    }

    case "cache": {
      const fields: ReadonlyArray<{ key: string; label: string }> = [
        { key: "aware", label: `感知（aware）— ${onOff(config.cache.aware)}` },
        { key: "cooldownSeconds", label: `冷卻秒數 — ${config.cache.cooldownSeconds}s` },
        { key: "deadband", label: `死區 deadband — ${config.cache.deadband}` },
        { key: "maxPenaltyUsd", label: `切換懲罰上限 — $${config.cache.maxPenaltyUsd}` },
        { key: "bypassTierDelta", label: `繞過層級差 — ${config.cache.bypassTierDelta}` },
      ];
      const fieldRow = await pickFrom(hooks, "切換成本 cache：選欄位", fields.map((f) => f.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;
      const name = field.label.split(" — ")[0];

      let patch: Record<string, unknown>;
      if (field.key === "aware") {
        const picked = await pickFrom(hooks, "cache 感知", ["開", "關"]);
        if (picked === undefined || picked === null) return picked;
        patch = { aware: picked === "開" };
      } else {
        const presets: readonly number[] =
          field.key === "cooldownSeconds"
            ? [0, 5, 15, 30, 60, 120, 300, 600]
            : field.key === "deadband"
              ? [0, 0.1, 0.25, 0.5, 1]
              : field.key === "maxPenaltyUsd"
                ? [0, 0.01, 0.05, 0.1, 0.25]
                : [0, 1, 2, 3, 5];
        const current = config.cache[field.key as keyof typeof config.cache];
        const options = presets.map((value) => String(value));
        if (typeof current === "number" && !presets.includes(current)) options.unshift(String(current));
        options.push(CUSTOM_OPTION);

        const picked = await pickFrom(hooks, name, options);
        if (picked === undefined || picked === null) return picked;
        if (picked === CUSTOM_OPTION) {
          const typed = await promptLoop(
            hooks,
            `${name}（數字）`,
            String(current),
            (text) => (parseAmount(text) !== null ? null : `「${text}」不是有效數字`),
          );
          if (typed === undefined) return undefined;
          patch = { [field.key]: parseAmount(typed) };
        } else {
          patch = { [field.key]: Number(picked) };
        }
      }
      return {
        key: "cache",
        value: patch,
        applyTo: (live) => ({ cache: { ...live.cache, ...patch } }),
      };
    }

    // ------------------------------------------------------------ ② 預算
    case "daily":
    case "monthly": {
      const daily = item === "daily";
      const label = daily ? "每日上限" : "每月上限";
      const dim = daily ? ("dailyUsd" as const) : ("monthlyUsd" as const);
      const current = daily ? config.budget.dailyUsd : config.budget.monthlyUsd;
      const presets: readonly number[] = daily ? DAILY_PRESETS : MONTHLY_PRESETS;

      const options: string[] = ["無上限（清除）"];
      if (current !== null && !presets.includes(current)) options.push(`沿用目前 ${money(current)}`);
      for (const preset of presets) options.push(money(preset));
      options.push(CUSTOM_OPTION);

      const picked = await pickFrom(hooks, label, options);
      if (picked === undefined || picked === null) return picked;

      let amount: number | null;
      if (picked === "無上限（清除）") amount = null;
      else if (picked.startsWith("沿用目前")) amount = current;
      else if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(
          hooks,
          `${label}（美元數字，留空 = 無上限）`,
          current === null ? "" : String(current),
          (text) => {
            if (text === "") return null;
            const value = parseAmount(text);
            return value !== null && value > 0 ? null : `「${text}」不是有效金額（需 > 0；要清除請留空）`;
          },
        );
        if (typed === undefined) return undefined;
        amount = typed === "" ? null : parseAmount(typed);
      } else {
        amount = Number(picked.replace(/[$,]/g, ""));
      }

      const value: Record<string, unknown> = { [dim]: amount };
      return {
        key: "budget",
        value,
        applyTo: (live) => ({ budget: { ...live.budget, [dim]: amount } }),
      };
    }

    case "ratios": {
      const fields = [
        { key: "softRatio" as const, label: `軟警戒線 softRatio — ${config.budget.softRatio}` },
        { key: "hardRatio" as const, label: `強制線 hardRatio — ${config.budget.hardRatio}` },
      ];
      const fieldRow = await pickFrom(hooks, "預算警戒線：選欄位", fields.map((f) => f.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;

      const current = config.budget[field.key];
      const options = RATIO_PRESETS.map((value) => String(value));
      if (!options.includes(String(current))) options.unshift(String(current));
      options.push(CUSTOM_OPTION);
      const picked = await pickFrom(hooks, field.label.split(" — ")[0], options);
      if (picked === undefined || picked === null) return picked;

      let ratio: number;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, `${field.key}（0–1 之間）`, String(current), (text) => {
          const value = parseAmount(text);
          return value !== null && value <= 1 ? null : `「${text}」不是 0–1 之間的數字`;
        });
        if (typed === undefined) return undefined;
        ratio = parseAmount(typed) as number;
      } else {
        ratio = Number(picked);
      }
      const value: Record<string, unknown> = { [field.key]: ratio };
      return {
        key: "budget",
        value,
        applyTo: (live) => ({ budget: { ...live.budget, [field.key]: ratio } }),
      };
    }

    case "profile": {
      const picked = await pickFrom(
        hooks,
        `價格 profile（目前：${config.profile}）`,
        (["cheap", "balanced", "quality"] as Profile[]).map(profileLabel),
      );
      if (picked === undefined || picked === null) return picked;
      const profile = profileFromLabel(picked);
      if (profile === null) return null;
      return { key: "profile", value: profile, applyTo: () => ({ profile }) };
    }

    case "freeOnly": {
      const picked = await pickFrom(hooks, "特殊情境（free-only）", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const freeOnly = picked === "開";
      return simpleEdit("freeOnly", freeOnly, { freeOnly });
    }

    // ------------------------------------------------------------ ③ 模型
    case "chains":
    case "kindModels": {
      const isKind = item === "kindModels";
      const pools: ReadonlyArray<{ name: string; chain: Target[] }> = isKind
        ? dedupe([...Object.keys(config.taskKinds), ...Object.keys(config.kindModels)]).map((kind) => ({
            name: kind,
            chain: config.kindModels[kind] ?? [],
          }))
        : TIERS.map((tier) => ({ name: tier, chain: config.routes[tier] }));

      const poolRows = pools.map((pool) => `${pool.name} — ${chainSummary(pool.chain)}`);
      const poolRow = await pickFrom(
        hooks,
        isKind ? "專家鏈：選任務種類" : "模型鏈：選層級",
        poolRows,
      );
      if (poolRow === undefined || poolRow === null) return poolRow;
      const pool = pools.find((candidate) => poolRow.startsWith(`${candidate.name} — `));
      if (!pool) return null;

      const chainText = pool.chain.length === 0 ? "(空)" : pool.chain.map(keyOf).join(" → ");
      const actions = [
        "設為首選…",
        "放到末尾…",
        ...(pool.chain.length > 0 ? ["移除一個模型…"] : []),
        ...(pool.chain.some((target) => target.explicit) ? ["改回自動（清除你寫的）"] : []),
        "自訂整條字串…",
      ];
      const action = await pickFrom(hooks, `${pool.name} 鏈 · 目前 ${chainText}`, actions);
      if (action === undefined || action === null) return action;

      const key = isKind ? "kindModels" : "routes";

      if (action === "改回自動（清除你寫的）") {
        // patch null = 刪子鍵：L1 事實自動推導恢復接管該層（routes），
        // 或回層級鏈（kindModels）。
        return {
          key,
          value: { [pool.name]: null },
          applyTo: (live) => {
            const fallback = isKind
              ? (DEFAULT_CONFIG.kindModels[pool.name] ?? []).map((target) => ({ ...target }))
              : (DEFAULT_CONFIG.routes[pool.name as Tier] ?? []).map((target) => ({ ...target }));
            return applyChainFor(live, isKind, pool.name, fallback);
          },
        };
      }

      let next: Target[];
      if (action === "自訂整條字串…") {
        const typed = await promptLoop(
          hooks,
          `${pool.name} 鏈（provider/model, 逗號分隔）`,
          pool.chain.map(keyOf).join(", "),
          (text) => (parseChain(text).length > 0 ? null : "至少要一個模型，例如 openrouter/x"),
        );
        if (typed === undefined) return undefined;
        next = parseChain(typed);
      } else if (action === "移除一個模型…") {
        const pickedKey = await pickFrom(hooks, `${pool.name} 鏈：移除哪一個？`, pool.chain.map(keyOf));
        if (pickedKey === undefined || pickedKey === null) return pickedKey;
        next = pool.chain.filter((target) => keyOf(target) !== pickedKey);
        if (next.length === 0) {
          notice(hooks, "鏈不能是空的——至少留一個模型（要整層回自動，選「改回自動」）", "warning");
          return null;
        }
      } else {
        const chosenModel = await chooseModel(
          hooks,
          config,
          `${pool.name} 鏈：${action === "設為首選…" ? "選首選模型" : "選要放的模型"}`,
          pool.chain[0] ? keyOf(pool.chain[0]) : "",
        );
        if (chosenModel === undefined || chosenModel === null) return chosenModel;
        const target = splitTarget(chosenModel);
        const rest = pool.chain.filter((existing) => keyOf(existing) !== chosenModel);
        next = action === "設為首選…" ? [target, ...rest] : [...rest, target];
      }

      const chainValue = next.map((target) => ({ ...target, explicit: true }));
      return {
        key,
        value: { [pool.name]: chainValue },
        applyTo: (live) => applyChainFor(live, isKind, pool.name, chainValue),
      };
    }

    case "prefer": {
      const tierRows = TIERS.map((tier) => {
        const head = config.prefer[tier]?.[0];
        return `${tier}（${head ?? "未設定"}）`;
      });
      const tierRow = await pickFrom(hooks, "prefer 首選：選層級", tierRows);
      if (tierRow === undefined || tierRow === null) return tierRow;
      const tier = tierRow.slice(0, tierRow.indexOf("（")) as Tier;

      const picked = await pickModelFrom(
        hooks,
        `${tier} 的偏好首選（會插到鏈首）`,
        await modelCandidates(config, hooks),
        [CLEAR_OPTION],
      );
      if (picked === undefined || picked === null) return picked;

      if (picked === CLEAR_OPTION) {
        return {
          key: "prefer",
          value: { [tier]: null },
          applyTo: (live) => {
            const next = { ...live.prefer };
            delete next[tier];
            return { prefer: next };
          },
        };
      }
      let model = picked;
      if (model === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, `${tier} 偏好首選（模型 id）`, config.prefer[tier]?.[0] ?? "", (text) =>
          text === "" ? "模型 id 不能是空字串" : null,
        );
        if (typed === undefined) return undefined;
        model = typed;
      }
      return {
        key: "prefer",
        value: { [tier]: [model] },
        applyTo: (live) => ({ prefer: { ...live.prefer, [tier]: [model] } }),
      };
    }

    case "kindTiers": {
      const kinds = dedupe([...Object.keys(config.taskKinds), ...Object.keys(config.kindMinimumTier)]);
      const kindRows = kinds.map((kind) => `${kind} — 目前 ${config.kindMinimumTier[kind] ?? "（無下限）"}`);
      const kindRow = await pickFrom(hooks, "任務最低層級：選種類", kindRows);
      if (kindRow === undefined || kindRow === null) return kindRow;
      const kind = kindRow.split(" — ")[0];

      const tierPicked = await pickFrom(hooks, `${kind} 的最低層級`, TIERS.map(tierLabel));
      if (tierPicked === undefined || tierPicked === null) return tierPicked;
      const tier = tierFromLabel(tierPicked);
      if (tier === null) return null;

      return {
        key: "kindMinimumTier",
        value: { [kind]: tier },
        applyTo: (live) => ({ kindMinimumTier: { ...live.kindMinimumTier, [kind]: tier } }),
      };
    }

    case "xpremium": {
      const picked = await pickFrom(hooks, "xpremium 層", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const value = { enabled: picked === "開" };
      return simpleEdit("xpremium", value, { xpremium: value });
    }

    case "useDefaultModels": {
      const picked = await pickFrom(hooks, "內建模型鏈", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const useDefaultModels = picked === "開";
      return simpleEdit("useDefaultModels", useDefaultModels, { useDefaultModels });
    }

    // ------------------------------------------------------------ ④ 分類
    case "provider": {
      // 選項要把「選到的是哪個分類器」講清楚，並帶上 cloud 目前的模型
      // （動態尾巴由 providerFromLabel 的前綴比對認回代號）。
      const cloudModel = `${config.classify.cloud.provider}/${config.classify.cloud.model}`;
      const options = [providerLabel("laya"), `${providerLabel("cloud")} · ${cloudModel}`];
      const picked = await pickFrom(hooks, `分類後端（目前：${config.classify.provider}）`, options);
      if (picked === undefined || picked === null) return picked;
      const provider = providerFromLabel(picked);
      if (provider === null || (provider !== "laya" && provider !== "cloud")) return null;
      const value = { provider: provider as "laya" | "cloud" };
      return classifyEdit(value);
    }

    case "checkpoint": {
      const cloud = config.classify.provider === "cloud";
      const label = cloud ? "分類模型（cloud）" : "Laya checkpoint";
      const current = cloud
        ? `${config.classify.cloud.provider}/${config.classify.cloud.model}`
        : config.classify.model;
      // 內建預設永遠是候選之一：候選來源全空時也不會把人逼去打字。
      const seed = cloud
        ? `${DEFAULT_CONFIG.classify.cloud.provider}/${DEFAULT_CONFIG.classify.cloud.model}`
        : DEFAULT_CONFIG.classify.model;
      const provided = dedupe((await hooks.candidates?.(cloud ? "classifier" : "checkpoint")) ?? []);
      const options = dedupe([current, seed, ...provided]);
      const check = (text: string): string | null => (text === "" ? "模型 id 不能是空字串" : null);

      const picked = await pickFrom(hooks, label, [...options, CUSTOM_OPTION]);
      if (picked === undefined || picked === null) return picked;
      let chosen: string;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, `${label}（id 或路徑）`, current, check);
        if (typed === undefined) return undefined;
        chosen = typed;
      } else chosen = picked;

      if (cloud) {
        const target = splitTarget(chosen);
        return classifyEdit({
          cloud: { provider: target.provider || config.classify.cloud.provider, model: target.model },
        });
      }
      return classifyEdit({ model: chosen });
    }

    case "classifyCache": {
      const fields: ReadonlyArray<{ key: "cache" | "cacheTtlSeconds"; label: string }> = [
        { key: "cache", label: `分類結果快取 — ${onOff(config.classify.cache)}` },
        { key: "cacheTtlSeconds", label: `快取秒數（TTL）— ${config.classify.cacheTtlSeconds}s` },
      ];
      const fieldRow = await pickFrom(hooks, "分類快取：選欄位", fields.map((field) => field.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;

      if (field.key === "cache") {
        const picked = await pickFrom(hooks, "分類結果快取", ["開", "關"]);
        if (picked === undefined || picked === null) return picked;
        return classifyEdit({ cache: picked === "開" });
      }

      const current = config.classify.cacheTtlSeconds;
      const options = ["30", "60", "120", "300", "600", "900"];
      if (!options.includes(String(current))) options.unshift(String(current));
      options.push(CUSTOM_OPTION);
      const picked = await pickFrom(hooks, "分類快取秒數（TTL）", options);
      if (picked === undefined || picked === null) return picked;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, "分類快取秒數（TTL，整數秒）", String(current), (text) =>
          /^\d+$/.test(text) ? null : `「${text}」不是整數秒`,
        );
        if (typed === undefined) return undefined;
        return classifyEdit({ cacheTtlSeconds: Number(typed) });
      }
      return classifyEdit({ cacheTtlSeconds: Number(picked) });
    }

    case "classifyNums": {
      type NumKey = "timeoutMs" | "confidenceThreshold" | "minPromptChars" | "historyTurns";
      const fields: ReadonlyArray<{ key: NumKey; label: string; presets: readonly number[] }> = [
        { key: "timeoutMs", label: `分類逾時 timeoutMs — ${config.classify.timeoutMs}ms`, presets: CLASSIFY_NUM_PRESETS.timeoutMs },
        {
          key: "confidenceThreshold",
          label: `判斷門檻 confidenceThreshold — ${config.classify.confidenceThreshold}`,
          presets: CLASSIFY_NUM_PRESETS.confidenceThreshold,
        },
        { key: "minPromptChars", label: `最短字數 minPromptChars — ${config.classify.minPromptChars}`, presets: CLASSIFY_NUM_PRESETS.minPromptChars },
        { key: "historyTurns", label: `歷史輪數 historyTurns — ${config.classify.historyTurns}`, presets: CLASSIFY_NUM_PRESETS.historyTurns },
      ];
      const fieldRow = await pickFrom(hooks, "分類參數：選欄位", fields.map((field) => field.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;

      const current = config.classify[field.key];
      const options = field.presets.map((value) => String(value));
      if (!options.includes(String(current))) options.unshift(String(current));
      options.push(CUSTOM_OPTION);
      const picked = await pickFrom(hooks, field.label.split(" — ")[0], options);
      if (picked === undefined || picked === null) return picked;

      const patch = (value: number): Partial<CompassConfig["classify"]> =>
        ({ [field.key]: value }) as Partial<CompassConfig["classify"]>;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, `${field.label.split(" — ")[0]}（數字）`, String(current), (text) => {
          const value = parseAmount(text);
          return value !== null ? null : `「${text}」不是有效數字`;
        });
        if (typed === undefined) return undefined;
        return classifyEdit(patch(parseAmount(typed) as number));
      }
      return classifyEdit(patch(Number(picked)));
    }

    // ------------------------------------------------------------ ⑤ 政策
    case "filters": {
      const lists = [
        `deny — 排除模型／glob（${config.deny.length}）`,
        `allowProviders — 只放行這些 provider（${config.allowProviders.length}）`,
      ];
      const listRow = await pickFrom(hooks, "過濾規則：選一份清單", lists);
      if (listRow === undefined || listRow === null) return listRow;
      const isDeny = listRow.startsWith("deny");
      const key = isDeny ? "deny" : "allowProviders";
      const current = isDeny ? config.deny : config.allowProviders;

      const pool = isDeny
        ? dedupe([...current, ...ownModelKeys(config), ...factKeys()])
        : ownProviders(config);
      const rows = pool.map((entry) => `${current.includes(entry) ? "✓" : "✗"} ${entry}`);
      const addLabel = isDeny ? "新增 glob 模式…" : "新增 provider…";
      const pickedRow = await pickFrom(
        hooks,
        isDeny ? "deny：選一項切換（✓ = 已排除）" : "allowProviders：選一項切換（✓ = 已放行）",
        [...rows, addLabel],
      );
      if (pickedRow === undefined || pickedRow === null) return pickedRow;

      let next: string[];
      if (pickedRow === addLabel) {
        const typed = await promptLoop(
          hooks,
          isDeny ? "新增 deny 模式（glob，例如 openai/*）" : "新增 provider 代號",
          "",
          (text) => (text === "" ? "內容不能是空字串" : null),
        );
        if (typed === undefined) return undefined;
        next = dedupe([...current, typed]);
      } else {
        const entry = pickedRow.slice(2); // 剝掉 "✓ " / "✗ "
        next = current.includes(entry) ? current.filter((value) => value !== entry) : [...current, entry];
      }
      const applied: Partial<CompassConfig> = { [key]: next } as Partial<CompassConfig>;
      return { key, value: next, applyTo: () => applied };
    }

    case "ceilings": {
      const tierRows = TIERS.map((tier) => {
        const own = config.ceilings[tier];
        const inherited = PROFILE_CEILINGS[config.profile][tier];
        return `${tier}（${own !== undefined ? `自訂 ${money(own)}` : `依 profile ${money(inherited)}`}）`;
      });
      const tierRow = await pickFrom(hooks, "價格天花板：選層級", tierRows);
      if (tierRow === undefined || tierRow === null) return tierRow;
      const tier = tierRow.slice(0, tierRow.indexOf("（")) as Tier;

      const numeric = dedupe(
        (["cheap", "balanced", "quality"] as Profile[])
          .map((profile) => PROFILE_CEILINGS[profile][tier])
          .filter((value): value is number => typeof value === "number")
          .map((value) => String(value)),
      );
      const options = ["依 profile（清除自訂）", ...numeric, CUSTOM_OPTION];
      const picked = await pickFrom(hooks, `${tier} 的天花板（$/M：input+2×output）`, options);
      if (picked === undefined || picked === null) return picked;

      if (picked === "依 profile（清除自訂）") {
        return {
          key: "ceilings",
          value: { [tier]: null },
          applyTo: (live) => {
            const next = { ...live.ceilings };
            delete next[tier];
            return { ceilings: next };
          },
        };
      }
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, `${tier} 天花板（$/M 數字）`, "", (text) =>
          parseAmount(text) !== null ? null : `「${text}」不是有效數字`,
        );
        if (typed === undefined) return undefined;
        const value = parseAmount(typed) as number;
        return {
          key: "ceilings",
          value: { [tier]: value },
          applyTo: (live) => ({ ceilings: { ...live.ceilings, [tier]: value } }),
        };
      }
      const value = Number(picked);
      return {
        key: "ceilings",
        value: { [tier]: value },
        applyTo: (live) => ({ ceilings: { ...live.ceilings, [tier]: value } }),
      };
    }

    // ------------------------------------------------------------ ⑥ 診斷
    case "reset": {
      const targets: ReadonlyArray<{ key: string; label: string }> = [
        { key: "enabled", label: `enabled — ${onOff(config.enabled)}` },
        { key: "mode", label: `mode — ${config.mode}` },
        { key: "profile", label: `profile — ${config.profile}` },
        { key: "budget", label: `budget — ${money(config.budget.dailyUsd)} / ${money(config.budget.monthlyUsd)}` },
        { key: "cache", label: `cache — ${onOff(config.cache.aware)} · 冷卻 ${config.cache.cooldownSeconds}s` },
        { key: "kindMinimumTier", label: `kindMinimumTier — ${Object.keys(config.kindMinimumTier).length} 種` },
        { key: "freeOnly", label: `freeOnly — ${onOff(config.freeOnly)}` },
        { key: "classify", label: `classify — ${config.classify.provider} · ${config.classify.model}` },
        { key: "deny", label: `deny — ${config.deny.length} 條` },
        { key: "allowProviders", label: `allowProviders — ${config.allowProviders.length} 條` },
        { key: "modelPick", label: `modelPick — ${config.modelPick}` },
        { key: "stickiness", label: `stickiness — ${onOff(config.stickiness)}` },
        { key: "autoRoutes", label: `autoRoutes — ${onOff(config.autoRoutes)}` },
        { key: "allowUnratedPicks", label: `allowUnratedPicks — ${onOff(config.allowUnratedPicks)}` },
        { key: "useDefaultModels", label: `useDefaultModels — ${onOff(config.useDefaultModels)}` },
        { key: "xpremium", label: `xpremium — ${onOff(config.xpremium.enabled)}` },
        { key: "thinking", label: `thinking — pin ${config.thinking.pin ?? "（無）"}` },
        { key: "prefer", label: `prefer — ${Object.keys(config.prefer).length} 層` },
        { key: "ceilings", label: `ceilings — ${Object.keys(config.ceilings).length} 層自訂` },
        { key: "routes", label: `routes — 全部五層回自動派生` },
        { key: "kindModels", label: `kindModels — 全部回層級鏈` },
      ];
      const picked = await pickFrom(hooks, "重設哪一項？（清單為白名單可寫鍵）", targets.map((t) => t.label));
      if (picked === undefined || picked === null) return picked;
      const target = targets.find((candidate) => candidate.label === picked);
      if (!target) return null;

      const confirm = await pickFrom(hooks, `重設 ${target.key} 回預設？`, ["確定，重設", "取消"]);
      if (confirm === undefined || confirm === null) return confirm;
      if (confirm !== "確定，重設") return undefined;

      if (target.key === "routes" || target.key === "kindModels") {
        // 整組清除（patch null 逐層刪除）→ 回自動派生／回層級鏈。
        const keys = target.key === "routes" ? TIERS : Object.keys(config.kindModels);
        const patchValue = Object.fromEntries(keys.map((name) => [name, null]));
        return {
          key: target.key,
          value: patchValue,
          applyTo: (live) => {
            if (target.key === "routes") {
              return {
                routes: Object.fromEntries(
                  TIERS.map((tier) => [tier, (DEFAULT_CONFIG.routes[tier] ?? []).map((t) => ({ ...t }))]),
                ) as CompassConfig["routes"],
              };
            }
            return { kindModels: {} };
          },
        };
      }

      const value = structuredClone(DEFAULT_CONFIG[target.key as keyof typeof DEFAULT_CONFIG]);
      const applied = { [target.key]: value } as Partial<CompassConfig>;
      return { key: target.key, value, applyTo: () => applied };
    }

    case "testClassifier": {
      if (!hooks.probeClassifier) {
        notice(hooks, "這個環境不支援測試分類器（沒有掛點）", "warning");
        return undefined;
      }
      const result = await hooks.probeClassifier();
      notice(hooks, result, "info");
      return undefined;
    }

    case "chainSource": {
      const tierRows = TIERS.map((tier) => `${tier}（${chainSummary(config.routes[tier])}）`);
      const tierRow = await pickFrom(hooks, "看鏈的來源：選層級", tierRows);
      if (tierRow === undefined || tierRow === null) return tierRow;
      const tier = tierRow.slice(0, tierRow.indexOf("（")) as Tier;

      const stale = staleDays();
      const lines = [
        `${tier} 鏈（事實檔 ${factsDate()} · 自動推導 ${onOff(config.autoRoutes)} · 內建 ${onOff(config.useDefaultModels)}）`,
        ...(stale === null
          ? []
          : [`⚠ 事實檔快照已 ${stale} 天——建議跑 npm run refresh-facts（價格與模型清單會跟著更新）`]),
        ...config.routes[tier].map(
          (target) => `  ${keyOf(target)} — ${target.explicit ? "你寫的（鎖定，不過濾）" : "自動派生／內建"}`,
        ),
        ...(config.prefer[tier]?.length
          ? [`  prefer 首選 ${config.prefer[tier][0]} — 會插到鏈首（L3）`]
          : []),
      ];
      notice(hooks, lines.join("\n"), "info");
      return undefined;
    }
  }
}

/** 鏈編輯的 applyTo 共用：把新鏈放到 routes 或 kindModels。 */
function applyChainFor(
  live: CompassConfig,
  isKind: boolean,
  name: string,
  chain: Target[],
): Partial<CompassConfig> {
  return isKind
    ? { kindModels: { ...live.kindModels, [name]: chain } }
    : { routes: { ...live.routes, [name as Tier]: chain } };
}
