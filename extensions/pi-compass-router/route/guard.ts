// route/guard.ts — Stage 4：守衛（SPEC Part 5：stickiness / budget / cache /
// cooldown，順序固定；可用性由呼叫端在候選鏈上做，見 Part 5 Stage 4 實作契約）。
import { computePressure } from "../budget.js";
import { TIER_DEMAND_FLOOR } from "./compose.js";
import type { CompassConfig, Mode, Target, Tier } from "../schema.js";

/** Stage 4 決策結果（Part 5 頭部介面）。 */
export type GuardOutcome = "applied" | "held" | "notify-only" | "skipped";

/** Stage 4 的請求：目標模型、Stage 2 給的層級、以及 demand。 */
export interface GuardRequest {
  target: Target;
  tier: Tier;
  /** hardRatio 的「`>= 2.5` 可留 standard」例外必需（Part 8）。 */
  demand: number;
}

/** 守衛需要的 session 狀態（state.json 與當前模型）。 */
export interface GuardState {
  currentModel: string | null;
  currentTier: Tier | null;
  todayUsd: number;
  monthUsd: number;
  lastSwitchAtMs: number | null;
  /**
   * 估算的 prompt-cache miss 成本（USD），由**有價格與 context 的呼叫端**
   * 算好傳入——`guard` 取不到 token 數與費率（Part 5 Stage 4 實作契約）。
   * 未提供 → 跳過 cache 這一步（與「價格未知不擋切換」一致，Part 7）。
   */
  cachePenaltyUsd?: number;
}

/** Stage 4 輸出。 */
export interface GuardResult {
  outcome: GuardOutcome;
  tier: Tier;
  /** 降級／擋下的原因（budget pressure、cache miss 估算、cooldown 等）。 */
  reason?: string;
}

const TIER_ORDER: readonly Tier[] = ["quick", "standard", "high", "premium", "xpremium"];

function rank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

function clampTier(index: number): Tier {
  return TIER_ORDER[Math.max(0, Math.min(index, TIER_ORDER.length - 1))];
}

function formatUsd(value: number): string {
  return `$${value.toFixed(3)}`;
}

/**
 * Stage 4（Part 5），順序不可調換：
 *   stickiness → budget → cache → cooldown → mode
 *
 * `budget` 先於 `cache`：花費硬約束應該比快取成本更有優先權；
 * `cooldown` 最後，因為它豁免前一步的 hardRatio 降級（Part 7）。
 */
export function guard(
  request: GuardRequest,
  state: GuardState,
  config: CompassConfig,
  mode: Mode,
): GuardResult {
  const { target, tier: requestedTier, demand } = request;

  // 1. stickiness — 當前已是目標 → held（層級沿用當前，Part 5）。
  if (state.currentModel !== null && state.currentModel === target.model) {
    return {
      outcome: "held",
      tier: state.currentTier ?? requestedTier,
      reason: "stickiness — already on the chosen model",
    };
  }

  // 2. budget（Part 8）。
  let tier = requestedTier;
  const reasons: string[] = [];
  let budgetForcedDowngrade = false;
  const pressure = computePressure({ todayUsd: state.todayUsd, monthUsd: state.monthUsd }, config);

  if (pressure >= config.budget.hardRatio) {
    // demand >= 2.5（明顯架構性）可留 standard，否則強制 quick。
    const forced: Tier = demand >= 2.5 ? "standard" : "quick";
    const next = clampTier(Math.min(rank(tier), rank(forced)));
    budgetForcedDowngrade = next !== tier;
    if (budgetForcedDowngrade) {
      tier = next;
      reasons.push(`budget hard ratio ${(pressure * 100).toFixed(0)}% of cap → ${tier}`);
    }
  } else if (pressure >= config.budget.softRatio) {
    const next = clampTier(rank(tier) - 1);
    if (next !== tier) {
      tier = next;
      budgetForcedDowngrade = true;
      reasons.push(`budget soft ratio ${(pressure * 100).toFixed(0)}% of cap → one tier down (${tier})`);
    }
  }

  const currentRank = state.currentTier === null ? null : rank(state.currentTier);
  const tierDelta = currentRank === null ? 0 : Math.abs(rank(tier) - currentRank);
  const bypass = tierDelta >= config.cache.bypassTierDelta;

  // 3. cache（Part 7）：deadband 與懲罰上限。
  if (config.cache.aware && state.currentTier !== null && tier !== state.currentTier) {
    const movingUp = rank(tier) > rank(state.currentTier);
    // 上切：需求得超出「目標層的下限」一個 deadband（目標層下限 = 當前層的上界）。
    // 下切：需求得跌破「**當前層**的下限」一個 deadband。
    const required = movingUp
      ? TIER_DEMAND_FLOOR[tier] + config.cache.deadband
      : TIER_DEMAND_FLOOR[state.currentTier] - config.cache.deadband;
    const withinBand = movingUp ? demand < required : demand > required;
    // 預算強制變更同時豁免 deadband：錢的約束優先於「需求不確定性」，
    // 與它已有的 cooldown 豁免一致（Part 7）。否則 soft/hard 降級會先被
    // 死區擋住，預算政策形同虛設。
    if (withinBand && !bypass && !budgetForcedDowngrade) {
      return {
        outcome: "held",
        tier: state.currentTier,
        reason: `deadband ${config.cache.deadband} — demand ${demand.toFixed(2)} has not cleared the ${state.currentTier}→${tier} boundary`,
      };
    }
  }

  if (
    config.cache.aware &&
    state.cachePenaltyUsd !== undefined &&
    state.cachePenaltyUsd > config.cache.maxPenaltyUsd &&
    !bypass
  ) {
    return {
      outcome: "held",
      tier: state.currentTier ?? tier,
      reason: `cache miss ≈ ${formatUsd(state.cachePenaltyUsd)} exceeds the ${formatUsd(config.cache.maxPenaltyUsd)} cap — keeping the warm cache`,
    };
  }

  // 4. cooldown（Part 7）：大跳與 hardRatio 降級豁免。
  const cooldownSeconds = config.cache.cooldownSeconds;
  if (cooldownSeconds > 0 && state.lastSwitchAtMs !== null && !budgetForcedDowngrade && !bypass) {
    const elapsedMs = Date.now() - state.lastSwitchAtMs;
    if (elapsedMs < cooldownSeconds * 1000) {
      return {
        outcome: "held",
        tier: state.currentTier ?? tier,
        reason: `cooldown — ${Math.ceil((cooldownSeconds * 1000 - elapsedMs) / 1000)}s left before the next switch`,
      };
    }
  }

  // 5. mode（Part 5 表）。
  if (mode === "notify") {
    return {
      outcome: "notify-only",
      tier,
      reason: reasons.length > 0 ? reasons.join(" · ") : "notify mode — suggestion only, nothing applied",
    };
  }

  return { outcome: "applied", tier, reason: reasons.length > 0 ? reasons.join(" · ") : undefined };
}