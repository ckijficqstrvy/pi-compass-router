// config/env.ts — COMPASS_* 環境變數定義與解析（SPEC Part 3.3）。
import type { CompassConfig } from "../schema.js";

/**
 * 環境變數 → 設定鍵路徑的對應（Part 3.3 表，28 項）。
 * 解析順序為後者勝：內建預設 → config.json → 環境變數（Part 3.2）。
 */
export const COMPASS_ENV_MAP: Readonly<Record<string, string>> = {
  COMPASS_ENABLED: "enabled",
  COMPASS_MODE: "mode",
  COMPASS_USE_DEFAULT_MODELS: "useDefaultModels",
  COMPASS_PROVIDER: "classify.provider",
  COMPASS_TIMEOUT_MS: "classify.timeoutMs",
  COMPASS_MIN_PROMPT_CHARS: "classify.minPromptChars",
  COMPASS_HISTORY_TURNS: "classify.historyTurns",
  COMPASS_CACHE: "classify.cache",
  COMPASS_CACHE_TTL: "classify.cacheTtlSeconds",
  COMPASS_CONFIDENCE_THRESHOLD: "classify.confidenceThreshold",
  COMPASS_STICKINESS: "stickiness",
  COMPASS_BUDGET_DAILY_USD: "budget.dailyUsd",
  COMPASS_BUDGET_MONTHLY_USD: "budget.monthlyUsd",
  COMPASS_BUDGET_SOFT_RATIO: "budget.softRatio",
  COMPASS_BUDGET_HARD_RATIO: "budget.hardRatio",
  COMPASS_PROFILE: "profile",
  COMPASS_AUTO_ROUTES: "autoRoutes",
  COMPASS_MODEL_PICK: "modelPick",
  COMPASS_ALLOW_UNRATED_PICKS: "allowUnratedPicks",
  COMPASS_FREE_ONLY: "freeOnly",
  COMPASS_FREE_POOL: "freePool.enabled",
  COMPASS_XPREMIUM: "xpremium.enabled",
  COMPASS_CACHE_AWARE: "cache.aware",
  COMPASS_CACHE_DEADBAND: "cache.deadband",
  COMPASS_CACHE_MAX_PENALTY_USD: "cache.maxPenaltyUsd",
  COMPASS_CACHE_BYPASS_TIER_DELTA: "cache.bypassTierDelta",
  COMPASS_CACHE_COOLDOWN_SECONDS: "cache.cooldownSeconds",
  COMPASS_KIND_MIN_TIER: "kindMinimumTier",
};

/**
 * 環境層能改的東西。是 `CompassConfig` 的**嚴格子集**——
 * `routes`／`kindModels`／`taskKinds` 等結構化設定刻意不從環境可達
 * （Part 3.3：structured data belongs in config.json）。
 *
 * `budget.dailyUsd | null` 的 `null` 是**清除上限**的哨兵（Part 3.1），
 * 與「不覆寫」（鍵不存在）不同。
 */
export interface EnvPatch {
  enabled?: boolean;
  mode?: CompassConfig["mode"];
  useDefaultModels?: boolean;
  stickiness?: boolean;
  autoRoutes?: boolean;
  modelPick?: CompassConfig["modelPick"];
  allowUnratedPicks?: boolean;
  freeOnly?: boolean;
  profile?: CompassConfig["profile"];
  classify?: Partial<Omit<CompassConfig["classify"], "cloud">>;
  budget?: {
    dailyUsd?: number | null;
    monthlyUsd?: number | null;
    softRatio?: number;
    hardRatio?: number;
  };
  cache?: Partial<CompassConfig["cache"]>;
  xpremium?: { enabled?: boolean };
  freePool?: { enabled?: boolean };
  kindMinimumTier?: Record<string, CompassConfig["kindMinimumTier"][string]>;
}

