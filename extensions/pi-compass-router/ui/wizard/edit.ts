// ui/wizard/edit.ts — 逐項編輯（回傳要寫入的 key/value 與如何在活設定上套用）。
import { t, rawOf } from "./i18n.js";
import { DEFAULT_CONFIG, PROFILE_CEILINGS, THINKING_LEVELS, TIERS } from "../../schema.js";
import type { CompassConfig, Profile, Target, ThinkingLevel, Tier, Mode } from "../../schema.js";
import { DISPLAY_DETAILS, DISPLAY_FIELDS } from "../../schema.js";
import type { DisplayColor, DisplayDetail, DisplayField } from "../../schema.js";
import type { CandidateKind, WizardHooks } from "./types.js";
import type { MenuItem } from "./items.js";
import {
  CLASSIFY_NUM_PRESETS, CLEAR_OPTION, CUSTOM_OPTION, DAILY_PRESETS, DETAIL_HINT,
  MAX_CANDIDATES, MONTHLY_PRESETS, RATIO_PRESETS, SEARCH_OPTION,
  chainSummary, dedupe, factKeys, keyOf, modeFromLabel, modeLabel, money, onOff,
  parseAmount, parseChain, profileFromLabel, profileLabel, providerFromLabel, providerLabel,
  splitTarget, thinkingFromLabel, thinkingLabel, tierFromLabel, tierLabel, staleDays, factsDate,
} from "./labels.js";
/** 設定裡已出現的所有模型（已在用的最該出現在候選裡）。 */
export function ownModelKeys(config: CompassConfig): string[] {
  const out: string[] = [];
  for (const chain of Object.values(config.routes)) out.push(...chain.map(keyOf));
  for (const chain of Object.values(config.kindModels)) out.push(...chain.map(keyOf));
  out.push(...config.freePool.models.map(keyOf));
  return out;
}

/** 設定裡已出現的 provider（`allowProviders` 候選）。 */
export function ownProviders(config: CompassConfig): string[] {
  const out: string[] = [...config.allowProviders];
  for (const chain of Object.values(config.routes)) out.push(...chain.map((t) => t.provider));
  for (const chain of Object.values(config.kindModels)) out.push(...chain.map((t) => t.provider));
  out.push(...factKeys().map((key) => splitTarget(key).provider));
  return dedupe(out.filter((p) => p !== ""));
}

/** 提示（`notify` 未實作時靜默——不因缺 UI 而崩）。 */
export function notice(
  hooks: WizardHooks,
  message: string,
  type: "info" | "warning" | "error" = "warning",
): void {
  hooks.notify?.(t(message), type);
}

/**
 * 取一項。回 `undefined` = 取消（Esc）；回 `null` = hooks 丟了非選項字串
 * （非規格行為，視為這次編輯作廢）。
 */
export async function pickFrom(
  hooks: WizardHooks,
  label: string,
  options: string[],
): Promise<string | undefined | null> {
  // 顯示翻譯集中在此：固定項（raw 鍵）翻譯後顯示，組合項（來源已翻）原樣。
  // 回傳時 rawOf 把固定項翻回原文鍵——比較點維持原文，不必逐處改。
  const shown = options.map((option) => t(option));
  const picked = await hooks.pick(t(label), shown);
  if (picked === null) return undefined;
  return shown.includes(picked) ? rawOf(picked) : null;
}

/**
 * 打字輸入迴圈（**只在使用者選「自訂…」時到達**）。
 *
 * `check` 回 `null` = 合法，否則回錯誤訊息並**重問**（保留原輸入）；
 * Esc 回 `undefined`。空字串是否合法由 `check` 決定。
 */
export async function promptLoop(
  hooks: WizardHooks,
  label: string,
  initial: string,
  check: (text: string) => string | null,
): Promise<string | undefined> {
  let text = initial;
  for (;;) {
    const raw = await hooks.prompt(t(label), text);
    if (raw === null) return undefined;
    const trimmed = raw.trim();
    const problem = check(trimmed);
    if (problem === null) return trimmed;
    notice(hooks, t`${problem}——再試一次（Esc 取消）`, "warning");
    text = raw;
  }
}

