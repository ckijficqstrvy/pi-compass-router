// ui/wizard/edit/classifier.ts — 設定選單「classifier」組的逐項編輯。
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

export async function editClassifier(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ④ 分類
    case "provider": {
      // 選項要把「選到的是哪個分類器」講清楚，並帶上 cloud 目前的模型
      // （動態尾巴由 providerFromLabel 的前綴比對認回代號）。
      const cloudModel = `${config.classify.cloud.provider}/${config.classify.cloud.model}`;
      const options = [providerLabel("laya"), `${providerLabel("cloud")} · ${cloudModel}`];
      const picked = await pickFrom(hooks, t`分類後端（目前：${config.classify.provider}）`, options);
      if (picked === undefined || picked === null) return picked;
      const provider = providerFromLabel(picked);
      if (provider === null || (provider !== "laya" && provider !== "cloud")) return null;
      const value = { provider: provider as "laya" | "cloud" };
      return classifyEdit(value);
    }

    case "checkpoint": {
      const cloud = config.classify.provider === "cloud";
      const label = cloud ? "分類模型（cloud）" : "Laya checkpoint";
      const current = cloud
        ? `${config.classify.cloud.provider}/${config.classify.cloud.model}`
        : config.classify.model;
      // 內建預設永遠是候選之一：候選來源全空時也不會把人逼去打字。
      const seed = cloud
        ? `${DEFAULT_CONFIG.classify.cloud.provider}/${DEFAULT_CONFIG.classify.cloud.model}`
        : DEFAULT_CONFIG.classify.model;
      const provided = dedupe((await hooks.candidates?.(cloud ? "classifier" : "checkpoint")) ?? []);
      const options = dedupe([current, seed, ...provided]);
      const check = (text: string): string | null => (text === "" ? t("模型 id 不能是空字串") : null);

      const picked = await pickFrom(hooks, label, [...options, CUSTOM_OPTION]);
      if (picked === undefined || picked === null) return picked;
      let chosen: string;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, t`${label}（id 或路徑）`, current, check);
        if (typed === undefined) return undefined;
        chosen = typed;
      } else chosen = picked;

      if (cloud) {
        const target = splitTarget(chosen);
        return classifyEdit({
          cloud: { provider: target.provider || config.classify.cloud.provider, model: target.model },
        });
      }
      return classifyEdit({ model: chosen });
    }

    case "classifyCache": {
      const fields: ReadonlyArray<{ key: "cache" | "cacheTtlSeconds"; label: string }> = [
        { key: "cache", label: t`分類結果快取 — ${onOff(config.classify.cache)}` },
        { key: "cacheTtlSeconds", label: t`快取秒數（TTL）— ${config.classify.cacheTtlSeconds}s` },
      ];
      const fieldRow = await pickFrom(hooks, "分類快取：選欄位", fields.map((field) => field.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;

      if (field.key === "cache") {
        const picked = await pickFrom(hooks, "分類結果快取", ["開", "關"]);
        if (picked === undefined || picked === null) return picked;
        return classifyEdit({ cache: picked === "開" });
      }

      const current = config.classify.cacheTtlSeconds;
      const options = ["30", "60", "120", "300", "600", "900"];
      if (!options.includes(String(current))) options.unshift(String(current));
      options.push(CUSTOM_OPTION);
      const picked = await pickFrom(hooks, "分類快取秒數（TTL）", options);
      if (picked === undefined || picked === null) return picked;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, "分類快取秒數（TTL，整數秒）", String(current), (text) =>
          /^\d+$/.test(text) ? null : t`「${text}」不是整數秒`,
        );
        if (typed === undefined) return undefined;
        return classifyEdit({ cacheTtlSeconds: Number(typed) });
      }
      return classifyEdit({ cacheTtlSeconds: Number(picked) });
    }

    case "classifyNums": {
      type NumKey = "timeoutMs" | "confidenceThreshold" | "minPromptChars" | "historyTurns";
      const fields: ReadonlyArray<{ key: NumKey; label: string; presets: readonly number[] }> = [
        { key: "timeoutMs", label: t`分類逾時 timeoutMs — ${config.classify.timeoutMs}ms`, presets: CLASSIFY_NUM_PRESETS.timeoutMs },
        {
          key: "confidenceThreshold",
          label: t`判斷門檻 confidenceThreshold — ${config.classify.confidenceThreshold}`,
          presets: CLASSIFY_NUM_PRESETS.confidenceThreshold,
        },
        { key: "minPromptChars", label: t`最短字數 minPromptChars — ${config.classify.minPromptChars}`, presets: CLASSIFY_NUM_PRESETS.minPromptChars },
        { key: "historyTurns", label: t`歷史輪數 historyTurns — ${config.classify.historyTurns}`, presets: CLASSIFY_NUM_PRESETS.historyTurns },
      ];
      const fieldRow = await pickFrom(hooks, "分類參數：選欄位", fields.map((field) => field.label));
      if (fieldRow === undefined || fieldRow === null) return fieldRow;
      const field = fields.find((candidate) => candidate.label === fieldRow);
      if (!field) return null;

      const current = config.classify[field.key];
      const options = field.presets.map((value) => String(value));
      if (!options.includes(String(current))) options.unshift(String(current));
      options.push(CUSTOM_OPTION);
      const picked = await pickFrom(hooks, field.label.split(" — ")[0], options);
      if (picked === undefined || picked === null) return picked;

      const patch = (value: number): Partial<CompassConfig["classify"]> =>
        ({ [field.key]: value }) as Partial<CompassConfig["classify"]>;
      if (picked === CUSTOM_OPTION) {
        const typed = await promptLoop(hooks, t`${field.label.split(" — ")[0]}（數字）`, String(current), (text) => {
          const value = parseAmount(text);
          return value !== null ? null : t`「${text}」不是有效數字`;
        });
        if (typed === undefined) return undefined;
        return classifyEdit(patch(parseAmount(typed) as number));
      }
      return classifyEdit(patch(Number(picked)));
    }
    default:
      return null;
  }
}
