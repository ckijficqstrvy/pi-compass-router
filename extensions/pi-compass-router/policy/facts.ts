// policy/facts.ts — 模型事實查詢與價格帶切片（SPEC Part 9；
// model-facts.json schema 與函式面）。
import type { Tier } from "../schema.js";

/** model-facts.json 的單筆模型事實（Part 9 schema）。 */
export interface ModelFact {
  provider: string;
  model: string;
  capability: number;
  price: { input: number; output: number };
  estimated?: boolean;
  note?: string;
}

/** model-facts.json 檔案結構（Part 9 schema）。 */
export interface ModelFactsFile {
  generatedAt: string;
  source: string;
  models: ModelFact[];
}

/** 事實檔是否有效（日期新鮮、結構完整）；過期 → fail-open 而非誤路由。 */
export function factsValid(_facts: ModelFactsFile, _now?: Date): boolean {
  throw new Error("not implemented: policy/facts");
}

/** 查詢單筆事實；無此模型回 undefined。 */
export function factFor(
  _provider: string,
  _model: string,
): ModelFact | undefined {
  throw new Error("not implemented: policy/facts");
}

/** 全部事實依 capability 降序排序。 */
export function rankedFacts(): ModelFact[] {
  throw new Error("not implemented: policy/facts");
}

/** 天花板指標：input + 2×output（USD/M）（Part 9）。 */
export function blendedOf(_price: { input: number; output: number }): number {
  throw new Error("not implemented: policy/facts");
}

/** 依 ceilings 把排序後的事實切成每層價格帶（帶互斥，高者優先）。 */
export function sliceBands(
  _ranked: ModelFact[],
  _ceilings: Partial<Record<Tier, number | null>>,
): Record<Tier, ModelFact[]> {
  throw new Error("not implemented: policy/facts");
}
