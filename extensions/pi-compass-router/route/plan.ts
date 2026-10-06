// route/plan.ts — Stage 2–4 的**純編排**（無 I/O）：把一次回合的判斷資料
// 變成決策（目標、層級、thinking、guard 結果、cache 成本估算）。
//
// 為什麼要這一層：`index.ts` 的 `routeTurn` 負責接 pi（分類器、registry、
// spend、apply），把編排混在裡面時**沒有任何測試跑得到完整路徑**——實際
// 就發生過 `currentTier`/`lastSwitchAtMs`/`cachePenaltyUsd` 從未供給、
// Stage 4 的 cache/cooldown 全程空轉而沒被發現（2026-10-03）。
// 這裡改為：編排純函式（可注入 isAvailable / costOf），routeTurn 只做 I/O。
import type { Judgment } from "../classify/types.js";
import { TIERS, type CompassConfig, type Target, type Tier } from "../schema.js";
import { computePressure } from "../budget.js";
import { compose, type ComposeResult } from "./compose.js";
import { ceilingFor } from "../policy/filter.js";
import { applyBudget, guard, type GuardResult } from "./guard.js";
import { selectTargets } from "./select.js";

/** 模型費率（USD / 每百萬 token；與 pi 的 `Model.cost` 同單位）。 */
export interface CostRates {
  input: number;
  /** 輸出費率（registry `Model.cost.output`）；未知時視為 0（blended 只用 input）。 */
  output?: number;
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
  /**
   * 目前模型所屬 provider 已知餘額 < 0（credits.ts）。呼叫端由 CreditBook 算好；
   * 未提供視為 false。用來豁免 guard 的防抖動 hold（見 guard.ts）。
   */
  currentProviderDrained?: boolean;
  todayUsd: number;
  monthUsd: number;
}

