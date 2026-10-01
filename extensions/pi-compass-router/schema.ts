// schema.ts — 型別、枚舉、預設值（純模組，無 I/O）。
// 唯一來源：SPEC.md Part 3.1 完整鍵表、Part 3.3 環境變數、
// Part 5 Stage 2/3 常數、Part 9 價格帶表、Part 10.2 內建最低層級。

/** 模型層級。xpremium 僅在 `xpremium.enabled` 時進入候選（Part 3.1）。 */
export type Tier = "quick" | "standard" | "high" | "premium" | "xpremium";

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
 * 預設設定（SPEC Part 3.1 預設欄）。
 *
 * 規格缺口：`routes`、`kindModels`、`taskKinds` 的內建內容未在 SPEC 給出
 * （模型預設鏈被 Part 13 #7 明列為未定案），骨架以空候選鏈呈現，
 * 不自行猜測鏈內容。
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
  routes: { quick: [], standard: [], high: [], premium: [], xpremium: [] },
  kindModels: {},
  kindMinimumTier: { ...DEFAULT_KIND_MINIMUM_TIER },
  taskKinds: {},
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
