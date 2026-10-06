// route/guard.ts — Stage 4：守衛（SPEC Part 5：stickiness / budget / cache /
// cooldown，順序固定；可用性由呼叫端在候選鏈上做，見 Part 5 Stage 4 實作契約）。
import { computePressure } from "../budget.js";
import { TIER_DEMAND_FLOOR } from "./compose.js";
import { TIERS } from "../schema.js";
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
  /** 預算是否強制改變了層級（由 `applyBudget` 決定）——deadband/cooldown 的豁免依據。 */
  budgetForced?: boolean;
  /**
   * 目前模型所屬 provider 已知餘額 < 0（credits.ts）。留在原地等於必然失敗，
   * 所以和 `budgetForced` 一樣豁免所有「先不切」的防抖動守衛（deadband /
   * cache 懲罰 / cooldown）。沒有這個，guard 會為了保住一個已經沒錢的
   * provider 上的 warm cache 而 hold（2026-10-06 實測）。
   */
  currentProviderDrained?: boolean;
}

/** Stage 4 輸出。 */
export interface GuardResult {
  outcome: GuardOutcome;
  tier: Tier;
  /** 降級／擋下的原因（budget pressure、cache miss 估算、cooldown 等）。 */
  reason?: string;
}

/** 層級由低到高；唯一來源是 schema 的 TIERS。 */
const TIER_ORDER: readonly Tier[] = TIERS;

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
 * 預算層級調整（Part 8）——**在選 target 之前**跑。
 *
 * 2026-10-03（審查 W2）：原本 budget 在 guard 裡只改 tier 標籤，target 早已
 * 按原層級選定，導致「降級」不會真的換到便宜模型。抽出來後 `planTurn` 用
 * 回傳的 tier 重跑 Stage 3，成本政策才真的生效。
 *
 * `demand >= 2.5` 的架構性回合在 hard ratio 下可留 standard（Part 8）。
 */
export function applyBudget(
  tier: Tier,
  demand: number,
  budgets: { todayUsd: number; monthUsd: number },
  config: CompassConfig,
): { tier: Tier; reasons: string[]; forced: boolean } {
  const pressure = computePressure(budgets, config);
  if (pressure >= config.budget.hardRatio) {
    const forced: Tier = demand >= 2.5 ? "standard" : "quick";
    const next = clampTier(Math.min(rank(tier), rank(forced)));
    if (next !== tier) {
      return { tier: next, reasons: [`budget hard ratio ${(pressure * 100).toFixed(0)}% of cap → ${next}`], forced: true };
    }
    return { tier, reasons: [], forced: false };
  }
  if (pressure >= config.budget.softRatio) {
    const next = clampTier(rank(tier) - 1);
    if (next !== tier) {
      return {
        tier: next,
        reasons: [`budget soft ratio ${(pressure * 100).toFixed(0)}% of cap → one tier down (${next})`],
        forced: true,
      };
    }
  }
  return { tier, reasons: [], forced: false };
}

/**
 * Stage 4 後半（Part 5），順序不可調換：
 *   stickiness → cache → cooldown → mode
 *
 * 預算已在呼叫端（`planTurn` → `applyBudget`）先套用並**重選 target**；
 * `budgetForced` 讓 deadband/cooldown 對預算強制變更讓路（Part 7/8）。
 */
export function guard(
  request: GuardRequest,
  state: GuardState,
  config: CompassConfig,
  mode: Mode,
): GuardResult {
  const { target, tier: requestedTier, demand } = request;
  const budgetForced = state.budgetForced === true;
  // 必須離開當前 provider（預算強制降級，或當前 provider 已無餘額）。
  const mustMove = budgetForced || state.currentProviderDrained === true;
  let tier = requestedTier;

  // 1. stickiness — 當前已是目標 → held（層級沿用當前，Part 5）。
  // 比較要用完整 `provider/model`（與呼叫端 currentModel 同編碼）——
  // 只比 target.model 會在 provider 非空時**永遠不命中**（2026-10-03 實跑發現）。
  const targetId = target.provider ? `${target.provider}/${target.model}` : target.model;
  if (config.stickiness && state.currentModel !== null && state.currentModel === targetId) {
    return {
      outcome: "held",
      tier: state.currentTier ?? requestedTier,
      reason: "stickiness — already on the chosen model",
    };
  }

  const currentRank = state.currentTier === null ? null : rank(state.currentTier);
  const tierDelta = currentRank === null ? 0 : Math.abs(rank(tier) - currentRank);
  const bypass = tierDelta >= config.cache.bypassTierDelta;

  // confirm 模式：deadband / cache / cooldown 這三個「先不切、留待以後」的守衛**一律讓路**。
  // 理由：confirm 模式下每一次切換都已經要使用者同意，防抖動是多餘的；留著只會讓
  // 「guard 想 hold」的回合**靜默 keep、不再詢問**，使用者就失去了決定權（2026-10-05
  // 實測：當前 deepseek、目標 xiaomi v2.6、同層但仍在 cooldown 內 → 直接 held、不問）。
  // stickiness 不在此列：目標=當前，沒有東西可問，仍 hold。
  const holdGuardsArmed = mode !== "confirm";

  // 3. cache（Part 7）：deadband 與懲罰上限。
  if (holdGuardsArmed && config.cache.aware && state.currentTier !== null && tier !== state.currentTier) {
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
    if (withinBand && !bypass && !mustMove) {
      return {
        outcome: "held",
        tier: state.currentTier,
        reason: `deadband ${config.cache.deadband} — demand ${demand.toFixed(2)} has not cleared the ${state.currentTier}→${tier} boundary`,
      };
    }
  }

  if (
    holdGuardsArmed &&
    config.cache.aware &&
    state.cachePenaltyUsd !== undefined &&
    state.cachePenaltyUsd > config.cache.maxPenaltyUsd &&
    !bypass &&
    // N1（2026-10-03 複審）：預算強制變更同樣豁免 cache 懲罰——「錢的約束優先」
    // 與 deadband/cooldown 的豁免一致，否則 1 階 soft 降級在長 context 下會被擋回貴層。
    // 2026-10-06：當前 provider 已無餘額（mustMove）也豁免——沒錢的 warm cache 沒價值。
    !mustMove &&
    // 2026-10-03 校準：cache penalty 只抑制「同層互換與降級」。
    // 明確的升級是路由器的目的，且固定 USD 上限會隨 context 變大而失效
    // （60k tokens 就會擋掉 $1/M 升級）——不讓一次性 cache 成本擋升級。
    // 目前層級未知 → 不套（fail-open，與首次不套 deadband 一致）。
    state.currentTier !== null &&
    rank(tier) <= rank(state.currentTier)
  ) {
    return {
      outcome: "held",
      tier: state.currentTier ?? tier,
      reason: `cache miss ≈ ${formatUsd(state.cachePenaltyUsd)} exceeds the ${formatUsd(config.cache.maxPenaltyUsd)} cap — keeping the warm cache`,
    };
  }

  // 4. cooldown（Part 7）：大跳與 hardRatio 降級豁免。
  const cooldownSeconds = config.cache.cooldownSeconds;
  if (holdGuardsArmed && cooldownSeconds > 0 && state.lastSwitchAtMs !== null && !mustMove && !bypass) {
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
    return { outcome: "notify-only", tier, reason: "notify mode — suggestion only, nothing applied" };
  }

  return { outcome: "applied", tier };
}