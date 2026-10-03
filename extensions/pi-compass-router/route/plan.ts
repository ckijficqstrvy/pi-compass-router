// route/plan.ts — Stage 2–4 的**純編排**（無 I/O）：把一次回合的判斷資料
// 變成決策（目標、層級、thinking、guard 結果、cache 成本估算）。
//
// 為什麼要這一層：`index.ts` 的 `routeTurn` 負責接 pi（分類器、registry、
// spend、apply），把編排混在裡面時**沒有任何測試跑得到完整路徑**——實際
// 就發生過 `currentTier`/`lastSwitchAtMs`/`cachePenaltyUsd` 從未供給、
// Stage 4 的 cache/cooldown 全程空轉而沒被發現（2026-10-03）。
// 這裡改為：編排純函式（可注入 isAvailable / costOf），routeTurn 只做 I/O。
import type { Judgment } from "../classify/types.js";
import type { CompassConfig, Target, Tier } from "../schema.js";
import { compose, type ComposeResult } from "./compose.js";
import { guard, type GuardResult } from "./guard.js";
import { selectTargets } from "./select.js";

/** 模型費率（USD / 每百萬 token；與 pi 的 `Model.cost` 同單位）。 */
export interface CostRates {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/** 回合當下的環境快照（全部由呼叫端取得；本層不碰 I/O）。 */
export interface PlanSnapshot {
  /** 目前模型（`provider/model`），未知為 null。 */
  currentModel: string | null;
  /** 目前模型所屬層級（由 `tierOfModel` 推導）；未知為 null = 首次切換、不套 deadband。 */
  currentTier: Tier | null;
  /** 本 session 上次真的切換模型的時間；null = 還沒切過（不套 cooldown）。 */
  lastSwitchAtMs: number | null;
  /** 目前 context 的 token 估數（`ctx.getContextUsage().tokens`）；未知為 null。 */
  contextTokens: number | null;
  /** 目前模型的費率；未知為 null（價格未知 → 跳過 cache 估算，Part 7）。 */
  currentCost: CostRates | null;
  todayUsd: number;
  monthUsd: number;
}

/** 注入的查詢（I/O 由呼叫端做，使本層可測）。 */
export interface PlanDeps {
  /** 模型是否存在且已認證。 */
  isAvailable(target: Target): boolean;
  /** 目標模型的費率；未知回 null。 */
  costOf(target: Target): CostRates | null;
}

/** Stage 2–4 的計畫結果。 */
export interface PlanResult {
  composed: ComposeResult;
  /** 選定且可用的目標；`unavailable` 為真時沒有。 */
  target?: Target;
  /** guard 決策（有 target 時才有）。 */
  guard?: GuardResult;
  /** menu gate 的拒絕原因（entry notes）。 */
  notes: string[];
  /** 估算的 prompt-cache miss 成本（USD）；未知 = undefined（絕不假造）。 */
  cacheMissUsd?: number;
  /** 鏈上沒有可用模型（呼叫端寫 `no route available` entry）。 */
  unavailable?: boolean;
}

/**
 * Part 7 的估算：`contextTokens × (next.input + next.cacheWrite − current.cacheRead)`。
 *
 * 任一前提未知（context 未知、費率未知、非正成本）→ `undefined`——
 * 寧可不算，也不要用猜的數字去擋切換。
 */
export function estimateCacheMissUsd(
  contextTokens: number | null,
  current: CostRates | null,
  next: CostRates | null,
): number | undefined {
  if (contextTokens === null || contextTokens <= 0 || current === null || next === null) return undefined;
  if (!Number.isFinite(contextTokens)) return undefined;
  const perMillion = next.input + next.cacheWrite - current.cacheRead;
  if (!Number.isFinite(perMillion) || perMillion <= 0) return undefined;
  return (contextTokens / 1_000_000) * perMillion;
}

/**
 * Stage 2→4：compose → select → 可用性回退 → cache 估算 → guard。
 *
 * 可用性回退（Part 5 Stage 4 契約）：先試 `picked`，再依序試鏈上候選，
 * 取第一個 `isAvailable` 為真者。
 */
export function planTurn(
  judgment: Judgment | undefined,
  config: CompassConfig,
  snapshot: PlanSnapshot,
  deps: PlanDeps,
): PlanResult {
  const composed = compose(judgment, config);
  const selected = selectTargets(composed.tier, judgment, config);

  let target: Target | undefined;
  if (selected.picked && deps.isAvailable(selected.picked)) target = selected.picked;
  else target = selected.chain.find((candidate) => deps.isAvailable(candidate));

  if (!target) {
    return { composed, notes: selected.notes, unavailable: true };
  }

  // prompt-cache miss 估算（Part 7）：只在真的換模型時算。
  const targetKey = target.provider ? `${target.provider}/${target.model}` : target.model;
  let cacheMissUsd: number | undefined;
  if (config.cache.aware && snapshot.currentModel !== null && targetKey !== snapshot.currentModel) {
    cacheMissUsd = estimateCacheMissUsd(snapshot.contextTokens, snapshot.currentCost, deps.costOf(target));
  }

  const result = guard(
    { target, tier: composed.tier, demand: composed.demand },
    {
      currentModel: snapshot.currentModel,
      currentTier: snapshot.currentTier,
      todayUsd: snapshot.todayUsd,
      monthUsd: snapshot.monthUsd,
      lastSwitchAtMs: snapshot.lastSwitchAtMs,
      cachePenaltyUsd: cacheMissUsd,
    },
    config,
    config.mode,
  );

  return { composed, target, guard: result, notes: selected.notes, cacheMissUsd };
}
