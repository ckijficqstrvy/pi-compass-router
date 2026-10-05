// policy/preferences.ts — S4：從**行為**學來的、會衰減的偏好。
// 設計見 docs/canonical-model-routes.md（偏好是學習，不是 config）。
//
// 為什麼要這支：使用者不想為了「這週愛用某個模型」去改 `prefer`/`deny`，也不想
// 新模型用完就回頭刪設定。可用的訊號早就在 `decisions.jsonl`：
//   · `feedback` `manual-override`：compass 選了 from，使用者手動換成 to
//     → from 扣分、to 加分（**依 kind 分開記**）
//   · `feedback` `revert`：明確撤銷 → from 扣分
//   · `usage` `ok`：路線選了就用了且該回合成功 → 小幅加分
// 跟著 provider 錯誤來的切換不算偏好（那是 health 的事），故 `usage.ok=false` 不計。
//
// 分數**會衰減**（半衰期預設 14 天）：新模型你用就自己升上來；不愛了、不用它，
// 分數自然淡掉，不必手動維護清單。偏好只當**可行集內的排序加分**，有上限，
// 不得推翻硬約束（能力下限/價格天花板/政策）。
import type { DecisionRecord } from "../decisions.js";

/** 偏好分數（key = `provider/model`，再分 kind；`""` = 不分 kind 的通用分）。 */
export interface PreferenceEntry {
  score: number;
  updatedAt: number;
}
export type PreferenceTable = Record<string, Record<string, PreferenceEntry>>;

/** 半衰期：14 天後分數減半。 */
export const PREF_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;
/** 原始分數夾在 ±3，避免單一事件主導。 */
const MAX_SCORE = 3;

/** 指數衰減：`score × 0.5^(dt / halfLife)`。 */
export function decayedScore(entry: PreferenceEntry, now: number, halfLifeMs = PREF_HALF_LIFE_MS): number {
  if (halfLifeMs <= 0) return entry.score;
  const periods = Math.max(0, now - entry.updatedAt) / halfLifeMs;
  return entry.score * Math.pow(0.5, periods);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

/** 決策日誌的 `ts` 是 ISO 字串（fail-open：無法解析回 undefined → 用 `now`）。 */
function parseTs(record: unknown, fallback: number): number {
  const raw = (record as { ts?: unknown } | null | undefined)?.ts;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * 從決策日誌建立偏好表。同 (key, kind) 的多筆事件以**時間序累加**後再夾範圍；
 * `updatedAt` 取最後一筆的 `ts`（缺/壞則用 `now`）。
 */
export function learnPreferences(records: readonly DecisionRecord[], now = Date.now()): PreferenceTable {
  const table: PreferenceTable = {};
  const bump = (key: string | null | undefined, kind: string | undefined, delta: number, ts: number): void => {
    if (!key) return;
    const byKind = (table[key] ??= {});
    const entry = (byKind[kind ?? ""] ??= { score: 0, updatedAt: ts });
    entry.score = clamp(entry.score + delta, -MAX_SCORE, MAX_SCORE);
    entry.updatedAt = ts;
  };

  for (const record of records) {
    const ts = parseTs(record, now);
    if (record.type === "feedback") {
      if (record.feedback === "manual-override") {
        bump(record.from, record.kind, -1, ts);
        bump(record.to, record.kind, +1, ts);
      } else if (record.feedback === "revert") {
        bump(record.from, record.kind, -1, ts);
      }
    } else if (record.type === "usage" && record.ok && record.model) {
      bump(record.model, record.kind, +0.1, ts);
    }
  }
  return table;
}

/**
 * 查某 route 的偏好加分（capability 尺度；可供排序）。kind 專屬分優先，其次通用分。
 * 回傳已夾在 `[-maxBonus, +maxBonus]`（預設 ±5，相對 capability 20–58 是「有感的
 * tie-breaker，但不足以蓋過一整個層級」）。
 */
export function preferenceBonus(
  table: PreferenceTable,
  provider: string,
  model: string,
  kind: string | undefined,
  now = Date.now(),
  maxBonus = 5,
): number {
  const byKind = table[`${provider}/${model}`];
  if (!byKind) return 0;
  const entry = byKind[kind ?? ""] ?? byKind[""];
  if (!entry) return 0;
  const raw = decayedScore(entry, now); // ∈ [-3, 3]
  return clamp((raw / MAX_SCORE) * maxBonus, -maxBonus, maxBonus);
}
