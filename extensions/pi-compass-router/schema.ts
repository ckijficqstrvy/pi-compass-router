// schema.ts — 型別、枚舉、預設值（純模組，無 I/O）。
// 唯一來源：SPEC.md Part 3.1 完整鍵表、Part 3.3 環境變數、
// Part 5 Stage 2/3 常數、Part 9 價格帶表、Part 10.2 內建最低層級。

/** 模型層級。xpremium 僅在 `xpremium.enabled` 時進入候選（Part 3.1）。 */
export type Tier = "quick" | "standard" | "high" | "premium" | "xpremium";

/**
 * 層級由低到高的**唯一**順序來源。compose / guard / facts 共用它，
 * 避免各檔自行維護一份順序而漂移（與 `TIER_THINKING` 同一理由）。
 */
export const TIERS: readonly Tier[] = ["quick", "standard", "high", "premium", "xpremium"];

/** 切換模式（Part 3.1 `mode`）。 */
export type Mode = "auto" | "confirm" | "notify";

/** 分類後端（Part 3.1 `classify.provider`，local-first 預設 laya）。 */
export type Provider = "laya" | "cloud";

/** 價格帶檔位（Part 3.1 `profile`）。 */
export type Profile = "cheap" | "balanced" | "quality";

/** 模型挑選開關（Part 3.1 `modelPick`）。 */
export type ModelPickMode = "off" | "menu";

/** 思考層級（Part 3.1 `thinkingLevel` 可能值）。 */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * 任務種類。種類集合由 `taskKinds` 設定決定、可由 JSON 覆寫（移植 #11），
 * 分類器只能在呼叫端傳入的集合內作答（Part 4.1），故型別為開放字串。
 */
export type TaskKind = string;

/** 路由候選（Part 3.1 `Target` 定義）。 */
export interface Target {
  provider: string;
  model: string;
  minTier?: Tier;
  thinkingLevel?: ThinkingLevel;
  priority?: number;
  /**
   * 由 config.json 寫入時標為 true（Part 9 L3）：**顯式設定永不過濾**——
   * `deny`／`allowProviders`／價格帶／freeOnly 都不碰它。
   * 內建鏈與 facts 推導的鏈不帶此旗標，因此可被 L1/L2 篩掉。
   */
  explicit?: boolean;
}

/** 任務種類規格（Part 3.1 `taskKinds` 元素）。 */
export interface TaskKindSpec {
  label: string;
  /** demand 下限（Part 5 Stage 2：demand = max(demand, floor)）。 */
  floor: number;
  priority?: number;
}

/** 分類區塊（Part 3.1 `classify.*`）。 */
export interface ClassifyConfig {
  provider: Provider;
  model: string;
  python: string;
  cloud: {
    provider: string;
    model: string;
  };
  timeoutMs: number;
  minPromptChars: number;
  historyTurns: number;
  cache: boolean;
  cacheTtlSeconds: number;
  confidenceThreshold: number;
}

/** 預算區塊（Part 3.1 `budget.*`；null/0 = 移除該維度上限，Part 8）。 */
export interface BudgetConfig {
  dailyUsd: number | null;
  monthlyUsd: number | null;
  softRatio: number;
  hardRatio: number;
}

/** 切換成本區塊（Part 3.1 `cache.*`；與分類快取 `classify.cache` 分開）。 */
export interface SwitchCacheConfig {
  aware: boolean;
  deadband: number;
  maxPenaltyUsd: number;
  bypassTierDelta: number;
  cooldownSeconds: number;
}

/** `thinking.pin` 與 `thinking.<kind>`（Part 3.1）。 */
export interface ThinkingConfig {
  pin?: ThinkingLevel;
  [kind: string]: ThinkingLevel | undefined;
}

/** 呈現密度（Part 3.1 `display.detail`、Part 10.4）：收合時顯示到什麼程度。 */
export type DisplayDetail = "compact" | "standard" | "full";

/**
 * 收合列可出現的欄位（Part 3.1 `display.fields`）。陣列順序 = 顯示順序；
 * 展開明細列不受影響（永遠攤開全部）。
 */
export type DisplayField = "kind" | "demand" | "thinking" | "classify" | "budget" | "reason" | "notes";

/** 配色（Part 3.1 `display.color`）：`rich` 跟隨主題全彩；`mono` 只留明暗/粗細。 */
export type DisplayColor = "rich" | "mono";

/** 界面語言（Part 3.1 `display.language`）：完整英文版的切換開關。 */
export type UiLang = "zh" | "en";

/** 呈現設定（Part 10.4 視覺規格的可調部分）。 */
export interface DisplayConfig {
  detail: DisplayDetail;
  fields: DisplayField[];
  badge: boolean;
  color: DisplayColor;
  hint: boolean;
  rails: boolean;
  language: UiLang;
}

