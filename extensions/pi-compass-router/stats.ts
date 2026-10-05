// stats.ts — 決策日誌的聚合統計（SPEC Part 10.1，/compass log 用）。
//
// 為什麼要這支：decisions.jsonl 一直在累積（applied/held/skipped/cancelled、
// 回饋、tier、模型、kind、cache 估算），但先前**只有 suggest 消費它**，人看不到。
// 這支把「這個路由器到底做了什麼」變成一次可讀的摘要，純函式、可測。
//
// 只看**非內容欄位**，與 decisions.ts 的隱私邊界一致。
import { decisionWithinDays, type DecisionRecord } from "./decisions.js";

/** 一個計數項（值 + 次數）。 */
export interface Count {
  key: string;
  count: number;
}

/** 決策日誌的聚合結果（全部落在視窗內）。 */
export interface DecisionStats {
  /** route 紀錄總數（視窗內）。 */
  total: number;
  applied: number;
  held: number;
  skipped: number;
  cancelled: number;
  applyFailed: number;
  /** 無法歸類的 outcome。 */
  other: number;
  revert: number;
  manualOverride: number;
  /** kind → 次數（route 紀錄）。 */
  kinds: Count[];
  /** tier → 次數；tier 缺失/null 歸為 `(unknown)`。 */
  tiers: Count[];
  /** 實際指到的模型 → 次數（route 紀錄）。 */
  models: Count[];
  /** 有 cache 估算的筆數與平均值（USD）。 */
  cacheMissCount: number;
  cacheMissAvgUsd: number | null;
}

/** 依次數由多到少排序（同分依 key 字典序穩定）。 */
function rank(map: Map<string, number>, limit: number): Count[] {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function bump(map: Map<string, number>, key: string | null | undefined): void {
  if (typeof key !== "string" || key === "") return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

/** 每個排行榜最多回幾項（控制 /compass log 的長度）。 */
const RANK_LIMIT = 5;

/**
 * 把決策日誌聚合成摘要。`now` 與 `windowDays` 可注入以便測試；
 * 預設只看最近 90 天（與 suggest 的視窗一致）。
 */
export function summarizeDecisions(
  records: readonly DecisionRecord[],
  now: number = Date.now(),
  windowDays = 90,
): DecisionStats {
  const stats: DecisionStats = {
    total: 0,
    applied: 0,
    held: 0,
    skipped: 0,
    cancelled: 0,
    applyFailed: 0,
    other: 0,
    revert: 0,
    manualOverride: 0,
    kinds: [],
    tiers: [],
    models: [],
    cacheMissCount: 0,
    cacheMissAvgUsd: null,
  };

  const kinds = new Map<string, number>();
  const tiers = new Map<string, number>();
  const models = new Map<string, number>();
  let cacheMissSum = 0;

  for (const record of records) {
    if (!decisionWithinDays(record, now, windowDays)) continue;
    if (record.type === "feedback") {
      if (record.feedback === "revert") stats.revert += 1;
      else if (record.feedback === "manual-override") stats.manualOverride += 1;
      continue;
    }

    stats.total += 1;
    switch (record.outcome) {
      case "applied":
        stats.applied += 1;
        break;
      case "held":
        stats.held += 1;
        break;
      case "skipped":
        stats.skipped += 1;
        break;
      case "cancelled":
        stats.cancelled += 1;
        break;
      case "apply failed":
        stats.applyFailed += 1;
        break;
      default:
        stats.other += 1;
    }

    bump(kinds, record.kind);
    bump(tiers, typeof record.tier === "string" && record.tier !== "" ? record.tier : "(unknown)");
    bump(models, record.model);
    if (typeof record.cacheMissUsd === "number" && Number.isFinite(record.cacheMissUsd) && record.cacheMissUsd > 0) {
      stats.cacheMissCount += 1;
      cacheMissSum += record.cacheMissUsd;
    }
  }

  stats.kinds = rank(kinds, RANK_LIMIT);
  stats.tiers = rank(tiers, RANK_LIMIT);
  stats.models = rank(models, RANK_LIMIT);
  stats.cacheMissAvgUsd = stats.cacheMissCount > 0 ? cacheMissSum / stats.cacheMissCount : null;
  return stats;
}

/** 一行「key n · key n · …」；空則回 undefined。 */
export function formatCounts(counts: readonly Count[]): string | undefined {
  if (counts.length === 0) return undefined;
  return counts.map((entry) => `${entry.key} ${entry.count}`).join(" · ");
}
