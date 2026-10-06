// routes.ts — canonical 模型身分 + provider route/endpoint 報價。
// 設計見 docs/canonical-model-routes.md（S1）。
//
// 原則：**能力是「模型」的屬性（canonical，provider 無關）；價格/可用性是
// 「route/endpoint」的屬性。** 現行 model-facts 把兩者綁在同一筆，導致同一模型
// 在 openrouter 與直連被當成兩個能力、且只覆蓋 openrouter；價格也被壓成單一數字，
// 而實測 openrouter 一個模型可有 30 個上游、價差數十倍。
//
// 本模組只把身分與報價拆開，**不改路由行為**（S2 才接上 selectTargets）。純函式、
// 不讀檔，方便單測；I/O 由呼叫端（refresh / loader）負責。
import type { ModelCapability, ModelFact } from "./facts.js";

export type ProviderKind = "aggregator" | "direct";

/** OpenRouter endpoint status：0 = 正常；非 0 = 降級/不可用（原樣保留）。 */
export interface EndpointQuote {
  upstream: string;
  input: number;
  output: number;
  contextWindow?: number;
  status?: number;
}

export interface Route {
  canonical: string;
  provider: string;
  kind: ProviderKind;
  /** pi registry 的 slug（餵給 setModel 的那個 id）。 */
  model: string;
  endpoints: EndpointQuote[];
}

export interface RegistryModel {
  provider: string;
  id: string;
  cost?: { input: number; output: number };
  contextWindow?: number;
}

export interface CapabilityEntry {
  canonical: string;
  capability: ModelCapability;
  estimated: boolean;
}

/** 每個天花板都用的指標：`input + 2×output`（agent 流量寫得多）。 */
export function blendedOf(price: { input: number; output: number }): number {
  return price.input + 2 * price.output;
}

/** endpoint 未給 status 視為健康；0 為健康。 */
export function isHealthy(q: EndpointQuote): boolean {
  return q.status === undefined || q.status === 0;
}

/** 最便宜且健康的 endpoint（以 blended 價計）。沒有健康項回 undefined。 */
export function bestEndpoint(endpoints: readonly EndpointQuote[]): EndpointQuote | undefined {
  let best: EndpointQuote | undefined;
  for (const q of endpoints) {
    if (!isHealthy(q)) continue;
    if (!Number.isFinite(q.input) || !Number.isFinite(q.output)) continue;
    if (best === undefined || blendedOf(q) < blendedOf(best)) best = q;
  }
  return best;
}

/**
 * canonical 身分解析。openrouter 的 slug 本身已是 `maker/model`，可直接當 canonical；
 * 直連 provider 的 id 常是裸名（`deepseek-flash`），故需在 facts 條目明確給
 * `canonical`（例如 `deepseek/deepseek-v4.1-flash`）才能與 openrouter 對上。
 */
export function canonicalOf(provider: string, model: string, override?: string): string {
  const explicit = override?.trim();
  if (explicit) return explicit;
  if (provider === "openrouter") return model;
  return `${provider}/${model}`;
}

/**
 * 由 facts 建 `provider/model → canonical` 對應，供 `buildRoutes` 的
 * `canonicalByKey` 使用。只收**明確寫了 `canonical`** 的條目：直連 provider 的
 * 裸 id（`deepseek-flash`）靠它才對得上聚合商的 `maker/model` 身分，
 * 否則能力查不到、被當成未評分。
 */
export function canonicalKeyMap(facts: readonly ModelFact[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const fact of facts) {
    const canonical = fact.canonical?.trim();
    if (canonical) out.set(`${fact.provider}/${fact.model}`, canonical);
  }
  return out;
}

/**
 * 把 facts 收斂成 `canonical → capability`。同一 canonical 在不同條目分數不一致時，
 * 全部列入 `conflicts`（資料完整性訊號；不自動裁決誰對）。
 */
export function capabilityByCanonical(facts: readonly ModelFact[]): {
  byCanonical: Map<string, CapabilityEntry>;
  conflicts: string[];
} {
  const byCanonical = new Map<string, CapabilityEntry>();
  const conflicts: string[] = [];
  const sameCapability = (a: ModelCapability, b: ModelCapability): boolean =>
    a.intelligence === b.intelligence && a.coding === b.coding && a.agentic === b.agentic;
  for (const fact of facts) {
    const canonical = canonicalOf(fact.provider, fact.model, fact.canonical);
    const entry: CapabilityEntry = { canonical, capability: fact.capability, estimated: fact.estimated === true };
    const seen = byCanonical.get(canonical);
    if (!seen) byCanonical.set(canonical, entry);
    else if (!sameCapability(seen.capability, entry.capability)) conflicts.push(canonical);
  }
  return { byCanonical, conflicts };
}

/**
 * 由 pi registry 建立 route 表。`endpointsByKey`（key = `provider/model`）有值時用它
 * 的多上游報價；否則退回 registry 的單一 `cost` 當唯一 endpoint。無任何報價的模型
 * 先跳過（S1 不定價 = 不收；比照事實檔「缺價不切帶」的既有原則）。
 */
export function buildRoutes(
  registry: readonly RegistryModel[],
  options: {
    endpointsByKey?: ReadonlyMap<string, readonly EndpointQuote[]>;
    canonicalByKey?: ReadonlyMap<string, string>;
    aggregators?: ReadonlySet<string>;
  } = {},
): Route[] {
  const aggregators = options.aggregators ?? new Set(["openrouter"]);
  const routes: Route[] = [];
  for (const model of registry) {
    const key = `${model.provider}/${model.id}`;
    const provided = options.endpointsByKey?.get(key);
    const endpoints: EndpointQuote[] =
      provided && provided.length > 0
        ? [...provided]
        : model.cost
          ? [
              {
                upstream: model.provider,
                input: model.cost.input,
                output: model.cost.output,
                contextWindow: model.contextWindow,
              },
            ]
          : [];
    if (endpoints.length === 0) continue;
    routes.push({
      canonical: canonicalOf(model.provider, model.id, options.canonicalByKey?.get(key)),
      provider: model.provider,
      kind: aggregators.has(model.provider) ? "aggregator" : "direct",
      model: model.id,
      endpoints,
    });
  }
  return routes;
}
