// budget.ts — 預算記帳與壓力（SPEC Part 8）。
import type { CompassConfig } from "./schema.js";

/** 記帳來源的花費快照（state.json）。 */
export interface SpendSnapshot {
  todayUsd: number;
  monthUsd: number;
}

/**
 * pressure = max(today÷dailyUsd, month÷monthlyUsd)；
 * 該維度為 0 或 null → 移除上限、不計入（Part 8）。
 */
export function computePressure(
  _spend: SpendSnapshot,
  _config: CompassConfig,
): number {
  throw new Error("not implemented: budget");
}

/**
 * 記入一筆 assistant message 的計算成本到 state.json。
 * laya 分類不記帳（Part 4.2、Part 8）。
 */
export function recordSpend(_amountUsd: number, _at?: Date): void {
  throw new Error("not implemented: budget");
}
