// route/compose.ts — Stage 2：demand / tier / thinking 組合（SPEC Part 5）。
import type { CompassConfig, Tier, ThinkingLevel } from "../schema.js";
import type { Judgment } from "../classify/types.js";

/**
 * demand → thinking 的階梯（Part 5 Stage 2，實作常數）。
 * 修改任一閾值必須回填 SPEC Part 5 並註記日期。
 */
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

/** Stage 2 輸出（Part 5）。 */
export interface ComposeResult {
  demand: number;
  tier: Tier;
  thinking: ThinkingLevel;
}

/**
 * Stage 2：
 *   demand = 0.55·complexity + 0.45·capability（+ reasoning 微調），
 *   與 taskKinds[kind].floor、kindMinimumTier 取 max，再由 ceilings 切 tier；
 *   thinking = pin > judgment.thinking > demand ladder > tier 預設；
 *   信心守衛：kindConfidence < confidenceThreshold 且 > standard → standard。
 *
 * @param judgment 分類結果；超時缺失時以 tier 預設組合（Part 5 Stage 1）。
 */
export function compose(
  _judgment: Judgment | undefined,
  _config: CompassConfig,
): ComposeResult {
  throw new Error("not implemented: route/compose");
}
