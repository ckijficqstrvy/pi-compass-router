// suggest.ts — /compass suggest：從本地分數檔**或決策日誌**提議路由，不切換
//（SPEC Part 10.1「分數檔格式」節、移植 #12；決策日誌自動校準 2026-10-03）。
import { readFileSync } from "node:fs";
import { readDecisions, type DecisionRecord } from "./decisions.js";
import { MODEL_FACTS, factsValid, factFor } from "./policy/facts.js";
import { TIERS, TIER_CAPABILITY_FLOOR, type CompassConfig, type Target, type Tier } from "./schema.js";
import { selectTargets } from "./route/select.js";

/** 一條路由提議。 */
export interface Suggestion {
  tier: Tier;
  target: Target;
  /** 提議理由（來自分數檔的分數說明，或決策歷史的統計）。 */
  reason: string;
}

/** 層級順序的唯一來源是 schema。 */

function isTier(value: string): value is Tier {
  return (TIERS as readonly string[]).includes(value);
}

/** 有效分數條目（規格：score 必需 0–1；tier/note 可選）。 */
interface ScoreEntry {
  score?: unknown;
  tier?: unknown;
  note?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 決策歷史 → 分數（0–1）。
 *
 * 訊號（全部非內容欄位）：
 * - `type: "route"` 且 outcome 為 `applied`／`held` → 該模型 `chosen +1`；
 * - `type: "feedback"` → `from` 記負（離開它 = 不滿意）、`to` 記正（換過去 = 偏好）。
 *
 * `score = 0.5 + 0.5 × (pos − neg) / (pos + neg + 1)`——落在 (0,1)，
 * 無正負證據的模型回 0.5（中性）。**只給有事件的模型**。
 */
export function scoresFromHistory(records: readonly DecisionRecord[]): Record<string, { score: number; note: string }> {
  const pos = new Map<string, number>();
  const neg = new Map<string, number>();
  const chosen = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string | null | undefined) => {
    if (typeof key !== "string" || key === "") return;
    map.set(key, (map.get(key) ?? 0) + 1);
  };
  for (const record of records) {
    if (record.type === "route") {
      if (record.outcome === "applied" || record.outcome === "held") bump(chosen, record.model);
    } else {
      bump(neg, record.from);
      bump(pos, record.to);
    }
  }

  const keys = new Set([...pos.keys(), ...neg.keys(), ...chosen.keys()]);
  const out: Record<string, { score: number; note: string }> = {};
  for (const key of keys) {
    const p = pos.get(key) ?? 0;
    const n = neg.get(key) ?? 0;
    const c = chosen.get(key) ?? 0;
    out[key] = {
      score: 0.5 + (0.5 * (p - n)) / (p + n + 1),
      note: `history +${p}/-${n} · chosen ${c}`,
    };
  }
  return out;
}

/**
 * 分數表 → 提議（分數檔與決策歷史共用的評估器）。
 *
 * - `score` 非有限數或不在 0–1 → 跳過。
 * - `tier` 缺省 → 依 `model-facts` 歸帶；無事實（unrated）→ 跳過；
 *   `tier` 非法 → 跳過。
 * - `target` 標 `explicit: false`（提議不是設定，不繞過 L2 過濾）。
 * - 依 `score` 降序，同分依 model 字典序（穩定）。**純提議**。
 */
export function evaluateScores(
  scoresRaw: Record<string, ScoreEntry>,
  config: CompassConfig,
): Suggestion[] {
  const out: Array<Suggestion & { score: number }> = [];
  for (const [key, value] of Object.entries(scoresRaw)) {
    if (!isRecord(value)) continue;
    const score = value.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      continue;
    }
    const note = typeof value.note === "string" ? value.note : undefined;

    let tier: Tier;
    if (value.tier === undefined) {
      const derived = deriveTier(key, config);
      if (derived === undefined) continue; // unrated → 跳過
      tier = derived;
    } else if (typeof value.tier === "string" && isTier(value.tier)) {
      tier = value.tier;
    } else {
      continue; // unknown tier → 跳過
    }

    const target = targetFromKey(key);
    out.push({
      tier,
      target,
      reason: note ? `score ${score.toFixed(2)} · ${note}` : `score ${score.toFixed(2)}`,
      score,
    });
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      `${a.target.provider}/${a.target.model}`.localeCompare(`${b.target.provider}/${b.target.model}`),
  );
  return out.map(({ score: _score, ...suggestion }) => suggestion);
}

/**
 * 讀取提議。來源二選一：
 * 1. `config.suggest.scoresFile` 有值 → 讀該 JSON 檔（格式見 SPEC Part 10.1）；
 *    檔不存在／非 JSON／缺 `scores` → **throw**（使用者主動下指令，靜默回空會誤導）。
 * 2. 空字串 → **自動校準**：讀決策日誌（`decisions.jsonl`，只含非內容欄位）
 *    換算分數。完全沒有事件 → 回 `[]`（不是錯誤）。
 *
 * @param scoresFile 覆寫 `config.suggest.scoresFile`（**僅供測試**）。
 * @param options.decisionsFile 覆寫決策日誌路徑（**僅供測試**）。
 */
export async function suggest(
  config: CompassConfig,
  scoresFile?: string,
  options: { decisionsFile?: string } = {},
): Promise<Suggestion[]> {
  const path = scoresFile ?? config.suggest.scoresFile;
  if (path === "") {
    const records = readDecisions(options.decisionsFile);
    const scores = scoresFromHistory(records);
    return evaluateScores(scores, config);
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`suggest: cannot read scores file ${path}: ${e instanceof Error ? e.message : e}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`suggest: scores file ${path} is not valid JSON`);
  }
  if (!isRecord(parsed) || !isRecord(parsed.scores)) {
    throw new Error(`suggest: scores file ${path} must be an object with a "scores" map`);
  }
  return evaluateScores(parsed.scores as Record<string, ScoreEntry>, config);
}

/** key → Tier：用事實檔的 capability 與 profile 價格帶歸帶（經 Stage 3 選鏈）。 */
function deriveTier(key: string, config: CompassConfig): Tier | undefined {
  const slash = key.indexOf("/");
  const provider = slash > 0 ? key.slice(0, slash) : "";
  const model = slash > 0 ? key.slice(slash + 1) : key;
  if (!factsValid(MODEL_FACTS)) return undefined;
  const fact = factFor(provider, model);
  if (!fact) return undefined;

  // 找到「能力下限 ≤ 它」的最高可行層（用 Stage 3 同一條鏈驗證在帶內）。
  for (let i = TIERS.length - 1; i >= 0; i -= 1) {
    const tier = TIERS[i];
    if (fact.capability < TIER_CAPABILITY_FLOOR[tier]) continue;
    const { chain } = selectTargets(tier, undefined, config);
    if (chain.some((t) => t.model === model || `${t.provider}/${t.model}` === key)) return tier;
  }
  // 能力夠但帶不符（例如價格超 ceiling）→ 落到最低可行層。
  return TIERS.find((tier) => fact.capability >= TIER_CAPABILITY_FLOOR[tier]);
}

/** key → Target（同 `select.targetKey` 的反向編碼）。 */
function targetFromKey(key: string): Target {
  const slash = key.indexOf("/");
  if (slash <= 0) return { provider: "", model: key };
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}