export interface EnvOverrides {
  overrides: EnvPatch;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 解析原語
// ---------------------------------------------------------------------------

const INVALID = Symbol("invalid");
const CLEAR = Symbol("clear");

const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off"]);
const BOOL_EXPECTED = "1/0, true/false, yes/no, or on/off";
const CAP_CLEAR = new Set(["none", "off", "unlimited"]);
const CAP_EXPECTED = 'a number >= 0, or "none" to remove the cap';
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const TIERS = ["quick", "standard", "high", "premium", "xpremium"] as const;

const MODES = ["auto", "confirm", "notify"] as const;
const PROFILES = ["cheap", "balanced", "quality"] as const;
const MODEL_PICKS = ["off", "menu"] as const;
const PROVIDERS = ["laya", "cloud"] as const;

/**
 * 回顯原始值的條件（Part 3.3：只有短的可列印 ASCII 才回顯）。
 * 目的是讓貼錯位置的機密不會進到日誌或 transcript。
 */
function describeRaw(raw: string): string {
  return /^[\x20-\x7e]{1,40}$/.test(raw) ? JSON.stringify(raw) : "(value hidden)";
}

function parseBool(raw: string): boolean | typeof INVALID {
  const value = raw.trim().toLowerCase();
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;
  return INVALID;
}

function parseNumber(
  raw: string,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): number | typeof INVALID {
  const text = raw.trim();
  if (!NUMBER_RE.test(text)) return INVALID;
  const value = Number(text);
  if (!Number.isFinite(value)) return INVALID;
  if (opts.integer && !Number.isInteger(value)) return INVALID;
  if (opts.min !== undefined && value < opts.min) return INVALID;
  if (opts.max !== undefined && value > opts.max) return INVALID;
  return value;
}

function parseRatio(raw: string): number | typeof INVALID {
  return parseNumber(raw, { min: 0, max: 1 });
}

function parseCap(raw: string): number | typeof CLEAR | typeof INVALID {
  if (CAP_CLEAR.has(raw.trim().toLowerCase())) return CLEAR;
  return parseNumber(raw, { min: 0 });
}

function enumParse(values: readonly string[]) {
  return (raw: string): string | typeof INVALID => {
    const value = raw.trim().toLowerCase();
    return values.includes(value) ? value : INVALID;
  };
}

const KIND_MIN_TIER_EXPECTED =
  "comma-separated kind=tier pairs (e.g. plan=high,review=high)";

function parseKindMinTier(raw: string): Record<string, string> | typeof INVALID {
  const pairs: Record<string, string> = {};
  for (const segment of raw.split(",")) {
    if (!segment.trim()) continue;
    const eq = segment.indexOf("=");
    if (eq < 0) return INVALID;
    const kind = segment.slice(0, eq).trim().toLowerCase();
    const tier = segment.slice(eq + 1).trim().toLowerCase();
    if (!kind) return INVALID;
    if (!TIERS.includes(tier as (typeof TIERS)[number])) return INVALID;
    pairs[kind] = tier;
  }
  return Object.keys(pairs).length > 0 ? pairs : INVALID;
}

// ---------------------------------------------------------------------------
// 變數規格
// ---------------------------------------------------------------------------

interface EnvVarSpec {
  /** 鍵路徑，形如 `classify.timeoutMs`。 */
  path: string;
  expected: string;
  parse(raw: string): unknown;
  /** 解析成功後寫入 patch；回傳 true 表示有變更。 */
  apply(patch: EnvPatch, value: unknown): boolean;
}

function setFlat(patch: EnvPatch, key: string, value: unknown): boolean {
  const bag = patch as unknown as Record<string, unknown>;
  if (key in bag && bag[key] === value) return false;
  Object.assign(patch, { [key]: value });
  return true;
}

/**
 * 寫入一個鍵路徑。無 `.` 的是頂層鍵（`mode`、`enabled`、`profile` 等 9 項）；
 * 有 `.` 的是兩層桶（`classify.*`、`budget.*`、`cache.*`、`*.enabled`）。
 *
 * 頂層分支缺失曾導致整個環境頂層覆寫靜默失效——`return false` 讓呼叫端
 * 以為「值未變」，警告也不生，故單獨測試覆蓋（test/config.test.ts）。
 */
function setNested(patch: EnvPatch, path: string, value: unknown): boolean {
  const dot = path.indexOf(".");
  if (dot < 0) return setFlat(patch, path, value);
  const head = path.slice(0, dot);
  const tail = path.slice(dot + 1);
  const bucket = (patch as unknown as Record<string, Record<string, unknown> | undefined>)[head];
  if (!bucket) return false;
  if (bucket[tail] === value) return false;
  bucket[tail] = value;
  return true;
}

const NUM_SPEC = (path: string, expected: string, opts: { integer?: boolean; min?: number }) => ({
  path,
  expected,
  parse: (raw: string) => parseNumber(raw, opts),
  apply: (patch: EnvPatch, value: unknown) => setNested(patch, path, value),
});

const BOOL_SPEC = (path: string): EnvVarSpec => ({
  path,
  expected: BOOL_EXPECTED,
  parse: parseBool,
  apply: (patch, value) => setNested(patch, path, value),
});

const ENV_VARS: readonly EnvVarSpec[] = [
  BOOL_SPEC("enabled"),
  {
    path: "mode",
    expected: "auto, confirm, or notify",
    parse: enumParse(MODES),
    apply: (patch, value) => setNested(patch, "mode", value),
  },
  BOOL_SPEC("useDefaultModels"),
  BOOL_SPEC("stickiness"),
  BOOL_SPEC("autoRoutes"),
  {
    path: "modelPick",
    expected: "off or menu",
    parse: enumParse(MODEL_PICKS),
    apply: (patch, value) => setNested(patch, "modelPick", value),
  },
  BOOL_SPEC("allowUnratedPicks"),
  BOOL_SPEC("freeOnly"),
  {
    path: "profile",
    expected: "cheap, balanced, or quality",
    parse: enumParse(PROFILES),
    apply: (patch, value) => setNested(patch, "profile", value),
  },
  {
    path: "classify.provider",
    expected: "laya or cloud",
    parse: enumParse(PROVIDERS),
    apply: (patch, value) => setNested(patch, "classify.provider", value),
  },
  NUM_SPEC("classify.timeoutMs", "an integer >= 0 (milliseconds)", { integer: true, min: 0 }),
  NUM_SPEC("classify.minPromptChars", "an integer >= 0", { integer: true, min: 0 }),
  NUM_SPEC("classify.historyTurns", "an integer >= 0", { integer: true, min: 0 }),
  BOOL_SPEC("classify.cache"),
  NUM_SPEC("classify.cacheTtlSeconds", "an integer >= 0 (seconds)", { integer: true, min: 0 }),
  {
    path: "classify.confidenceThreshold",
    expected: "a number between 0 and 1",
    parse: parseRatio,
    apply: (patch, value) => setNested(patch, "classify.confidenceThreshold", value),
  },
  {
    path: "budget.dailyUsd",
    expected: CAP_EXPECTED,
    parse: parseCap,
    apply: (patch, value) =>
      setNested(patch, "budget.dailyUsd", value === CLEAR ? null : value),
  },
  {
    path: "budget.monthlyUsd",
    expected: CAP_EXPECTED,
    parse: parseCap,
    apply: (patch, value) =>
      setNested(patch, "budget.monthlyUsd", value === CLEAR ? null : value),
  },
  {
    path: "budget.softRatio",
    expected: "a number between 0 and 1, <= budget.hardRatio",
    parse: parseRatio,
    apply: (patch, value) => setNested(patch, "budget.softRatio", value),
  },
  {
    path: "budget.hardRatio",
    expected: "a number between 0 and 1, >= budget.softRatio",
    parse: parseRatio,
    apply: (patch, value) => setNested(patch, "budget.hardRatio", value),
  },
  BOOL_SPEC("freePool.enabled"),
  BOOL_SPEC("xpremium.enabled"),
  BOOL_SPEC("cache.aware"),
  NUM_SPEC("cache.deadband", "a number >= 0", { min: 0 }),
  NUM_SPEC("cache.maxPenaltyUsd", "a USD amount >= 0", { min: 0 }),
  NUM_SPEC("cache.bypassTierDelta", "an integer >= 0", { integer: true, min: 0 }),
  NUM_SPEC("cache.cooldownSeconds", "an integer >= 0 (seconds; 0 disables)", {
    integer: true,
    min: 0,
  }),
  {
    path: "kindMinimumTier",
    expected: KIND_MIN_TIER_EXPECTED,
    parse: parseKindMinTier,
    apply: (patch, value) => {
      const pairs = value as Record<string, string>;
      const existing = patch.kindMinimumTier ?? {};
      const next = { ...existing, ...pairs };
      const changed =
        Object.keys(next).length !== Object.keys(existing).length ||
        Object.entries(next).some(([k, v]) => existing[k] !== v);
      if (!changed) return false;
      patch.kindMinimumTier = next as EnvPatch["kindMinimumTier"];
      return true;
    },
  },
];

/** 變數名 → 規格；供 load.ts 與測試索引。 */
const SPEC_BY_NAME = new Map<string, EnvVarSpec>(
  Object.keys(COMPASS_ENV_MAP).map((name) => {
    const spec = ENV_VARS.find((candidate) => candidate.path === COMPASS_ENV_MAP[name]);
    if (!spec) throw new Error(`COMPASS_ENV_MAP references unmapped path: ${name}`);
    return [name, spec];
  }),
);

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 解析 COMPASS_* 環境變數。
 *
 * 規則（Part 3.3）：
 * - 空字串或純空白 = **未設定**，不動該項
 * - 非法值 → **丟棄該變數並警告**，前一層的值立住
 * - 警告只在原始值是 ≤40 字元可列印 ASCII 時才回顯，否則寫 `(value hidden)`
 * - `softRatio > hardRatio` 且兩者皆由環境給出 → 兩者都退回，警告
 */
export function parseEnvOverrides(env: Record<string, string | undefined>): EnvOverrides {
  const overrides: EnvPatch = {
    classify: {},
    budget: {},
    cache: {},
    xpremium: {},
    freePool: {},
  };
  const warnings: string[] = [];
  const applied: string[] = [];

  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined || raw.trim() === "") continue;
    const spec = SPEC_BY_NAME.get(name);
    if (!spec) continue;
    const value = spec.parse(raw);
    if (value === INVALID) {
      warnings.push(`${name}: expected ${spec.expected}, got ${describeRaw(raw)} — override ignored`);
      continue;
    }
    if (spec.apply(overrides, value)) applied.push(name);
  }

  // 交叉一致性：soft > hard 會讓降級與強制閾值以錯誤順序觸發。
  // 只在兩者**都**由環境給出時退回環境側；單邊設定的矛盾留給
  // loadConfig 的 invariantWarnings 依合併後的值報。
  const soft = overrides.budget?.softRatio;
  const hard = overrides.budget?.hardRatio;
  if (soft !== undefined && hard !== undefined && soft > hard) {
    delete overrides.budget?.softRatio;
    delete overrides.budget?.hardRatio;
    warnings.push(
      `COMPASS_BUDGET_SOFT_RATIO + COMPASS_BUDGET_HARD_RATIO: budget.softRatio must be <= budget.hardRatio — both overrides dropped`,
    );
  }

  return { overrides, warnings };
}