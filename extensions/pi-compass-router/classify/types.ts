// classify/types.ts — 分類後端介面與判斷結果（SPEC Part 4.1）。
import type { TaskKind, ThinkingLevel } from "../schema.js";

/** 送給分類器的輸入。payload 僅含 request 與 conversation（Part 4.4）。 */
export interface ClassifyInput {
  request: string;
  conversation?: string;
  /** 呼叫端允許的種類集合；分類器不能自訂種類（Part 4.1）。 */
  kinds: TaskKind[];
}

/**
 * 分類判斷。
 *
 * 規格缺口：`modelPick` 的具體型別（字串 id 或結構）與 `source` 的
 * 取值集合未在 SPEC 定義，骨架先以寬鬆型別表示。
 */
export interface Judgment {
  kind: TaskKind;
  kindConfidence: number;
  complexity: number;
  capability: number;
  deepReasoning: number;
  thinking: ThinkingLevel;
  modelPick?: string;
  latencyMs: number;
  source: string;
}

/** 分類後端介面（Part 4.1）。 */
export interface Classifier {
  readonly id: "laya" | "cloud";
  classify(input: ClassifyInput, signal: AbortSignal): Promise<Judgment>;
  /** 啟動預熱（Part 4.2：session 啟動即載入模型）。 */
  warm?(): void;
  dispose?(): void;
}
