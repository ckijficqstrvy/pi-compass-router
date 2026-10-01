// suggest.ts — /compass suggest：從本地分數檔提議路由，不切換
//（SPEC Part 10.1「分數檔格式」節、移植 #12）。
import { readFileSync } from "node:fs";
import { MODEL_FACTS, factsValid, factFor } from "./policy/facts.js";
import { TIER_CAPABILITY_FLOOR, type CompassConfig, type Target, type Tier } from "./schema.js";
import { selectTargets } from "./route/select.js";

/** 一條路由提議。 */
export interface Suggestion {
  tier: Tier;
  target: Target;
  /** 提議理由（來自分數檔的分數說明）。 */
  reason: string;
}

const TIERS: readonly Tier[] = ["quick", "standard", "high", "premium", "xpremium"];

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
 * 讀取 `suggest.scoresFile`（本地分數檔）並產生各層路由提議。
 *
 * 行為契約（SPEC Part 10.1「分數檔格式」節，2026-10-01 補定）：
 *
 * - `scoresFile === ""` → 回 `[]`（不讀檔，**不是錯誤**）。
 * - 檔不存在／非 JSON／缺 `scores` → **throw**（使用者主動下指令，
 *   靜默回空會誤導成「沒有建議」；由 `index.ts` 捕獲顯示）。
 * - `score` 非有限數或不在 0–1 → 跳過該筆記 `invalid score`（單筆髒資料
 *   不讓整份建議消失）。
 * - `tier` 缺省 → 依 `model-facts` 歸帶；無事實（unrated）→ 跳過記
 *   `unrated model`；`tier` 非法 → 跳過記 `unknown tier`。
 * - `target` 標 `explicit: false`（提議不是設定，不繞過 L2 過濾）。
 * - 回傳依 `score` 降序，同分依 model 字典序（穩定）。
 * - **純提議**：不寫 config、不切換。
 *
 * @param scoresFile 參數存在時覆寫 `config.suggest.scoresFile`（**僅供測試**）。
 */
export async function suggest(
  config: CompassConfig,
  scoresFile?: string,
): Promise<Suggestion[]> {
  const path = scoresFile ?? config.suggest.scoresFile;
  if (path === "") return [];

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

  const out: Array<Suggestion & { score: number }> = [];
  for (const [key, value] of Object.entries(parsed.scores as Record<string, ScoreEntry>)) {
    if (!isRecord(value)) continue;
    const score = value.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      continue; // invalid score → 跳過（規格第 3 點）
    }
    const note = typeof value.note === "string" ? value.note : undefined;

    let tier: Tier;
    if (value.tier === undefined) {
      const derived = deriveTier(key, config);
      if (derived === undefined) continue; // unrated → 跳過（第 4 點）
      tier = derived;
    } else if (typeof value.tier === "string" && isTier(value.tier)) {
      tier = value.tier;
    } else {
      continue; // unknown tier → 跳過（第 5 點）
    }

    const target = targetFromKey(key);
    out.push({
      tier,
      target,
      reason: note ? `score ${score.toFixed(2)} · ${note}` : `score ${score.toFixed(2)}`,
      score,
    });
  }

  // 依 score 降序（最推薦在前），同分依 model 字典序穩定排序（第 7 點）。
  out.sort(
    (a, b) =>
      b.score - a.score ||
      `${a.target.provider}/${a.target.model}`.localeCompare(`${b.target.provider}/${b.target.model}`),
  );
  return out.map(({ score: _score, ...suggestion }) => suggestion);
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