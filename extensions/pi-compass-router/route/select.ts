// route/select.ts — Stage 3：候選鏈組裝（SPEC Part 5：專家 → 層級 → 池）。
import { MODEL_FACTS, blendedOf, factFor, factsValid, rankedFacts } from "../policy/facts.js";
import { ceilingFor, filterChain } from "../policy/filter.js";
import { TIERS, TIER_CAPABILITY_FLOOR, type CompassConfig, type Target, type Tier } from "../schema.js";
import type { Judgment } from "../classify/types.js";

/** 層級由低到高；供 minTier 過濾與「最近可用層級」回退比較用。 */
/** 層級由低到高；唯一來源是 schema 的 TIERS。 */
const TIER_ORDER: readonly Tier[] = TIERS;

function tierRank(tier: Tier): number {
  return TIER_ORDER.indexOf(tier);
}

import { targetFromKey, targetKey } from "../target.js";
export { targetFromKey, targetKey } from "../target.js";

/**
 * 組 menu（`modelPick: "menu"` 時供 Stage 1 傳入 `ClassifyInput.menu`）。
 *
 * 去重（同 id 只留第一個）、過濾 `minTier > tier`、**只在候選 > 1 時組成**
 * ——`buildQuestions` 對 menu 長度 ≤ 1 不加第六題，多組只會白送一題。
 * 回 `undefined` 表示「本次不問 menu」。
 */
export function menuKeys(tier: Tier, judgment: Judgment | undefined, config: CompassConfig): string[] | undefined {
  if (config.modelPick !== "menu") return undefined;
  const { chain } = selectTargets(tier, judgment, config);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const target of chain) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys.length > 1 ? keys : undefined;
}

/**
 * 按 `specialistPriority[kind]` 排序（移植 #8：priority 決定順序，而非只看
 * minTier 接近度）。`specialistPriority[kind]` 是 model id 的排序表：
 * 表內的依表序排前，表內沒有的保持原序墊後（不因沒寫就被丟掉）。
 */
function orderSpecialists(chain: Target[], kind: string, config: CompassConfig): Target[] {
  const order = config.specialistPriority[kind];
  if (!order || order.length === 0) return chain;
  const rankOf = (target: Target): number => {
    const index = order.indexOf(target.model);
    return index === -1 ? order.length : index;
  };
  return [...chain]
    .map((target, position) => ({ target, position }))
    .sort((a, b) => rankOf(a.target) - rankOf(b.target) || a.position - b.position)
    .map(({ target }) => target);
}

/**
 * `freeOnly` 的全域免費池（Part 5 Stage 3，2026-10-01 補定：與 `freePool`
 * 是兩個獨立的池）。取事實檔中 `input==0 && output==0` 的模型，依能力降序；
 * 無零元模型 → 回退 `freePool.models`（若 enabled）→ 再回退 `routes[tier]`
 * （fail-open：不因沒有免費模型就無路由）。
 */
function freeOnlyChain(config: CompassConfig, tier: Tier): { chain: Target[]; fallback: "freePool" | "paid" | null } {
  if (factsValid(MODEL_FACTS)) {
    const zero = rankedFacts(MODEL_FACTS)
      .filter((fact) => fact.price !== undefined && fact.price.input === 0 && fact.price.output === 0)
      .map((fact) => ({ provider: fact.provider, model: fact.model }));
    if (zero.length > 0) return { chain: zero, fallback: null };
  }
  if (config.freePool.enabled && config.freePool.models.length > 0) {
    return { chain: [...config.freePool.models], fallback: "freePool" };
  }
  return { chain: [...config.routes[tier]], fallback: "paid" };
}

/**
 * menu 選項的六道閘（Part 5 Stage 3「modelPick 先於上述所有」的 gate 表）。
 * 回 `null` 表示通過；回字串表示第一個失敗原因（寫進 entry 的 `notes`）。
 *
 * 閘 1 與 3 的分工（2026-10-01 澄清）：閘 1「存在於 registry」對**內建菜單**
 * 而言就是「在事實檔裡」；但 menu 本身是呼叫端組的（含使用者 `explicit` 條目
 * 與 `allowUnratedPicks` 時的未評分候選），故閘 1 改為「**事實檔有** 或
 * **條目是 explicit** 或 **未評分但已允許**」——否則 `allowUnratedPicks: true`
 * 的路徑永遠走不到閘 3。真正的「已評分」是閘 3（`unrated model`），只看事實檔。
 */
