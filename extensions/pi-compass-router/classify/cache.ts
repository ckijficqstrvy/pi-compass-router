// classify/cache.ts — 分類結果快取（SPEC Part 6.2：記憶體內 LRU、TTL、
// config 金鑰失效）。
import type { CompassConfig } from "../schema.js";
import type { Judgment } from "./types.js";

/**
 * 快取鍵：hash(normalize(request) + sort(config 生成金鑰))。
 * normalize = 空白折疊、大小寫不變、截斷 512 字元；
 * config 金鑰涵蓋 taskKinds 與 modelPick，改動即失效（Part 6.2）。
 */
export function cacheKey(
  _request: string,
  _config: CompassConfig,
): string {
  throw new Error("not implemented: classify/cache");
}

/** 查快取；過期或不存在回 undefined（TTL = classify.cacheTtlSeconds）。 */
export function cacheGet(_key: string): Judgment | undefined {
  throw new Error("not implemented: classify/cache");
}

/** 寫快取；上限 256 條，LRU 淘汰，僅記憶體不落磁碟（Part 6.2）。 */
export function cacheSet(_key: string, _judgment: Judgment): void {
  throw new Error("not implemented: classify/cache");
}

/** 清空快取（例如設定變更或 session 結束）。 */
export function cacheClear(): void {
  throw new Error("not implemented: classify/cache");
}
