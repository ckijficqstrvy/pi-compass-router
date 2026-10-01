// classify/types.ts — 分類後端介面與判斷結果（SPEC Part 4.1）。
import type { TaskKind, ThinkingLevel } from "../schema.js";

/** 判斷來源。顯示在 transcript entry（Part 10.4）與狀態列。 */
export type ClassifierSource = "laya" | "cloud" | "cache" | "fallback";

/** 送給分類器的輸入。payload 僅含 request 與 conversation（Part 4.4）。 */
export interface ClassifyInput {
  request: string;
  conversation?: string;
  /** 呼叫端允許的種類集合；分類器不能自訂種類（Part 4.1）。 */
  kinds: readonly TaskKind[];
  /** `modelPick: "menu"` 時傳入的候選 id；提供時才會追問第六題（Part 5 Stage 3）。 */
  menu?: readonly string[];
}

/**
 * 分類判斷。
 *
 * `kind` 與 `kindConfidence` 必需：沒有可用種類，整輪判斷不成立，
 * 解析端會 throw 讓上層 fail-open（Part 5 Stage 1）。
 *
 * 其餘五欄**皆可缺**，各有對應的承接層（Part 5）：
 * - `complexity` / `capability` 缺 → Stage 2 不做 demand 調整，沿用層級預設
 * - `thinking` 缺 → Stage 2 落到 demand 階梯
 * - `deepReasoning` 缺 → 不做 reasoning 微調
 * - `modelPick` 缺 → 由層級鏈與專家鏈承接
 */
export interface Judgment {
  kind: TaskKind;
  /** 0–1。低於 `classify.confidenceThreshold` 時 Stage 2 回落 standard（Part 5）。 */
  kindConfidence: number;
  /** 0–3（Part 5 Stage 2 的 demand 計算與階梯刻度）。 */
  complexity?: number;
  /** 0–3。**不含價格**——價格由 policy 層決定（Part 2、Part 9）。 */
  capability?: number;
  /** 0–1，needs_deep_reasoning 的 P(true)。 */
  deepReasoning?: number;
  thinking?: ThinkingLevel;
  /** `modelPick: "menu"` 時分類器選中的 menu id；僅偏好，非授權（Part 5 Stage 3）。 */
  modelPick?: string;
  /** 端到端耗時，含快取查詢（Part 6.1 的 p95 量測來源）。 */
  latencyMs: number;
  source: ClassifierSource;
  /** 命中分類快取時為 true（Part 6.2）。 */
  cacheHit?: boolean;
}

/** 分類後端介面（Part 4.1）。 */
export interface Classifier {
  readonly id: "laya" | "cloud";
  classify(input: ClassifyInput, signal: AbortSignal): Promise<Judgment>;
  /** 啟動預熱（Part 4.2：session 啟動即載入模型，首輪不付載入延遲）。 */
  warm?(): void;
  /** 拆除（session 結束、測試）。可隨時呼叫。 */
  dispose?(): void;
}