/**
 * 模型候選：設定現用 ∪ 事實檔（**精選，先排**）∪ registry ∪ OpenRouter
 * 最新清單（`hooks.candidates`）。
 *
 * 兩組精選**永不被截掉**；registry/線上清單依字典序排在後面，讓
 * `openai/gpt-6.1-sol` 這種新模型找得到（2026-10-02：舊版只給 48 筆，
 * 第 294 位的新模型直接消失）；整體設 1000 筆安全上限，超出走「搜尋…」。
 */
export async function modelCandidates(config: CompassConfig, hooks: WizardHooks): Promise<string[]> {
  const provided = (await hooks.candidates?.("model")) ?? [];
  const curated = dedupe([...ownModelKeys(config), ...factKeys()]);
  const chosen = new Set(curated);
  const extra = dedupe(provided)
    .filter((key) => !chosen.has(key))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_CANDIDATES);
  return [...curated, ...extra];
}

/**
 * 有「搜尋…」的模型選單（迴圈：關鍵字縮小清單 → 從命中裡選 → 可再搜）。
 * `prefix` 是清單開頭的固定項（如「清除…」）。回 `undefined` = 取消、
 * `null` = 非規格回傳、字串 = 選到的項目（含 `CUSTOM_OPTION`，由呼叫端
 * 決定打字後續）。
 */
export async function pickModelFrom(
  hooks: WizardHooks,
  label: string,
  candidates: string[],
  prefix: readonly string[] = [],
): Promise<string | undefined | null> {
  let pool = candidates;
  for (;;) {
    const picked = await pickFrom(hooks, label, [...prefix, ...pool, SEARCH_OPTION, CUSTOM_OPTION]);
    if (picked === undefined || picked === null) return picked;
    if (picked !== SEARCH_OPTION) return picked;

    const keyword = await promptLoop(
      hooks,
      t`${label}：關鍵字（篩選 ${candidates.length} 筆）`,
      "",
      (text) => (text === "" ? t("關鍵字不能是空字串") : null),
    );
    if (keyword === undefined) return undefined;
    const hits = candidates.filter((key) => key.toLowerCase().includes(keyword.toLowerCase()));
    if (hits.length === 0) {
      notice(hooks, t`「${keyword}」沒有符合的模型——再搜一次（Esc 取消）`, "warning");
      pool = candidates;
      continue;
    }
    pool = hits;
  }
}

/**
 * 選一個模型：有候選 → 選單（「搜尋…」可縮小清單、末項 `CUSTOM_OPTION`
 * 可打字）；沒候選 → 退回打字輸入。
 *
 * 回 `undefined` = 取消，回 `null` = 非規格回傳，回字串 = 選定。
 */
export async function chooseModel(
  hooks: WizardHooks,
  config: CompassConfig,
  label: string,
  initial: string,
): Promise<string | undefined | null> {
  const candidates = await modelCandidates(config, hooks);
  const check = (text: string): string | null => (text === "" ? "模型 id 不能是空字串" : null);
  if (candidates.length === 0) {
    const typed = await promptLoop(hooks, t`${label}（provider/model）`, initial, check);
    return typed === undefined ? undefined : typed;
  }
  const picked = await pickModelFrom(hooks, label, candidates);
  if (picked === undefined || picked === null) return picked;
  if (picked !== CUSTOM_OPTION) return picked;
  const typed = await promptLoop(hooks, t`${label}（provider/model）`, initial, check);
  return typed === undefined ? undefined : typed;
}

// 各項編輯
// ---------------------------------------------------------------------------

/** 一項設定的編輯結果：要寫的 key/value + 寫入後如何反映到 config。 */
interface EditResult {
  /** 落檔的 patch（**只帶要改的鍵**；`null` 子鍵 = 刪除，Part 3.4）。 */
  key: string;
  value: unknown;
  applyTo(config: CompassConfig): Partial<CompassConfig>;
}

