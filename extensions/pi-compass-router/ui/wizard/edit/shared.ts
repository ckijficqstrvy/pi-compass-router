// ui/wizard/edit/shared.ts — 編輯流程的共用工具（掛點包裝、選單/打字迴圈、
// 模型候選、EditResult 建構子、鏈的 applyTo）。各組編輯器（./routing.ts 等）共用。
import { t, rawOf } from "../i18n.js";
import { DEFAULT_CONFIG } from "../../../schema.js";
import type { CompassConfig, Target, Tier } from "../../../schema.js";
import type { WizardHooks } from "../types.js";
import type { MenuItem } from "../items.js";
import {
  CLEAR_OPTION,
  CUSTOM_OPTION,
  MAX_CANDIDATES,
  SEARCH_OPTION,
  dedupe,
  factKeys,
  keyOf,
  splitTarget,
} from "../labels.js";

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
export interface EditResult {
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

