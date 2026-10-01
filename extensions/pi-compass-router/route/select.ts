// route/select.ts — Stage 3：候選鏈組裝（SPEC Part 5：專家 → 層級 → 池）。
import type { CompassConfig, Target, Tier } from "../schema.js";
import type { Judgment } from "../classify/types.js";

/**
 * Stage 3，依序產出候選鏈：
 * 1. specialistPriority 排序的 kindModels[kind]（過濾 minTier > tier）
 * 2. routes[tier]
 * 3. freePool.models（freePool.enabled 且當前層無可用模型）
 * 4. freeOnly 情境的全域免費池
 *
 * `modelPick: "menu"` 時分類器選項先於上述所有，但須通過
 * registry/deny/allowProviders/已評分/capability 下限/價格帶六道閘，
 * 任一失敗記 notes 並退回鏈（Part 5 Stage 3）。
 */
export function selectTargets(
  _tier: Tier,
  _judgment: Judgment | undefined,
  _config: CompassConfig,
): Target[] {
  throw new Error("not implemented: route/select");
}