function menuGate(key: string, tier: Tier, config: CompassConfig, target: Target): string | null {
  // 閘 1 registry：事實檔有此事實，或條目是 explicit，或已允許未評分。
  const fact = target.provider ? factFor(target.provider, target.model) : factFor("", target.model);
  if (!fact && !target.explicit && !config.allowUnratedPicks) return "not in registry";

  // 閘 2 deny / allowProviders：filterChain 移除它即表示被政策擋下（explicit 永過）。
  if (filterChain([target], config).length === 0) return "denied by policy";

  // 閘 3 已評分：只有事實檔沒此事實才算未評分；allowUnratedPicks 為真時跳過。
  if (!fact && !config.allowUnratedPicks) return "unrated model";

  if (fact) {
    // 閘 4 capability ≥ 該層下限。
    const floor = TIER_CAPABILITY_FLOOR[tier];
    if (fact.capability < floor) {
      return `capability ${fact.capability} below floor ${floor}`;
    }
    // 閘 5 價格在該層價格帶內（profile/ceilings 生效值）。
    if (fact.price) {
      const ceiling = ceilingFor(config, tier);
      if (ceiling !== null && blendedOf(fact.price) > ceiling) return "price over ceiling";
    }
  }

  // 閘 6 型別：parseAnalysis 已保證 pick 在 menuKeys 內（見 analysis.ts），
  // 此處只作防禦性重驗——編碼一致才可能落到这里。
  if (targetKey(target) !== key) return "unknown menu id";
  return null;
}

/**
 * Stage 3（Part 5）：先專家後層級，依序產出候選鏈。
 *
 * 1. `freeOnly` 為真 → 只走免費池（跳過 2–4，但 `explicit`/`prefer` 仍勝出）
 * 2. `specialistPriority[kind]` 排序的 `kindModels[kind]`（過濾 `minTier > tier`）
 * 3. `routes[tier]`
 * 4. `freePool.models`（`freePool.enabled` **且當前層無候選**才進場）
 *
 * `modelPick: "menu"` 且 `judgment.modelPick` 存在時，該選項**先於上述所有**，
 * 但須通過六道閘；任一失敗記 `notes` 並退回鏈。
 *
 * **注意**：本函式只回有序鏈，**不做可用性回退**——可用性由呼叫端在鏈上逐個
 * 試（Stage 4 實作契約第 1 點：`guard` 沒有 registry 的存取權，同理 Stage 3
 * 也不該在這裡假裝知道模型是否「存在且已認證」）。
 */
/** Stage 3 輸出：有序候選鏈 + menu 選項 + gate 拒絕 notes（Part 5）。 */
export interface SelectResult {
  /** 有序候選鏈（未含 menu 選項，它在 `picked` 裡）。 */
  chain: Target[];
  /** menu gate 通過時的選項（已置頂）；未問 menu 或被拒時為 `undefined`。 */
  picked?: Target;
  /** menu gate 拒絕原因（供 entry 展開）；通過或未問 menu 時為空。 */
  notes: string[];
}

/**
 * Stage 3（Part 5）：先專家後層級，依序產出候選鏈。
 *
 * 1. `freeOnly` 為真 → 只走免費池（跳過 2–4，但 `explicit`/`prefer` 仍勝出）
 * 2. `specialistPriority[kind]` 排序的 `kindModels[kind]`（過濾 `minTier > tier`）
 * 3. `routes[tier]`
 * 4. `freePool.models`（`freePool.enabled` **且當前層無候選**才進場）
 *
 * `modelPick: "menu"` 且 `judgment.modelPick` 存在時，該選項**先於上述所有**，
 * 但須通過六道閘；任一失敗記入 `notes` 並退回鏈（不進 `picked`）。
 *
 * **注意**：本函式只回有序鏈，**不做可用性回退**——可用性由呼叫端在鏈上逐個
 * 試（Stage 4 實作契約第 1 點：`guard` 沒有 registry 的存取權，同理 Stage 3
 * 也不該在這裡假裝知道模型是否「存在且已認證」）。
 */
