// ui/entries.ts — transcript entry 渲染（SPEC Part 5 Stage 5、Part 10.4）。
import type { Target, Tier, ThinkingLevel } from "../schema.js";

/** entry 符號（Part 5 Stage 5）：→ 切換、= 保持、• 通知、× 跳過、· 未路由。 */
export type EntrySymbol = "→" | "=" | "•" | "×" | "·";

/** 一條路由決策的 entry 資料（Part 10.4 首行與展開欄位）。 */
export interface RouteEntry {
  symbol: EntrySymbol;
  tier: Tier | null;
  target: Target | null;
  kind?: string;
  kindConfidence?: number;
  complexity?: number;
  capability?: number;
  deepReasoning?: number;
  demand?: number;
  budgetPressure?: number;
  thinking?: {
    resolved: ThinkingLevel;
    judged?: ThinkingLevel;
    applied?: ThinkingLevel;
  };
  picked?: string;
  classify?: {
    source: string;
    latencyMs: number;
    hit: boolean;
  };
  cacheMissUsd?: number;
  /** 未路由原因（acknowledgement / continuation / no route available）。 */
  reason?: string;
  /** 拒絕原因 notes（menu gate 等）。 */
  notes?: string[];
}

/**
 * 渲染 transcript entry 內容。entry 標 `excludeFromContext: true`，
 * 不進入 LLM context（Part 5 Stage 5）。
 * 同因同模型的重複 skip 由呼叫端合併（Part 10.4）。
 */
export function renderEntry(_entry: RouteEntry): string {
  throw new Error("not implemented: ui/entries");
}
