// ui/wizard/edit/diagnostics.ts — 設定選單「diagnostics」組的逐項編輯。
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

export async function editDiagnostics(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ⑦ 診斷
    case "reset": {
      const targets: ReadonlyArray<{ key: string; label: string }> = [
        { key: "enabled", label: `enabled — ${onOff(config.enabled)}` },
        { key: "mode", label: `mode — ${config.mode}` },
        { key: "profile", label: `profile — ${config.profile}` },
        { key: "budget", label: `budget — ${money(config.budget.dailyUsd)} / ${money(config.budget.monthlyUsd)}` },
        { key: "cache", label: t`cache — ${onOff(config.cache.aware)} · 冷卻 ${config.cache.cooldownSeconds}s` },
        { key: "kindMinimumTier", label: t`kindMinimumTier — ${Object.keys(config.kindMinimumTier).length} 種` },
        { key: "freeOnly", label: `freeOnly — ${onOff(config.freeOnly)}` },
        { key: "classify", label: `classify — ${config.classify.provider} · ${config.classify.model}` },
        { key: "deny", label: t`deny — ${config.deny.length} 條` },
        { key: "allowProviders", label: t`allowProviders — ${config.allowProviders.length} 條` },
        { key: "modelPick", label: `modelPick — ${config.modelPick}` },
        { key: "stickiness", label: `stickiness — ${onOff(config.stickiness)}` },
        { key: "autoRoutes", label: `autoRoutes — ${onOff(config.autoRoutes)}` },
        { key: "allowUnratedPicks", label: `allowUnratedPicks — ${onOff(config.allowUnratedPicks)}` },
        { key: "useDefaultModels", label: `useDefaultModels — ${onOff(config.useDefaultModels)}` },
        { key: "xpremium", label: `xpremium — ${onOff(config.xpremium.enabled)}` },
        { key: "thinking", label: t`thinking — pin ${config.thinking.pin ?? t("（無）")}` },
        { key: "display", label: `display — ${config.display.detail} · ${config.display.color}` },
        { key: "prefer", label: t`prefer — ${Object.keys(config.prefer).length} 層` },
        { key: "ceilings", label: t`ceilings — ${Object.keys(config.ceilings).length} 層自訂` },
        { key: "routes", label: t("routes — 全部五層回自動派生") },
        { key: "kindModels", label: t("kindModels — 全部回層級鏈") },
      ];
      const picked = await pickFrom(hooks, "重設哪一項？（清單為白名單可寫鍵）", targets.map((t) => t.label));
      if (picked === undefined || picked === null) return picked;
      const target = targets.find((candidate) => candidate.label === picked);
      if (!target) return null;

      const confirm = await pickFrom(hooks, t`重設 ${target.key} 回預設？`, ["確定，重設", "取消"]);
      if (confirm === undefined || confirm === null) return confirm;
      if (confirm !== "確定，重設") return undefined;

      if (target.key === "routes" || target.key === "kindModels") {
        // 整組清除（patch null 逐層刪除）→ 回自動派生／回層級鏈。
        const keys = target.key === "routes" ? TIERS : Object.keys(config.kindModels);
        const patchValue = Object.fromEntries(keys.map((name) => [name, null]));
        return {
          key: target.key,
          value: patchValue,
          applyTo: (live) => {
            if (target.key === "routes") {
              return {
                routes: Object.fromEntries(
                  TIERS.map((tier) => [tier, (DEFAULT_CONFIG.routes[tier] ?? []).map((t) => ({ ...t }))]),
                ) as CompassConfig["routes"],
              };
            }
            return { kindModels: {} };
          },
        };
      }

      const value = structuredClone(DEFAULT_CONFIG[target.key as keyof typeof DEFAULT_CONFIG]);
      const applied = { [target.key]: value } as Partial<CompassConfig>;
      return { key: target.key, value, applyTo: () => applied };
    }

    case "testClassifier": {
      if (!hooks.probeClassifier) {
        notice(hooks, "這個環境不支援測試分類器（沒有掛點）", "warning");
        return undefined;
      }
      const result = await hooks.probeClassifier();
      notice(hooks, result, "info");
      return undefined;
    }

    case "chainSource": {
      const tierRows = TIERS.map((tier) => t`${tier}（${chainSummary(config.routes[tier])}）`);
      const tierRow = await pickFrom(hooks, "看鏈的來源：選層級", tierRows);
      if (tierRow === undefined || tierRow === null) return tierRow;
      const tier = tierRow.split(/[（(]/)[0] as Tier;

      const stale = staleDays();
      const lines = [
        t`${tier} 鏈（事實檔 ${factsDate()} · 自動推導 ${onOff(config.autoRoutes)} · 內建 ${onOff(config.useDefaultModels)}）`,
        ...(stale === null
          ? []
          : [t`⚠ 事實檔快照已 ${stale} 天——建議跑 npm run refresh-facts（價格與模型清單會跟著更新）`]),
        ...config.routes[tier].map(
          (target) => t`  ${keyOf(target)} — ${target.explicit ? t("你寫的（鎖定，不過濾）") : t("自動派生／內建")}`,
        ),
        ...(config.prefer[tier]?.length
          ? [t`  prefer 首選 ${config.prefer[tier][0]} — 會插到鏈首（L3）`]
          : []),
      ];
      notice(hooks, lines.join("\n"), "info");
      return undefined;
    }    default:
      return null;
  }
}
