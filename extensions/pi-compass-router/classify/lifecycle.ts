// classify/lifecycle.ts — reload 時的分類器生命週期決策（SPEC Part 4.2、Part 11）。
//
// **問題**：`reloadConfig()` 原本**無條件 dispose + 重建**分類器，而
// `/compass-set` 每改一項就 reload 一次（`compass_config` 工具也是）——
// 改個每日上限就把已載好模型的 laya 子行程殺掉，下一句分類要現場重載模型
// （laya.ts 每次 spawn 都重新載 `classify.model`）。
//
// **決策**：分類器讀得到的設定沒變 → **保留既有分類器**（含暖好的子行程）；
// 變了（或根本沒有分類器）→ dispose → 重建 → **立刻 `warm()`**（重建後沒有
// 子行程，不預熱的話第一次分類要現載，那輪慢幾秒）。
//
// 分類器建構時讀的東西（逐行核對 laya.ts / cloud.ts）：
//   laya  : classify.python / classify.model / classify.cache /
//           classify.cacheTtlSeconds / classify.timeoutMs
//   cloud : classify.cloud.* / classify.cache / classify.cacheTtlSeconds /
//           classify.timeoutMs
//   兩者  : taskKinds + modelPick（快取世代 `configGeneration`）
//
// 所以要比**整個 `classify` 區塊** + `taskKinds` + `modelPick`：分類器是
// 閉包抓住建立時的 config 物件，比漏一個鍵（如 `timeoutMs`）就會拿舊值跑
// 新設定。比對只會**多重建**（順序不穩）不會漏重建，方向安全。
import type { CompassConfig } from "../schema.js";

/** 分類器建構時會讀到的設定（序列化成字串比對）。 */
export function classifierInputs(config: CompassConfig): string {
  return JSON.stringify({
    classify: config.classify,
    taskKinds: config.taskKinds,
    modelPick: config.modelPick,
  });
}

/** 分類器輸入是否變了；`prev` 未提供（第一次載入）= 要重建。 */
export function classifierInputsChanged(
  prev: CompassConfig | undefined,
  next: CompassConfig,
): boolean {
  return prev === undefined || classifierInputs(prev) !== classifierInputs(next);
}

/**
 * reload 的分類器決策。回 `true` 表示重建了。
 *
 * - `state.config` **一律**換成 `next`（路由設定永遠即時生效）；
 * - 分類器只有在輸入變動或缺失時才 dispose → 重建 → 預熱；
 * - 保留時**不碰暖好的子行程**，也不重複預熱。
 */
export function reloadClassifier<C extends { warm?(): void; dispose?(): void }>(
  state: { config: CompassConfig; classifier?: C },
  next: CompassConfig,
  create: (config: CompassConfig) => C | undefined,
): boolean {
  const reusable = state.classifier !== undefined && !classifierInputsChanged(state.config, next);
  state.config = next;
  if (reusable) return false;

  state.classifier?.dispose?.();
  state.classifier = create(next);
  state.classifier?.warm?.();
  return true;
}
