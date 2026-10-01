// classify/laya.ts — 本機分類 bridge（SPEC Part 4.2：JSONL over stdio、
// 無網路監聽、預熱、崩潰重啟、fail-open、不計費）。
import type { CompassConfig } from "../schema.js";
import type { Classifier } from "./types.js";

/**
 * 建立 laya 本機分類器。子行程以 `classify.python` 啟動，
 * 失敗連續 3 次才標記不可用，期間 fail-open（Part 4.2）。
 */
export function createLayaClassifier(_config: CompassConfig): Classifier {
  throw new Error("not implemented: classify/laya");
}
