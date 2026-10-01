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

/** 環境變數覆寫層的解析結果（Part 3.3：非法值丟棄該變數並警告）。 */
export interface EnvOverrides {
  overrides: Partial<CompassConfig>;
  warnings: string[];
}

/**
 * 解析 COMPASS_* 環境變數。
 *
 * 規格缺口：SPEC Part 3.3 給了對應表與驗證規則，但未定義回傳的
 * warnings 具體字串格式；實作時按 `key: reason` 風格輸出（Part 3.4）。
 */
export function parseEnvOverrides(
  _env: Record<string, string | undefined>,
): EnvOverrides {
  throw new Error("not implemented: config/env");
}
