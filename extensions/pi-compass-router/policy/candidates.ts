// policy/candidates.ts — S2：由 pi registry 建立「可行集」候選鏈。
// 設計見 docs/canonical-model-routes.md。
//
// 與舊的價格帶（bands）不同：bands 先把模型切進互斥價格帶、每層只看自己那帶；
// 這裡改成**約束過濾 + 排序**——每個 tier 的候選 =「能力 ≥ 該層下限」且
// 「中位數健康 endpoint 價 ≤ 該層天花板」且政策允許的所有 route，再依
// 能力降、價格升排序。能力查 canonical（provider 無關），所以同一模型的多條
// provider route 會一起出現（天然形成跨 provider 備援）。
//
// 純函式：registry/endpoints/capability 全由呼叫端提供。
import { TIER_CAPABILITY_FLOOR, type CompassConfig, type Target, type Tier } from "../schema.js";
import { ceilingFor, filterChain } from "./filter.js";
import { bestEndpoint, blendedOf, isHealthy, type EndpointQuote, type Route } from "./routes.js";

/** 健康 endpoint 的 blended 中位數（預估成本用；不用最便宜的高估省錢能力）。 */
export function medianHealthyPrice(endpoints: readonly EndpointQuote[]): number | undefined {
  const prices = endpoints
    .filter(isHealthy)
    .filter((q) => Number.isFinite(q.input) && Number.isFinite(q.output))
    .map(blendedOf)
    .sort((a, b) => a - b);
  if (prices.length === 0) return undefined;
  const mid = Math.floor(prices.length / 2);
  return prices.length % 2 === 1 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
}

export interface RegistryChainInput {
  tier: Tier;
  config: CompassConfig;
  routes: readonly Route[];
  /** canonical → 主分數（`primaryCapability` 已套用；未評分則不存在）。 */
  capability: ReadonlyMap<string, number>;
  /** 覆寫定價（測試用）；預設取 route 的健康 endpoint 中位數。 */
  priceOf?: (route: Route) => number | undefined;
  /**
   * 候選鏈上限（預設 25）。registry 全體可達數百條（尤其 `allowUnratedPicks` 下
   * 大量未評分免費模型），不設限會讓每回合的可用性查詢與 menu 爆掉。
   */
  limit?: number;
}

/**
 * 回傳該層的可行集，已排序（能力降、同分價格升）。
 *
 * 過濾：政策（deny/allowProviders，經 `filterChain`）、能力下限（未評分則看
 * `allowUnratedPicks`）、價格天花板（中位數健康 endpoint）。無報價的 route 略過
 *（無法定價＝無法守預算）。
 */
export function registryChain(input: RegistryChainInput): Target[] {
  const { tier, config, routes, capability, priceOf } = input;
  const floor = TIER_CAPABILITY_FLOOR[tier];
  const ceiling = ceilingFor(config, tier);
  const priced = priceOf ?? ((route: Route) => medianHealthyPrice(route.endpoints));

  const scored: Array<{ target: Target; capability: number; cost: number }> = [];
  const seen = new Set<string>();
  for (const route of routes) {
    const target: Target = { provider: route.provider, model: route.model };
    // registry 可能有同一 provider/id 的重複條目（實測 `openrouter/auto` 出現兩次）。
    const key = `${route.provider}/${route.model}`;
    if (seen.has(key)) continue;
    if (filterChain([target], config).length === 0) continue;

    const cap = capability.get(route.canonical);
    if (cap === undefined) {
      if (!config.allowUnratedPicks) continue;
    } else if (cap < floor) {
      continue;
    }

    const cost = priced(route);
    if (cost === undefined) continue;
    if (ceiling !== null && ceiling !== undefined && cost > ceiling) continue;

    seen.add(key);
    scored.push({ target, capability: cap ?? -1, cost });
  }

  scored.sort((a, b) => b.capability - a.capability || a.cost - b.cost);
  const limit = input.limit ?? 25;
  return scored.slice(0, limit).map((entry) => entry.target);
}

/** 便利：從 routes 建 `provider/model → 最便宜健康 endpoint`（顯示/診斷用）。 */
export function cheapestHealthy(route: Route): EndpointQuote | undefined {
  return bestEndpoint(route.endpoints);
}
