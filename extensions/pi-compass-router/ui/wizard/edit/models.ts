// ui/wizard/edit/models.ts — 設定選單「models」組的逐項編輯。
import { t } from "../i18n.js";
import { DEFAULT_CONFIG, DISPLAY_COLORS, DISPLAY_DETAILS, DISPLAY_FIELDS, PROFILE_CEILINGS, THINKING_LEVELS, TIERS } from "../../../schema.js";
import type { CompassConfig, DisplayColor, DisplayDetail, DisplayField, Mode, Profile, Target, ThinkingLevel, Tier } from "../../../schema.js";
import type { WizardHooks } from "../types.js";
import type { MenuItem } from "../items.js";
import {
  CLASSIFY_NUM_PRESETS, CLEAR_OPTION, CUSTOM_OPTION, DAILY_PRESETS, DETAIL_HINT, MAX_CANDIDATES,
  MONTHLY_PRESETS, RATIO_PRESETS, SEARCH_OPTION, chainSummary, dedupe, factKeys, factsDate, keyOf,
  modeFromLabel, modeLabel, money, onOff, parseAmount, parseChain, profileFromLabel, profileLabel,
  providerFromLabel, providerLabel, splitTarget, staleDays, thinkingFromLabel, thinkingLabel,
  tierFromLabel, tierLabel,
} from "../labels.js";
import {
  applyChainFor, chooseModel, classifyEdit, displayEdit, modelCandidates, notice, ownModelKeys,
  ownProviders, pickFrom, pickModelFrom, promptLoop, simpleEdit, type EditResult,
} from "./shared.js";

