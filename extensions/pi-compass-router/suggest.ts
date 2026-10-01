// suggest.ts — /compass suggest：從本地分數檔提議路由，不切換
//（SPEC Part 10.1、移植 #12）。
import type { CompassConfig, Target, Tier } from "./schema.js";

/** 一條路由提議。 */
export interface Suggestion {
  tier: Tier;
  target: Target;
  /** 提議理由（來自分數檔的分數說明）。 */
  reason: string;
}

/**
 * 讀取 `suggest.scoresFile`（本地分數檔）並產生各層路由提議。
 * 僅提議、不切換（Part 10.1）。
 *
 * 規格缺口：分數檔格式與 Suggestion 欄位未在 SPEC 定義，
 * 此介面為骨架初版，實作前需補規格。
 */
export async function suggest(
  _config: CompassConfig,
): Promise<Suggestion[]> {
  throw new Error("not implemented: suggest");
}
