// policy/filter.ts — L2 政策過濾：deny / allowProviders / prefer
//（SPEC Part 9 四層政策、Part 5 Stage 3）。
import type { CompassConfig, Target } from "../schema.js";

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

  const injected: Target[] = heads.map((model) => ({
    provider: "",
    model,
    explicit: true,
  }));
  const injectedIds = new Set(injected.map((target) => target.model));
  return [...injected, ...chain.filter((target) => !injectedIds.has(target.model))];
}