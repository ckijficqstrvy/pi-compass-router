// ui/wizard/edit/policy.ts — 設定選單「policy」組的逐項編輯。
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

export async function editPolicy(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ⑤ 政策
    case "filters": {
      const lists = [
        t`deny — 排除模型／glob（${config.deny.length}）`,
        t`allowProviders — 只放行這些 provider（${config.allowProviders.length}）`,
      ];
      const listRow = await pickFrom(hooks, "過濾規則：選一份清單", lists);
      if (listRow === undefined || listRow === null) return listRow;
      const isDeny = listRow.startsWith("deny");
      const key = isDeny ? "deny" : "allowProviders";
      const current = isDeny ? config.deny : config.allowProviders;

      const pool = isDeny
        ? dedupe([...current, ...ownModelKeys(config), ...factKeys()])
        : ownProviders(config);
      const rows = pool.map((entry) => `${current.includes(entry) ? "✓" : "✗"} ${entry}`);
      const addLabel = isDeny ? "新增 glob 模式…" : "新增 provider…";
      const pickedRow = await pickFrom(
        hooks,
        isDeny ? "deny：選一項切換（✓ = 已排除）" : "allowProviders：選一項切換（✓ = 已放行）",
        [...rows, addLabel],
      );
      if (pickedRow === undefined || pickedRow === null) return pickedRow;

      let next: string[];
      if (pickedRow === addLabel) {
        const typed = await promptLoop(
          hooks,
          isDeny ? "新增 deny 模式（glob，例如 openai/*）" : "新增 provider 代號",
          "",
          (text) => (text === "" ? t("內容不能是空字串") : null),
        );
        if (typed === undefined) return undefined;
        next = dedupe([...current, typed]);
      } else {
        const entry = pickedRow.slice(2); // 剝掉 "✓ " / "✗ "
        next = current.includes(entry) ? current.filter((value) => value !== entry) : [...current, entry];
      }
      const applied: Partial<CompassConfig> = { [key]: next } as Partial<CompassConfig>;
      return { key, value: next, applyTo: () => applied };
    }

    case "ceilings": {
      const tierRows = TIERS.map((tier) => {
        const own = config.ceilings[tier];
        const inherited = PROFILE_CEILINGS[config.profile][tier];
        return t`${tier}（${own !== undefined ? t`自訂 ${money(own)}` : t`依 profile ${money(inherited)}`}）`;
      });
      const tierRow = await pickFrom(hooks, "價格天花板：選層級", tierRows);
      if (tierRow === undefined || tierRow === null) return tierRow;
      const tier = tierRow.split(/[（(]/)[0] as Tier;

      const numeric = dedupe(
        (["cheap", "balanced", "quality"] as Profile[])
          .map((profile) => PROFILE_CEILINGS[profile][tier])
          .filter((value): value is number => typeof value === "number")
          .map((value) => String(value)),
      );
      const options = ["依 profile（清除自訂）", ...numeric, CUSTOM_OPTION];
      const picked = await pickFrom(hooks, t`${tier} 的天花板（$/M：input+2×output）`, options);
      if (picked === undefined || picked === null) return picked;

      if (picked === "依 profile（清除自訂）") {
        return {
          key: "ceilings",
          value: { [tier]: null },
          applyTo: (live) => {
            const next = { ...live.ceilings };
            delete next[tier];
            return { ceilings: next };
          },
        };
      }
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, t`${tier} 天花板（$/M 數字）`, "", (text) =>
          parseAmount(text) !== null ? null : t`「${text}」不是有效數字`,
        );
        if (typed === undefined) return undefined;
        const value = parseAmount(typed) as number;
        return {
          key: "ceilings",
          value: { [tier]: value },
          applyTo: (live) => ({ ceilings: { ...live.ceilings, [tier]: value } }),
        };
      }
      const value = Number(picked);
      return {
        key: "ceilings",
        value: { [tier]: value },
        applyTo: (live) => ({ ceilings: { ...live.ceilings, [tier]: value } }),
      };
    }

    case "scoresFile": {
      // /compass suggest 的來源檔（JSON，格式見 SPEC Part 10.1）。可在這裡指定或清除。
      const current = config.suggest.scoresFile;
      const options = [CLEAR_OPTION, ...(current === "" ? [] : [current]), CUSTOM_OPTION];
      const picked = await pickFrom(hooks, "建議分數檔（/compass suggest 的來源）", options);
      if (picked === undefined || picked === null) return picked;
      if (picked === CLEAR_OPTION) {
        return { key: "suggest", value: null, applyTo: () => ({ suggest: { scoresFile: "" } }) };
      }
      let path = picked;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, "分數檔路徑（JSON）", current, (text) =>
          text === "" ? "路徑不能是空字串" : null,
        );
        if (typed === undefined) return undefined;
        path = typed;
      }
      return {
        key: "suggest",
        value: { scoresFile: path },
        applyTo: (live) => ({ suggest: { ...live.suggest, scoresFile: path } }),
      };
    }

    default:
      return null;
  }
}
