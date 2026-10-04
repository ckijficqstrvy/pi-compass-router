// policy/filter.ts — L2 政策過濾：deny / allowProviders / prefer / 價格帶天花板
//（SPEC Part 9 四層政策、Part 5 Stage 3）。
import { PROFILE_CEILINGS, type CompassConfig, type Profile, type Target, type Tier } from "../schema.js";
import { targetKey } from "../target.js";

/**
 * 某層的生效天花板（$\/M，`input+2×output`）：顯式 `ceilings[tier]` 覆寫
 * 優先，否則用 `profile` 表（Part 9 價格帶表），無對應 → `null`（∞）。
 *
 * 原為 `config/load.ts` 的私有函式；Stage 3 menu gate 第 5 道（價格在該層
 * 價格帶內）同樣需要它，故上提到 L2 政策的家。load 與 select 都 import 這裡，
 * 不會違反 Part 11 相依方向（兩者皆在 `config`/`policy` 層，均低於 `route`）。
 */
export function ceilingFor(
  config: Pick<CompassConfig, "ceilings" | "profile">,
  tier: Tier,
): number | null {
  const own = config.ceilings[tier];
  if (own !== undefined) return own;
  return PROFILE_CEILINGS[config.profile as Profile][tier] ?? null;
}

/**
 * glob → RegExp：`*` 為任意字元（含 `/`），其餘正規表示元一律跳脫，
 * 並以不區分大小寫比對（模型 id 的大小寫由 provider 決定，不穩定）。
 */
function globToRegExp(pattern: string): RegExp {
  const body = pattern
    .toLowerCase()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}$`);
}

/**
 * L2 政策過濾。
 *
 * **只過濾「衍生」鏈**（Part 9 L2）：帶 `explicit` 的條目是 L3 顯式設定，
 * 永不被 `deny` / `allowProviders` 濾掉——即使 pattern 明顯命中它自己
 * （Part 2：顯式勝過政策）。
 *
 * 比對兩個形狀：`provider/model` 與裸 `model`（模型 id 本身常含 `/`，
 * 例如 `~z-ai/glm-latest`，故兩者都要試）。
 */
export function filterChain(chain: Target[], config: CompassConfig): Target[] {
  const { deny, allowProviders } = config;
  if (deny.length === 0 && allowProviders.length === 0) return chain;

  const patterns = deny.map(globToRegExp);
  return chain.filter((target) => {
    if (target.explicit) return true;
    if (allowProviders.length > 0 && !allowProviders.includes(target.provider)) return false;
    if (patterns.length === 0) return true;
    const full = `${target.provider}/${target.model}`.toLowerCase();
    const bare = target.model.toLowerCase();
    return !patterns.some((re) => re.test(full) || re.test(bare));
  });
}

/**
 * 把 `prefer[tier]` 插在鏈首（Part 3.1、Part 9 L3：prefer 是顯式的，
 * 永不被過濾）。條目一律標 `explicit`，且以 `provider: ""` 表示
 * 「只按完整模型 id 比對」——id 常含 `/`，provider 無從拆解。
 *
 * 與既有鏈中同 id 的條目去重，避免同一模型出現兩次。
 */
export function insertPrefer(chain: Target[], tier: string, config: CompassConfig): Target[] {
  const heads = config.prefer[tier as keyof CompassConfig["prefer"]];
  if (!heads || heads.length === 0) return chain;

  // 2026-10-03（W3，N2 修正）：prefer 條目是**裸 model id**——它常自帶 `/`
  // （`xiaomi/mimo-v2.6-pro`、`openai/gpt-6-sol`），強拆 provider 會拆出不存在
  // 的 provider，反而讓 head 再次被 availability 丟棄。這裡保持 provider:"",
  // 由 `resolveModel` 以 registry **唯一 id 匹配**解析；必要時才退回 provider 拆解。
  const injected: Target[] = heads.map((model) => ({ provider: "", model, explicit: true }));
  // 去重：prefer 的裸 id 可能與鏈上 provider/model 指到同一模型（比對裸 id 與完整 key）。
  const ids = new Set<string>();
  for (const target of injected) {
    ids.add(target.model);
    ids.add(targetKey(target));
  }
  return [...injected, ...chain.filter((target) => !ids.has(target.model) && !ids.has(targetKey(target)))];
}