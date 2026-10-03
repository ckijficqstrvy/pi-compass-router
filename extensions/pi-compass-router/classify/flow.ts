// classify/flow.ts — 分類的階段編排（W5，2026-10-03）。
//
// 問題：`modelPick: "menu"` 的第六題候選是用 `compose(undefined).tier`（固定
// standard、無 kind 專家）組的——與最終 judgment 的 tier 不一致，high 任務
// 永遠看不到 high 候選，選到的模型還可能被 Stage 3 的閘門拒絕。
//
// 解法（兩階段，只在 menu 模式多花一次分類）：
//   1. 先問五題 → 得到真正的 kind/demand/tier
//   2. 用該 judgment 組 menu；候選 > 1 才追問第六題
//   3. 第二階段失敗 → 回第一階段結果（fail-open，不因 menu 失敗丟掉路由）
import type { CompassConfig } from "../schema.js";
import { compose } from "../route/compose.js";
import { menuKeys } from "../route/select.js";
import type { Classifier, ClassifyInput, Judgment } from "./types.js";

/** 單次分類；失敗回 undefined（fail-open，與 routeTurn 既有語意一致）。 */
async function tryClassify(
  classifier: Classifier,
  input: ClassifyInput,
  signal: AbortSignal,
): Promise<Judgment | undefined> {
  try {
    return await classifier.classify(input, signal);
  } catch {
    return undefined;
  }
}

/**
 * 兩階段分類（見檔頭）。非 menu 模式或候選不足 → 只跑一次。
 * `base` 提供 request/kinds/conversation；menu 由本函式決定。
 */
export async function classifyInStages(
  classifier: Classifier,
  base: Omit<ClassifyInput, "menu">,
  config: CompassConfig,
  signal: AbortSignal,
): Promise<Judgment | undefined> {
  const first = await tryClassify(classifier, base, signal);
  if (!first || config.modelPick !== "menu") return first;

  const menu = menuKeys(compose(first, config).tier, first, config);
  if (!menu) return first;

  const second = await tryClassify(classifier, { ...base, menu }, signal);
  return second ?? first;
}
