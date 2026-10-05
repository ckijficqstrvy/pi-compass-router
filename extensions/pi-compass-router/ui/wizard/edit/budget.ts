// ui/wizard/edit/budget.ts — 設定選單「budget」組的逐項編輯。
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

export async function editBudget(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ② 預算
    case "daily":
    case "monthly": {
      const daily = item === "daily";
      const label = daily ? t("每日上限") : t("每月上限");
      const dim = daily ? ("dailyUsd" as const) : ("monthlyUsd" as const);
      const current = daily ? config.budget.dailyUsd : config.budget.monthlyUsd;
      const presets: readonly number[] = daily ? DAILY_PRESETS : MONTHLY_PRESETS;

      const options: string[] = ["無上限（清除）"];
      if (current !== null && !presets.includes(current)) options.push(t`沿用目前 ${money(current)}`);
      for (const preset of presets) options.push(money(preset));
      options.push(CUSTOM_OPTION);

      const picked = await pickFrom(hooks, label, options);
      if (picked === undefined || picked === null) return picked;

      let amount: number | null;
      if (picked === "無上限（清除）") amount = null;
      else if (picked.startsWith(t("沿用目前"))) amount = current;
      else if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(
          hooks,
          t`${label}（美元數字，留空 = 無上限）`,
          current === null ? "" : String(current),
          (text) => {
            if (text === "") return null;
            const value = parseAmount(text);
            return value !== null && value > 0 ? null : t`「${text}」不是有效金額（需 > 0；要清除請留空）`;
          },
        );
        if (typed === undefined) return undefined;
        amount = typed === "" ? null : parseAmount(typed);
      } else {
        amount = Number(picked.replace(/[$,]/g, ""));
      }

      const value: Record<string, unknown> = { [dim]: amount };
      return {
        key: "budget",
        value,
        applyTo: (live) => ({ budget: { ...live.budget, [dim]: amount } }),
      };
    }

    case "ratios": {
      const fields = [
        { key: "softRatio" as const, label: t`軟警戒線 softRatio — ${config.budget.softRatio}` },
        { key: "hardRatio" as const, label: t`強制線 hardRatio — ${config.budget.hardRatio}` },
      ];
      const fieldRow = await pickFrom(hooks, "預算警戒線：選欄位", fields.map((f) => f.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;

      const current = config.budget[field.key];
      const options = RATIO_PRESETS.map((value) => String(value));
      if (!options.includes(String(current))) options.unshift(String(current));
      options.push(CUSTOM_OPTION);
      const picked = await pickFrom(hooks, field.label.split(" — ")[0], options);
      if (picked === undefined || picked === null) return picked;

      let ratio: number;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, t`${field.key}（0–1 之間）`, String(current), (text) => {
          const value = parseAmount(text);
          return value !== null && value <= 1 ? null : t`「${text}」不是 0–1 之間的數字`;
        });
        if (typed === undefined) return undefined;
        ratio = parseAmount(typed) as number;
      } else {
        ratio = Number(picked);
      }
      const value: Record<string, unknown> = { [field.key]: ratio };
      return {
        key: "budget",
        value,
        applyTo: (live) => ({ budget: { ...live.budget, [field.key]: ratio } }),
      };
    }

    case "profile": {
      const picked = await pickFrom(
        hooks,
        t`價格 profile（目前：${config.profile}）`,
        (["cheap", "balanced", "quality"] as Profile[]).map(profileLabel),
      );
      if (picked === undefined || picked === null) return picked;
      const profile = profileFromLabel(picked);
      if (profile === null) return null;
      return { key: "profile", value: profile, applyTo: () => ({ profile }) };
    }

    case "freeOnly": {
      const picked = await pickFrom(hooks, "特殊情境（free-only）", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const freeOnly = picked === "開";
      return simpleEdit("freeOnly", freeOnly, { freeOnly });
    }
    case "strictFreeOnly": {
      const picked = await pickFrom(hooks, t("free-only 嚴格（不付費）"), ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const strictFreeOnly = picked === "開";
      return simpleEdit("strictFreeOnly", strictFreeOnly, { strictFreeOnly });
    }
    default:
      return null;
  }
}