/** 注入的查詢（I/O 由呼叫端做，使本層可測）。 */
export interface PlanDeps {
  /** 模型是否存在且已認證。 */
  isAvailable(target: Target): boolean;
  /** 目標模型的費率；未知回 null。 */
  costOf(target: Target): CostRates | null;
  /** S2：`selection: "registry"` 時，由呼叫端注入該層可行集（未提供則退回 bands）。 */
  registryChain?: (tier: Tier, judgment: Judgment | undefined) => Target[] | undefined;
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
 * C1（2026-10-05）估算用：一次 assistant 回覆的輸出 token 保守假設。
 * 我們沒有可靠的每回合輸出長度來源（決策日誌刻意不存內容），故取一個略高的
 * 常數——偶爾多降一層，也好過在 cap 前一輪用旗艦模型跨過上限。
 */
export const OUTPUT_TOKEN_ESTIMATE = 2000;

/**
 * 估算「這一輪」的模型成本（USD）：context 當輸入、{@link OUTPUT_TOKEN_ESTIMATE}
 * 當輸出。任一前提未知 → `undefined`（不猜）。
 */
export function estimateTurnUsd(contextTokens: number | null, rates: CostRates | null): number | undefined {
  if (contextTokens === null || contextTokens <= 0 || !Number.isFinite(contextTokens) || rates === null) return undefined;
  const total = (contextTokens / 1_000_000) * rates.input + (OUTPUT_TOKEN_ESTIMATE / 1_000_000) * (rates.output ?? 0);
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return total;
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

  // W2（2026-10-03）：預算先決定**有效層級**，再依它重選候選。原本先選 target
  // 再由 guard 降 tier，結果只是把標籤改便宜、模型照切貴的。
  const budget = applyBudget(
    composed.tier,
    composed.demand,
    { todayUsd: snapshot.todayUsd, monthUsd: snapshot.monthUsd },
    config,
  );
  let effectiveTier = budget.tier;
  let budgetForced = budget.forced;
  const reasons = [...budget.reasons];

  // W8（2026-10-03）：以 **registry 即時價格**重驗價格天花板——靜態 facts 可能
  // 過期；未知價格不擋（fail-open）。
  // N3（複審）：預算降級後要用**有效層級**的天花板，否則會放過超 quick 價的候選。
  const pickFor = (tier: Tier): { target?: Target; notes: string[] } => {
    const selected = selectTargets(tier, judgment, config, {
      registryChain: deps.registryChain?.(tier, judgment),
    });
    const ceiling = ceilingFor(config, tier);
    const priceOk = (candidate: Target): boolean => {
      // Part 9 L3：顯式條目（使用者自己寫的）永不被政策過濾——價格天花板也一樣。
      if (candidate.explicit) return true;
      if (ceiling === null) return true;
      const cost = deps.costOf(candidate);
      if (!cost) return true;
      const blended = cost.input + 2 * (cost.output ?? 0);
      return blended <= ceiling;
    };
    const target =
      selected.picked && deps.isAvailable(selected.picked) && priceOk(selected.picked)
        ? selected.picked
        : selected.chain.find((candidate) => deps.isAvailable(candidate) && priceOk(candidate));
    return { target, notes: selected.notes };
  };

  let picked = pickFor(effectiveTier);

  // C1（2026-10-05）：**事前**成本投影。applyBudget 只看已花的錢，可能在 cap
  // 前最後一輪用昂貴模型跨過上限。這裡用「context 當輸入 + 保守輸出估數」估這
  // 一輪成本；若會觸及 hard ratio，就再降一層並重選（只在重選有目標時採用）。
  if (picked.target && !budget.forced) {
    const projected = estimateTurnUsd(snapshot.contextTokens, deps.costOf(picked.target));
    const projectedPressure =
      projected === undefined
        ? 0
        : computePressure(
            { todayUsd: snapshot.todayUsd + projected, monthUsd: snapshot.monthUsd + projected },
            config,
          );
    if (projected !== undefined && projectedPressure >= config.budget.hardRatio) {
      const lowerIndex = Math.max(0, TIERS.indexOf(effectiveTier) - 1);
      const lower = TIERS[lowerIndex];
      if (lower !== effectiveTier) {
        const retry = pickFor(lower);
        if (retry.target) {
          reasons.push(`projected next turn $${projected.toFixed(3)} reaches budget hard ratio → ${lower}`);
          effectiveTier = lower;
          budgetForced = true;
          picked = retry;
        }
      }
    }
  }

  if (!picked.target) {
    return { composed, notes: picked.notes, unavailable: true };
  }
  const target = picked.target;

  // prompt-cache miss 估算（Part 7）：只在真的換模型時算。
  const targetKey = target.provider ? `${target.provider}/${target.model}` : target.model;
  let cacheMissUsd: number | undefined;
  if (config.cache.aware && snapshot.currentModel !== null && targetKey !== snapshot.currentModel) {
    cacheMissUsd = estimateCacheMissUsd(snapshot.contextTokens, snapshot.currentCost, deps.costOf(target));
  }

  const result = guard(
    { target, tier: effectiveTier, demand: composed.demand },
    {
      currentModel: snapshot.currentModel,
      currentTier: snapshot.currentTier,
      todayUsd: snapshot.todayUsd,
      monthUsd: snapshot.monthUsd,
      lastSwitchAtMs: snapshot.lastSwitchAtMs,
      cachePenaltyUsd: cacheMissUsd,
      budgetForced,
      currentProviderDrained: snapshot.currentProviderDrained,
    },
    config,
    config.mode,
  );

  // 當前 provider 沒錢 → 離開它是硬需求，寫進理由讓 entry 說得清楚。
  if (snapshot.currentProviderDrained) reasons.push("current provider balance < 0 → moving off it");

  // 預算理由與 guard 理由合併（entry 顯示完整因果）。
  const reason = [...reasons, result.reason].filter(Boolean).join(" · ") || undefined;
  return { composed, target, guard: { ...result, reason }, notes: picked.notes, cacheMissUsd };
}