/** 依 `targetKey` 保序去重（第一筆優先）。 */
function dedupeChain(chain: readonly Target[]): Target[] {
  const seen = new Set<string>();
  const out: Target[] = [];
  for (const target of chain) {
    const key = targetKey(target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(target);
  }
  return out;
}

export function selectTargets(
  tier: Tier,
  judgment: Judgment | undefined,
  config: CompassConfig,
): SelectResult {
  const notes: string[] = [];

  // freeOnly 特殊情境：只用 $0 模型（跳過專家鏈與層級鏈）。
  if (config.freeOnly) {
    const explicitHeads = (config.prefer[tier] ?? []).map((model) => ({
      provider: "",
      model,
      explicit: true,
    }));
    const fallbackChain = freeOnlyChain(config, tier);
    const body = fallbackChain.chain.filter(
      (target) => !explicitHeads.some((head) => head.model === target.model),
    );
    if (fallbackChain.fallback === "paid") {
      // C4（2026-10-05）：strictFreeOnly 是 opt-in 的**硬保證**——沒有可驗證的
      // $0 模型時不再回退付費，改為無路由（顯式 prefer 仍勝出，Part 9 L3）。
      if (config.strictFreeOnly) {
        notes.push("strictFreeOnly: no verified $0 model — no route");
        return { chain: explicitHeads, notes };
      }
      notes.push("no verified $0 model — paid fallback (freeOnly is not a hard guarantee)");
    } else if (fallbackChain.fallback === "freePool") {
      notes.push("no verified $0 model — using freePool fallback");
    }
    return { chain: [...explicitHeads, ...body], notes };
  }

  const chain: Target[] = [];

  // 1. 專家鏈（先專家後層級）。
  if (judgment) {
    const specialists = config.kindModels[judgment.kind] ?? [];
    const eligible = specialists.filter(
      (target) => !target.minTier || tierRank(target.minTier) <= tierRank(tier),
    );
    chain.push(...orderSpecialists(eligible, judgment.kind, config));
  }

  // 2. 層級鏈。
  chain.push(...config.routes[tier]);

  // 3. freePool 僅在當前層無候選時進場（移植 #3：池外免費模型是兕底，不是競品）。
  if (chain.length === 0 && config.freePool.enabled && config.freePool.models.length > 0) {
    chain.push(...config.freePool.models);
  }

  // 同一模型可同時來自專家鏈與層級鏈：保序去重，避免重試同一個候選（W7）。
  const candidates = dedupeChain(chain);

  // menu 選項先於上述所有（通過閘才頂置，否則退回鏈）。候選若已在鏈上，
  // 取鏈上的原始 Target（保留 explicit），否則才由 key 反解。
  const picked = judgment?.modelPick;
  if (picked !== undefined && config.modelPick === "menu") {
    const found = candidates.find((target) => targetKey(target) === picked);
    const head = found ?? targetFromKey(picked);
    const gate = menuGate(picked, tier, config, head);
    if (gate === null) {
      const rest = candidates.filter((target) => targetKey(target) !== targetKey(head));
      return { chain: [head, ...rest], picked: head, notes };
    }
    notes.push(gate);
  }

  return { chain: candidates, notes };
}

/**
 * 推導某模型目前所屬的層級（供應 Stage 4 的 deadband / cooldown / bypass 使用）。
 *
 * 以事實檔的 blended 價格對照目前 profile 的層級上限：回「第一個容得下它的
 * 層級」（cheap→…→premium）。這比「上次路由到的層級」稳——使用者手動換模型
 * 時也不會拿到隊舊資料；沒事實、沒價格 → `null`（guard 遇 null 會跳過規則，不猜）。
 */
export function tierOfModel(config: CompassConfig, provider: string, model: string): Tier | null {
  const fact = provider ? factFor(provider, model) : factFor("", model);
  if (!fact || fact.price === undefined) return null;
  const price = blendedOf(fact.price);
  for (let index = 0; index < TIER_ORDER.length; index += 1) {
    const tier = TIER_ORDER[index];
    if (tier === "xpremium" && !config.xpremium.enabled) continue;
    const ceiling = ceilingFor(config, tier);
    // An unbounded tier may only claim the remainder when no higher enabled
    // tier has a finite cap; otherwise a lower null would shadow every tier.
    if (ceiling === null) {
      const higherCapped = TIER_ORDER.slice(index + 1).some(
        (higher) => higher !== "xpremium" || config.xpremium.enabled,
      );
      if (!higherCapped) return tier;
      continue;
    }
    if (price <= ceiling) return tier;
  }
  return null;
}