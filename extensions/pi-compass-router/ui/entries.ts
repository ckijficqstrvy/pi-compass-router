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
 * 段落分隔（Part 10.4 範例的 `·`）。資料缺欄位時整段省略，不留下孤立分隔。 */
function join(parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");
}

function round(value: number, places: number): string {
  return value.toFixed(places);
}

/**
 * 渲染 transcript entry 內容（Part 10.4 首行 + 展開行）。
 *
 * 首行：`compass <symbol> <tier>  <provider/model>`；未路由時 `tier`/`target`
 * 為 `null`，顯示 `reason`（`acknowledgement`／`continuation`／
 * `no route available`）。展開行：kind 與信心 → 各分數 → thinking → budget /
 * classify。**缺欄位的段落整段省略**（不為陳列而堆砌）。
 *
 * entry 標 `excludeFromContext: true`（由寫入端附加，不進 LLM context）。
 * 同因同模型的重複 skip 由呼叫端合併（Part 10.4）。
 */
export function renderEntry(entry: RouteEntry): string {
  // 首行。
  const head: string[] = ["compass", entry.symbol];
  if (entry.tier !== null) head.push(entry.tier);
  if (entry.target !== null) {
    head.push(entry.target.provider ? `${entry.target.provider}/${entry.target.model}` : entry.target.model);
  }
  const lines: string[] = [head.join(" ")];

  // 展開第 1 行：kind 與信心 → 分數 → reasoning。
  const detail: (string | undefined)[] = [];
  if (entry.kind !== undefined) {
    detail.push(entry.kindConfidence !== undefined ? `${entry.kind} ${(entry.kindConfidence * 100).toFixed(0)}%` : entry.kind);
  }
  if (entry.complexity !== undefined) detail.push(`complexity ${round(entry.complexity, 2)}/3`);
  if (entry.capability !== undefined) detail.push(`capability ${round(entry.capability, 2)}/3`);
  if (entry.deepReasoning !== undefined) detail.push(`reasoning ${round(entry.deepReasoning, 2)}`);
  if (entry.demand !== undefined) detail.push(`demand ${round(entry.demand, 2)}`);

  // thinking：resolved → judged → applied（applied = read back after clamp）。
  if (entry.thinking !== undefined) {
    let t = `→ ${entry.thinking.resolved}`;
    if (entry.thinking.applied !== undefined && entry.thinking.applied !== entry.thinking.resolved) {
      t += ` (applied ${entry.thinking.applied})`;
    }
    detail.push(t);
  }
  if (entry.picked !== undefined) detail.push(`picked ${entry.picked}`);

  // 展開第 2 行：budget / classify / cache / reason。
  const tail: (string | undefined)[] = [];
  if (entry.budgetPressure !== undefined) {
    tail.push(`budget ${Math.round(entry.budgetPressure * 100)}% of cap`);
  }
  if (entry.cacheMissUsd !== undefined) tail.push(`cache miss ≈ $${entry.cacheMissUsd.toFixed(3)}`);
  if (entry.classify !== undefined) {
    const hit = entry.classify.hit ? "hit" : "miss";
    tail.push(`classify ${entry.classify.source} ${entry.classify.latencyMs}ms (${hit})`);
  }
  if (entry.reason !== undefined) tail.push(entry.reason);
  if (entry.notes !== undefined && entry.notes.length > 0) tail.push(entry.notes.join(" / "));

  const line2 = join(detail);
  if (line2) lines.push(line2);
  const line3 = join(tail);
  if (line3) lines.push(line3);

  return lines.join("\n");
}