/** display 枚舉的唯一來源（load.ts / wizard.ts 共用）。 */
export const DISPLAY_DETAILS: readonly DisplayDetail[] = ["compact", "standard", "full"];
export const DISPLAY_FIELDS: readonly DisplayField[] = [
  "kind",
  "demand",
  "thinking",
  "classify",
  "budget",
  "reason",
  "notes",
];
export const DISPLAY_COLORS: readonly DisplayColor[] = ["rich", "mono"];
export const UI_LANGS: readonly UiLang[] = ["zh", "en"];

/** display 預設（DEFAULT_CONFIG 與渲染端 fallback 共用，單一來源）。 */
export const DISPLAY_DEFAULTS: DisplayConfig = {
  detail: "standard",
  fields: [...DISPLAY_FIELDS],
  badge: true,
  color: "rich",
  hint: true,
  rails: true,
  language: "zh",
};

/** 內建層級候選鏈（Part 3.1 `routes`；預設鏈內容見 Part 13 #7，尚未定案）。 */
export type RoutesConfig = Record<Tier, Target[]>;

/** 完整設定（SPEC Part 3.1 逐一對應）。 */
export interface CompassConfig {
  enabled: boolean;
  mode: Mode;
  useDefaultModels: boolean;
  classify: ClassifyConfig;
  routes: RoutesConfig;
  kindModels: Record<TaskKind, Target[]>;
  kindMinimumTier: Record<TaskKind, Tier>;
  taskKinds: Record<TaskKind, TaskKindSpec>;
  xpremium: {
    enabled: boolean;
  };
  freePool: {
    enabled: boolean;
    models: Target[];
  };
  specialistPriority: Record<TaskKind, string[]>;
  suggest: {
    scoresFile: string;
  };
  budget: BudgetConfig;
  profile: Profile;
  ceilings: Partial<Record<Tier, number | null>>;
  deny: string[];
  allowProviders: string[];
  prefer: Partial<Record<Tier, string[]>>;
  autoRoutes: boolean;
  modelPick: ModelPickMode;
  allowUnratedPicks: boolean;
  freeOnly: boolean;
  stickiness: boolean;
  cache: SwitchCacheConfig;
  thinking: ThinkingConfig;
  display: DisplayConfig;
}

/**
 * 內建任務最低層級（Part 10.2「任務最低層級」預設展示）。
 * 10 種：plan/review ≥ high；implement/debug/refactor/research/operate ≥ standard；
 * chat/explain/write ≥ quick。
 */
export const DEFAULT_KIND_MINIMUM_TIER: Readonly<Record<string, Tier>> = {
  plan: "high",
  review: "high",
  implement: "standard",
  debug: "standard",
  refactor: "standard",
  research: "standard",
  operate: "standard",
  chat: "quick",
  explain: "quick",
  write: "quick",
};

/**
 * 內建任務種類（SPEC Part 3.1a）。`floor` 是 demand 下限（0–3 刻度），
 * 與 `kindMinimumTier` 的層級下限是兩回事。
 */
export const DEFAULT_TASK_KINDS: Readonly<Record<string, TaskKindSpec>> = {
  plan: { label: "Planning & design", floor: 1.5 },
  review: { label: "Review & audit", floor: 1.5 },
  implement: { label: "Implementation", floor: 1.0 },
  debug: { label: "Debugging", floor: 1.0 },
  refactor: { label: "Refactoring", floor: 1.0 },
  research: { label: "Research", floor: 1.0 },
  operate: { label: "Operation & tooling", floor: 0.5 },
  write: { label: "Writing", floor: 0.5 },
  explain: { label: "Explanation", floor: 0.5 },
  chat: { label: "Conversation", floor: 0.0 },
};

/**
 * 預設設定（SPEC Part 3.1 預設欄）。
 *
 * `routes` / `kindModels` 已於 2026-10-01 由 Part 13 #7 解除後定案：
 * 依 Part 9 balanced 價格帶切片（`npm run refresh-facts` 取得當日價格）。
 * `taskKinds` 見 Part 3.1a。
 */