/** `classify` 區塊的編輯結果（patch 只帶被改的鍵；`applyTo` 套在活設定上）。 */
export function classifyEdit(value: Partial<CompassConfig["classify"]>): EditResult {
  return {
    key: "classify",
    value,
    applyTo: (live) => ({ classify: { ...live.classify, ...value } }),
  };
}

/** `display` 區塊的編輯結果（同上；OBJECT_MERGE_KEYS 逐子鍵合併）。 */
export function displayEdit(value: Partial<CompassConfig["display"]>): EditResult {
  return {
    key: "display",
    value,
    applyTo: (live) => ({ display: { ...live.display, ...value } }),
  };
}

/** 單鍵整值替換的編輯結果（布林或枚舉）。 */
export function simpleEdit(key: string, value: unknown, apply: Partial<CompassConfig>): EditResult {
  return { key, value, applyTo: () => apply };
}

/** 依項目提示使用者編輯；回 `undefined` 取消、`null` 已被 hooks 呈現拒絕。 */
export async function editItem(
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

    // ------------------------------------------------------------ ⑥ 顯示
    case "detail": {
      const labels = (DISPLAY_DETAILS as readonly DisplayDetail[]).map((d) => `${d} — ${DETAIL_HINT[d]()}`);
      const picked = await pickFrom(hooks, t`呈現密度（目前：${config.display.detail}）`, labels);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ detail: picked.split(" — ")[0] as DisplayDetail });
    }

    case "fields": {
      // toggle 迴圈：選一項切換顯示/隱藏；「← 完成」才一次性落檔（沒動就取消）。
      let fields = [...config.display.fields];
      for (;;) {
        const rows = DISPLAY_FIELDS.map((f) => `${fields.includes(f) ? "✓" : "✗"} ${f}`);
        const pickedRow = await pickFrom(hooks, "收合列欄位：選一項切換（✓ = 顯示）", [
          ...rows,
          "← 完成（套用）",
        ]);
        if (pickedRow === undefined || pickedRow === null) return pickedRow;
        if (pickedRow.startsWith("←")) break;
        const field = pickedRow.slice(2) as DisplayField;
        // 加回時依 DISPLAY_FIELDS 固定順序插入（wizard 不產生自訂順序）。
        fields = fields.includes(field)
          ? fields.filter((f) => f !== field)
          : DISPLAY_FIELDS.filter((f) => f === field || fields.includes(f));
      }
      if (fields.join("\u0000") === config.display.fields.join("\u0000")) return undefined;
      return displayEdit({ fields });
    }

    case "badge": {
      const picked = await pickFrom(hooks, "compass 徽章", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ badge: picked === "開" });
    }

    case "color": {
      const picked = await pickFrom(hooks, "配色", [
        "rich — 全彩（跟隨主題）",
        "mono — 單色（只留明暗，適合截圖／淺色主題）",
      ]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ color: (picked.startsWith("mono") ? "mono" : "rich") as DisplayColor });
    }

    case "hint": {
      const picked = await pickFrom(hooks, "expand 提示（收合行尾）", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ hint: picked === "開" });
    }

    case "rails": {
      const picked = await pickFrom(hooks, "樹狀導軌（├/└）", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ rails: picked === "開" });
    }

    case "uiLang": {
      const picked = await pickFrom(hooks, "界面語言", ["中文", "English"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ language: picked === "English" ? "en" : "zh" });
    }

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
    }
  }
}

/** 鏈編輯的 applyTo 共用：把新鏈放到 routes 或 kindModels。 */
export function applyChainFor(
  live: CompassConfig,
  isKind: boolean,
  name: string,
  chain: Target[],
): Partial<CompassConfig> {
  return isKind
    ? { kindModels: { ...live.kindModels, [name]: chain } }
    : { routes: { ...live.routes, [name as Tier]: chain } };
}
