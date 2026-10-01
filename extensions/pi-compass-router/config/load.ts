// config/load.ts — 三層設定解析、warnings、env 驗證（SPEC Part 3.2）。
import type { CompassConfig } from "../schema.js";

/** 設定載入結果：解析後的設定與驗證警告。 */
export interface LoadResult {
  config: CompassConfig;
  warnings: string[];
}

/**
 * 讀取設定：內建預設 → `~/.pi/agent/pi-compass/config.json` →
 * `COMPASS_*` 環境變數，後者勝。無專案級設定檔（Part 3.2）。
 *
 * @param env 供測試注入的環境變數來源（預設 process.env）。
 */
export function loadConfig(
  _env?: Record<string, string | undefined>,
): LoadResult {
  throw new Error("not implemented: config/load");
}

/**
 * 寫入前驗證單一鍵值（Part 3.4）：白名單 + 型別/範圍檢查。
 * 回傳 `key: reason` 表示拒絕；通過則回傳 null。
 */
export function validatePatch(
  _key: string,
  _value: unknown,
): string | null {
  throw new Error("not implemented: config/load");
}