export const DEFAULT_CONFIG: CompassConfig = {
  enabled: true,
  mode: "notify",
  useDefaultModels: true,
  classify: {
    provider: "laya",
    model: "aac6fef/laya-multilingual-mlx",
    python: "~/.pi/agent/pi-compass/venv/bin/python",
    cloud: {
      provider: "typesafe",
      model: "jev-latest",
    },
    timeoutMs: 800,
    minPromptChars: 12,
    historyTurns: 0,
    cache: true,
    cacheTtlSeconds: 300,
    confidenceThreshold: 0.34,
  },
  // 內建鏈 = 2026-10-01 依 Part 9 balanced 價格帶切片的前三名（能力降序）。
  // autoRoutes 開啟且事實檔可用時，載入時會用當日事實重新推導覆蓋這些
  // 非顯式條目；這裡的值只在事實檔不可用時充作 fail-open 起點（Part 9 L1）。
  // 要排除旗艦機型，在 config.json 設 `deny`（明寫的條目不受其影響）。
  routes: {
    quick: [
      { provider: "openrouter", model: "~z-ai/glm-flash-latest" },
      { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      { provider: "openrouter", model: "~openai/gpt-luna-latest" },
    ],
    standard: [{ provider: "openrouter", model: "xiaomi/mimo-v2.6-pro" }],
    high: [
      { provider: "openrouter", model: "~x-ai/grok-latest" },
      { provider: "openrouter", model: "~z-ai/glm-latest" },
      { provider: "openrouter", model: "meta/muse-spark-1.3" },
    ],
    premium: [
      { provider: "openrouter", model: "~anthropic/claude-opus-latest" },
      { provider: "openrouter", model: "openai/gpt-6-sol" },
      { provider: "openrouter", model: "moonshotai/kimi-k3" },
    ],
    xpremium: [{ provider: "openrouter", model: "openai/gpt-6-astra" }],
  },
  // 專家鏈（Part 3.1「內建」）：依任務性質選模型，minTier 决定何时可用。
  // 只用上面價格帶內的模型，避免專家鏈把便宜層引用到旗艦。
  kindModels: {
    plan: [
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "premium" },
      { provider: "openrouter", model: "~z-ai/glm-latest", minTier: "high" },
    ],
    review: [
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "high" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
    ],
    implement: [
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "high" },
    ],
    debug: [
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
      { provider: "openrouter", model: "openai/gpt-6-sol", minTier: "high" },
    ],
    refactor: [{ provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" }],
    operate: [{ provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" }],
    research: [
      { provider: "openrouter", model: "~deepseek/deepseek-pro-latest", minTier: "standard" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
    ],
    write: [
      { provider: "openrouter", model: "~anthropic/claude-sonnet-latest", minTier: "standard" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
    ],
    explain: [
      { provider: "openrouter", model: "~z-ai/glm-flash-latest", minTier: "quick" },
      { provider: "openrouter", model: "xiaomi/mimo-v2.6-pro", minTier: "standard" },
    ],
    chat: [{ provider: "openrouter", model: "~z-ai/glm-flash-latest", minTier: "quick" }],
  },
  kindMinimumTier: { ...DEFAULT_KIND_MINIMUM_TIER },
  taskKinds: { ...DEFAULT_TASK_KINDS },
  xpremium: { enabled: false },
  freePool: { enabled: false, models: [] },
  specialistPriority: {},
  suggest: { scoresFile: "" },
  budget: {
    dailyUsd: 5,
    monthlyUsd: 100,
    softRatio: 0.7,
    hardRatio: 0.9,
  },
  profile: "balanced",
  ceilings: {},
  deny: [],
  allowProviders: [],
  prefer: {},
  autoRoutes: true,
  modelPick: "off",
  allowUnratedPicks: false,
  freeOnly: false,
  stickiness: true,
  cache: {
    aware: true,
    deadband: 0.25,
    maxPenaltyUsd: 0.05,
    bypassTierDelta: 2,
    cooldownSeconds: 0,
  },
  thinking: {},
  // 呈現預設 = 「標準」風格：徽章 + 脈絡一列、全彩、expand 提示、樹狀導軌。
  display: { ...DISPLAY_DEFAULTS, fields: [...DISPLAY_DEFAULTS.fields] },
};

/** 每層預設 thinking（Part 5 Stage 2 `TIER_THINKING`）。 */
export const TIER_THINKING: Readonly<Record<Tier, ThinkingLevel>> = {
  quick: "off",
  standard: "low",
  high: "medium",
  premium: "high",
  xpremium: "max",
};

/** 每層能力分數下限（Part 5 Stage 3 menu gate 的 capability 門檻）。 */
export const TIER_CAPABILITY_FLOOR: Readonly<Record<Tier, number>> = {
  quick: 20,
  standard: 35,
  high: 38,
  premium: 44,
  xpremium: 46,
};

/**
 * 各價格帶檔位的每層天花板（Part 9 價格帶表），指標為
 * `input + 2×output` USD/M。`null` = 無上限（表中的 ∞）。
 */
export const PROFILE_CEILINGS: Readonly<
  Record<Profile, Readonly<Record<Tier, number | null>>>
> = {
  cheap: { quick: 1, standard: 3, high: 10, premium: 25, xpremium: 50 },
  balanced: { quick: 1.5, standard: 5, high: 15, premium: 44, xpremium: null },
  quality: { quick: 2, standard: 10, high: 44, premium: null, xpremium: null },
};
