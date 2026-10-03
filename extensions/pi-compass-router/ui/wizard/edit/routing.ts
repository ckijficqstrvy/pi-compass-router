// ui/wizard/edit/routing.ts — 設定選單「routing」組的逐項編輯。
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

export async function editRouting(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ① 路由
    case "enabled": {
      const picked = await pickFrom(hooks, "啟用 compass", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const enabled = picked === "開";
      return simpleEdit("enabled", enabled, { enabled });
    }

    case "mode": {
      const picked = await pickFrom(
        hooks,
        t`路由模式（目前：${config.mode}）`,
        (["auto", "confirm", "notify"] as Mode[]).map(modeLabel),
      );
      if (picked === undefined || picked === null) return picked;
      const mode = modeFromLabel(picked);
      if (mode === null) return null;
      return { key: "mode", value: mode, applyTo: () => ({ mode }) };
    }

    case "stickiness": {
      const picked = await pickFrom(hooks, "粘住當前模型", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const stickiness = picked === "開";
      return simpleEdit("stickiness", stickiness, { stickiness });
    }

    case "modelPick": {
      const picked = await pickFrom(hooks, "手動挑模型", ["off — 不挑，走自動路由", "menu — 每次用選單挑"]);
      if (picked === undefined || picked === null) return picked;
      const modelPick = picked.startsWith("menu") ? ("menu" as const) : ("off" as const);
      return simpleEdit("modelPick", modelPick, { modelPick });
    }

    case "allowUnratedPicks": {
      const picked = await pickFrom(hooks, "允許未評分模型", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      const allowUnratedPicks = picked === "開";
      return simpleEdit("allowUnratedPicks", allowUnratedPicks, { allowUnratedPicks });
    }

    case "thinking": {
      const scopes = ["pin（全域覆蓋）", ...Object.keys(config.taskKinds)];
      const scopeRow = await pickFrom(hooks, "思考層級：選範圍", scopes);
      if (scopeRow === undefined || scopeRow === null) return scopeRow;
      const isPin = scopeRow.startsWith("pin");
      const kind = isPin ? "pin" : scopeRow;

      const levelRows = [CLEAR_OPTION, ...THINKING_LEVELS.map(thinkingLabel)];
      const levelRow = await pickFrom(hooks, t`${kind} 的思考層級`, levelRows);
      if (levelRow === undefined || levelRow === null) return levelRow;
      const level = levelRow === CLEAR_OPTION ? null : thinkingFromLabel(levelRow);
      if (level === undefined || (levelRow !== CLEAR_OPTION && level === null)) return null;
      const value: Partial<Record<string, ThinkingLevel | null>> = { [kind]: level };
      return {
        key: "thinking",
        value,
        applyTo: (live) => {
          const next = { ...live.thinking };
          const level = value[kind];
          if (level === null) delete next[kind];
          else next[kind] = level ?? undefined;
          return { thinking: next };
        },
      };
    }

    case "cache": {
      const fields: ReadonlyArray<{ key: string; label: string }> = [
        { key: "aware", label: t`感知（aware）— ${onOff(config.cache.aware)}` },
        { key: "cooldownSeconds", label: t`冷卻秒數 — ${config.cache.cooldownSeconds}s` },
        { key: "deadband", label: t`死區 deadband — ${config.cache.deadband}` },
        { key: "maxPenaltyUsd", label: t`切換懲罰上限 — $${config.cache.maxPenaltyUsd}` },
        { key: "bypassTierDelta", label: t`繞過層級差 — ${config.cache.bypassTierDelta}` },
      ];
      const fieldRow = await pickFrom(hooks, "切換成本 cache：選欄位", fields.map((f) => f.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;
      const name = field.label.split(" — ")[0];

      let patch: Record<string, unknown>;
      if (field.key === "aware") {
        const picked = await pickFrom(hooks, "cache 感知", ["開", "關"]);
        if (picked === undefined || picked === null) return picked;
        patch = { aware: picked === "開" };
      } else {
        const presets: readonly number[] =
          field.key === "cooldownSeconds"
            ? [0, 5, 15, 30, 60, 120, 300, 600]
            : field.key === "deadband"
              ? [0, 0.1, 0.25, 0.5, 1]
              : field.key === "maxPenaltyUsd"
                ? [0, 0.01, 0.05, 0.1, 0.25]
                : [0, 1, 2, 3, 5];
        const current = config.cache[field.key as keyof typeof config.cache];
        const options = presets.map((value) => String(value));
        if (typeof current === "number" && !presets.includes(current)) options.unshift(String(current));
        options.push(CUSTOM_OPTION);

        const picked = await pickFrom(hooks, name, options);
        if (picked === undefined || picked === null) return picked;
        if (picked === CUSTOM_OPTION) {
          const typed = await promptLoop(
            hooks,
            t`${name}（數字）`,
            String(current),
            (text) => (parseAmount(text) !== null ? null : t`「${text}」不是有效數字`),
          );
          if (typed === undefined) return undefined;
          patch = { [field.key]: parseAmount(typed) };
        } else {
          patch = { [field.key]: Number(picked) };
        }
      }
      return {
        key: "cache",
        value: patch,
        applyTo: (live) => ({ cache: { ...live.cache, ...patch } }),
      };
    }
    default:
      return null;
  }
}