export async function editModels(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ③ 模型
    case "chains":
    case "kindModels": {
      const isKind = item === "kindModels";
      const pools: ReadonlyArray<{ name: string; chain: Target[] }> = isKind
        ? dedupe([...Object.keys(config.taskKinds), ...Object.keys(config.kindModels)]).map((kind) => ({
            name: kind,
            chain: config.kindModels[kind] ?? [],
          }))
        : TIERS.map((tier) => ({ name: tier, chain: config.routes[tier] }));

      const poolRows = pools.map((pool) => `${pool.name} — ${chainSummary(pool.chain)}`);
      const poolRow = await pickFrom(
        hooks,
        isKind ? "專家鏈：選任務種類" : "模型鏈：選層級",
        poolRows,
      );
      if (poolRow === undefined || poolRow === null) return poolRow;
      const pool = pools.find((candidate) => poolRow.startsWith(`${candidate.name} — `));
      if (!pool) return null;

      const chainText = pool.chain.length === 0 ? t("(空)") : pool.chain.map(keyOf).join(" → ");
      const actions = [
        "設為首選…",
        "放到末尾…",
        ...(pool.chain.length > 0 ? ["移除一個模型…"] : []),
        ...(pool.chain.some((target) => target.explicit) ? ["改回自動（清除你寫的）"] : []),
        "自訂整條字串…",
      ];
      const action = await pickFrom(hooks, t`${pool.name} 鏈 · 目前 ${chainText}`, actions);
      if (action === undefined || action === null) return action;

      const key = isKind ? "kindModels" : "routes";

      if (action === "改回自動（清除你寫的）") {
        // patch null = 刪子鍵：L1 事實自動推導恢復接管該層（routes），
        // 或回層級鏈（kindModels）。
        return {
          key,
          value: { [pool.name]: null },
          applyTo: (live) => {
            const fallback = isKind
              ? (DEFAULT_CONFIG.kindModels[pool.name] ?? []).map((target) => ({ ...target }))
              : (DEFAULT_CONFIG.routes[pool.name as Tier] ?? []).map((target) => ({ ...target }));
            return applyChainFor(live, isKind, pool.name, fallback);
          },
        };
      }

      let next: Target[];
      if (action === "自訂整條字串…") {
        const typed = await promptLoop(
          hooks,
          t`${pool.name} 鏈（provider/model, 逗號分隔）`,
          pool.chain.map(keyOf).join(", "),
          (text) => (parseChain(text).length > 0 ? null : t("至少要一個模型，例如 openrouter/x")),
        );
        if (typed === undefined) return undefined;
        next = parseChain(typed);
      } else if (action === "移除一個模型…") {
        const pickedKey = await pickFrom(hooks, t`${pool.name} 鏈：移除哪一個？`, pool.chain.map(keyOf));
        if (pickedKey === undefined || pickedKey === null) return pickedKey;
        next = pool.chain.filter((target) => keyOf(target) !== pickedKey);
        if (next.length === 0) {
          notice(hooks, "鏈不能是空的——至少留一個模型（要整層回自動，選「改回自動」）", "warning");
          return null;
        }
      } else {
        const chosenModel = await chooseModel(
          hooks,
          config,
          t`${pool.name} 鏈：${action === "設為首選…" ? t("選首選模型") : t("選要放的模型")}`,
          pool.chain[0] ? keyOf(pool.chain[0]) : "",
        );
        if (chosenModel === undefined || chosenModel === null) return chosenModel;
        const target = splitTarget(chosenModel);
        const rest = pool.chain.filter((existing) => keyOf(existing) !== chosenModel);
        next = action === "設為首選…" ? [target, ...rest] : [...rest, target];
      }

      const chainValue = next.map((target) => ({ ...target, explicit: true }));
      return {
        key,
        value: { [pool.name]: chainValue },
        applyTo: (live) => applyChainFor(live, isKind, pool.name, chainValue),
      };
    }

    case "prefer": {
      const tierRows = TIERS.map((tier) => {
        const head = config.prefer[tier]?.[0];
        return t`${tier}（${head ?? t("未設定")}）`;
      });
      const tierRow = await pickFrom(hooks, "prefer 首選：選層級", tierRows);
      if (tierRow === undefined || tierRow === null) return tierRow;
      const tier = tierRow.split(/[（(]/)[0] as Tier;

      const picked = await pickModelFrom(
        hooks,
        t`${tier} 的偏好首選（會插到鏈首）`,
        await modelCandidates(config, hooks),
        [CLEAR_OPTION],
      );
      if (picked === undefined || picked === null) return picked;

      if (picked === CLEAR_OPTION) {
        return {
          key: "prefer",
          value: { [tier]: null },
          applyTo: (live) => {
            const next = { ...live.prefer };
            delete next[tier];
            return { prefer: next };
          },
        };
      }
      let model = picked;
      if (model === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, t`${tier} 偏好首選（模型 id）`, config.prefer[tier]?.[0] ?? "", (text) =>
          text === "" ? t("模型 id 不能是空字串") : null,
        );
        if (typed === undefined) return undefined;
        model = typed;
      }
      return {
        key: "prefer",
        value: { [tier]: [model] },
        applyTo: (live) => ({ prefer: { ...live.prefer, [tier]: [model] } }),
      };
    }

    case "kindTiers": {
      const kinds = dedupe([...Object.keys(config.taskKinds), ...Object.keys(config.kindMinimumTier)]);
      const kindRows = kinds.map((kind) => t`${kind} — 目前 ${config.kindMinimumTier[kind] ?? t("（無下限）")}`);
      const kindRow = await pickFrom(hooks, "任務最低層級：選種類", kindRows);
      if (kindRow === undefined || kindRow === null) return kindRow;
      const kind = kindRow.split(" — ")[0];

      const tierPicked = await pickFrom(hooks, t`${kind} 的最低層級`, TIERS.map(tierLabel));
      if (tierPicked === undefined || tierPicked === null) return tierPicked;
      const tier = tierFromLabel(tierPicked);
      if (tier === null) return null;

      return {
        key: "kindMinimumTier",
        value: { [kind]: tier },
        applyTo: (live) => ({ kindMinimumTier: { ...live.kindMinimumTier, [kind]: tier } }),
      };
    }

    case "xpremium": {
      const picked = await pickFrom(hooks, "xpremium 層", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const value = { enabled: picked === "開" };
      return simpleEdit("xpremium", value, { xpremium: value });
    }

    case "useDefaultModels": {
      const picked = await pickFrom(hooks, "內建模型鏈", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const useDefaultModels = picked === "開";
      return simpleEdit("useDefaultModels", useDefaultModels, { useDefaultModels });
    }
    default:
      return null;
  }
}
