// classify/cloud.ts — cloud 分類後端（SPEC Part 4.3：opt-in、
// provider 可替換、endpoint 寫死、計費入帳本）。
import type { CompassConfig } from "../schema.js";
import type { Classifier } from "./types.js";

/**
 * 建立 cloud 分類器（`classify.provider: "cloud"` 時使用）。
 * provider 由 `classify.cloud.provider` 決定（移植 #1，Part 4.3）；
 * 金鑰順序：環境變數 → `~/.pi/agent/pi-typesafe/auth.json`（需 0600）。
 */
export function createCloudClassifier(_config: CompassConfig): Classifier {
  throw new Error("not implemented: classify/cloud");
}
