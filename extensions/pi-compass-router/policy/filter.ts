// policy/filter.ts — L2 政策過濾：deny / allowProviders / prefer
//（SPEC Part 9 四層政策、Part 5 Stage 3）。
import type { CompassConfig, Target } from "../schema.js";

/**
 * 從「衍生」鏈套用 deny（glob 移除）與 allowProviders（非空時只留這些
 * provider）。L3 顯式鏈（routes/kindModels/prefer）永不過濾（Part 9）。
 * 使用者在 config 寫的模型不會被此處濾掉（Part 2 顯式勝過政策）。
 */
export function filterChain(
  _chain: Target[],
  _config: CompassConfig,
): Target[] {
  throw new Error("not implemented: policy/filter");
}

/** 把 `prefer[tier]` 插入鏈首；prefer 永不被過濾（Part 3.1、Part 9 L3）。 */
export function insertPrefer(
  _chain: Target[],
  _tier: string,
  _config: CompassConfig,
): Target[] {
  throw new Error("not implemented: policy/filter");
}
