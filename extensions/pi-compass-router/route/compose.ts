// route/compose.ts — Stage 2：demand / tier / thinking 組合（SPEC Part 5）。
import type { CompassConfig, Tier, ThinkingLevel } from "../schema.js";
import { TIER_THINKING } from "../schema.js";
import type { Judgment } from "../classify/types.js";

/** demand → thinking 的階梯（Part 5 Stage 2，實作常數）。 */
export const DEMAND_LADDER: ReadonlyArray<{
  below: number;
  thinking: ThinkingLevel;
}> = [
  { below: 0.5, thinking: "off" },
  { below: 1.5, thinking: "low" },
  { below: 2.5, thinking: "medium" },
  { below: 2.9, thinking: "high" },
  { below: Infinity, thinking: "xhigh" },
];

/** 層級的數值需求下限（Part 5 Stage 2，2026-10-01 補定）。 */export const TIER_DEMAND_FLOOR: Readonly<Record<Tier, number>> = {
  quick: 0.5,
  standard: 1.5,
  high: 2.5,
  premium: 2.9,
  xpremium: 3.0,
};

/** 層級由低到高；用於取 max 與比較。 */
const TIER_ORDER: readonly Tier[] = ["quick", "standard", "high", "premium", "xpremium"];

/** Part 5 Stage 2 的三個權重；修改須回填 SPEC。 */
const WEIGHT_COMPLEXITY = 0.55;
const WEIGHT_CAPABILITY = 0.45;
const WEIGHT_DEEP_REASONING = 0.15;
const DEMAND_MAX = 3;

/** Stage 2 輸出（Part 5）。 */
export interface ComposeResult {
  demand: number;
  tier: Tier;
  thinking: ThinkingLevel;
}

function tierRank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

function maxTier(a: Tier, b: Tier): Tier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

/**
 * demand → tier：取**floor ≤ demand 的最高層級**。
 *
 * 不是「第一個 demand < below 的 rung」——那會整體偏移一格：
 * `TIER_DEMAND_FLOOR.high = 2.5` 的語意是「demand 至少 2.5 才算 high」，
 * 而 `demand < 2.5` 的寫法會讓剛好 2.5 的 plan 任務跳到 premium。
 * 兩張表必須同源（都以 floor 為準），否則種類下限形同虛設。
 */
function tierFromDemand(demand: number, xpremiumEnabled: boolean): Tier {
  let result: Tier = "quick";
  for (const tier of TIER_ORDER) {
    if (tier === "xpremium" && !xpremiumEnabled) continue;
    if (demand >= TIER_DEMAND_FLOOR[tier]) result = tier;
  }
  return result;
}

function thinkingFromLadder(demand: number): ThinkingLevel {
  for (const rung of DEMAND_LADDER) {
    if (demand < rung.below) return rung.thinking;
  }
  return "xhigh";
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * Stage 2（Part 5）。
 *
 * 缺欄位的承接（Part 4.1）：
 * - `complexity` 或 `capability` 任一缺失 → 不做 demand 加權，demand 只由
 *   floor 決定（不做猜測）
 * - `deepReasoning` 缺失 → 微調項不加
 * - `thinking` 缺失 → 落到 demand 階梯
 *
 * 信心守衛優先於 `kindMinimumTier`（Part 5 Stage 2，2026-10-01 補）：
 * 信心不足時即使種類下限要求 high 也落回 standard。
 */
export function compose(judgment: Judgment | undefined, config: CompassConfig): ComposeResult {
  // 分類失敗（Part 5 Stage 1 fail-open）：不用任何種類 floor，因 kind 未知。
  if (!judgment) {
    return { demand: 0, tier: "standard", thinking: TIER_THINKING.standard };
  }

  const hasScore = judgment.complexity !== undefined && judgment.capability !== undefined;
  let demand = 0;
  if (hasScore) {
    demand =
      WEIGHT_COMPLEXITY * (judgment.complexity as number) +
      WEIGHT_CAPABILITY * (judgment.capability as number) +
      (judgment.deepReasoning === undefined ? 0 : WEIGHT_DEEP_REASONING * judgment.deepReasoning);
  }
  demand = clamp(demand, 0, DEMAND_MAX);

  // 種類的 demand floor（Part 3.1a）。
  const spec = config.taskKinds[judgment.kind];
  if (spec) demand = Math.max(demand, spec.floor);

  // 種類的層級 floor 轉成數值下限（Part 5 Stage 2）。
  const kindTier = config.kindMinimumTier[judgment.kind];
  if (kindTier) demand = Math.max(demand, TIER_DEMAND_FLOOR[kindTier]);

  let tier = tierFromDemand(demand, config.xpremium.enabled);
  if (kindTier) {
    // `xpremium` 未啟用時，種類的層級下限也封頂在 premium。
    const floor: Tier = kindTier === "xpremium" && !config.xpremium.enabled ? "premium" : kindTier;
    tier = maxTier(tier, floor);
  }

  // 信心守衛：優先於層級 floor（Part 5 Stage 2）。
  if (judgment.kindConfidence < config.classify.confidenceThreshold && tierRank(tier) > tierRank("standard")) {
    tier = "standard";
  }

  return { demand, tier, thinking: resolveThinking(judgment, config, demand) };
}

/**
 * thinking 解析（Part 5 Stage 2，四層 first-hit-wins）：
 * config pin（全域或按種類）> 分類判斷 > demand 階梯 > 層級預設。
 *
 * 第四層 `TIER_THINKING` 在此路徑不可達（階梯是全域函數，任何 demand
 * 都有對應 rung）；它實際生效於 `compose()` 開頭的分類失敗分支。
 * 兩者共用 schema 的同一張表，避免兩處定義漂移。
 */
function resolveThinking(judgment: Judgment, config: CompassConfig, demand: number): ThinkingLevel {
  const pin = config.thinking[judgment.kind] ?? config.thinking.pin;
  if (pin) return pin;
  if (judgment.thinking) return judgment.thinking;
  return thinkingFromLadder(demand);
}