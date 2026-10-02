// config/load.ts — 三層設定解析、warnings、env 驗證（SPEC Part 3.2 / 3.4）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { COMPASS_ENV_MAP, parseEnvOverrides, type EnvPatch } from "./env.js";
import { MODEL_FACTS, factsValid, rankedFacts, sliceBands } from "../policy/facts.js";
import { ceilingFor, filterChain, insertPrefer } from "../policy/filter.js";
import {
  DEFAULT_CONFIG,
  PROFILE_CEILINGS,
  TIERS,
  TIER_CAPABILITY_FLOOR,
  TIER_THINKING,
  type CompassConfig,
  type Target,
  type TaskKindSpec,
  type ThinkingLevel,
} from "../schema.js";

/**
 * 唯一的設定檔路徑（Part 3.2：無專案級設定，複製 repo 不得注入路由設定）。
 * 固定為 `~/.pi/agent/pi-compass/config.json`，不可配置。
 */
export const CONFIG_FILE = join(homedir(), ".pi", "agent", "pi-compass", "config.json");

/** 設定載入結果：解析後的設定與驗證警告。 */
export interface LoadResult {
  config: CompassConfig;
  warnings: string[];
}

const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const MODES = ["auto", "confirm", "notify"] as const;
const PROFILES = ["cheap", "balanced", "quality"] as const;
const MODEL_PICKS = ["off", "menu"] as const;
const PROVIDERS = ["laya", "cloud"] as const;

/** config.json 與 `compass_config` 工具允許出現的頂層鍵（Part 3.4 白名單）。 */
const TOP_LEVEL_KEYS: readonly string[] = [
  "enabled",
  "mode",
  "useDefaultModels",
  "classify",
  "routes",
  "kindModels",
  "kindMinimumTier",
  "taskKinds",
  "xpremium",
  "freePool",
  "specialistPriority",
  "suggest",
  "budget",
  "profile",
  "ceilings",
  "deny",
  "allowProviders",
  "prefer",
  "autoRoutes",
  "modelPick",
  "allowUnratedPicks",
  "freeOnly",
  "stickiness",
  "cache",
  "thinking",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);

const inSet = (value: unknown, values: readonly string[]): value is string =>
  typeof value === "string" && values.includes(value);

// ---------------------------------------------------------------------------
// 合併
// ---------------------------------------------------------------------------

function readJsonFile(path: string): { patch?: Record<string, unknown>; warning?: string } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {}; // 不存在 = 沒有這一層，不是錯誤。
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { warning: `${path}: config must be a JSON object — file ignored` };
    return { patch: parsed };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { warning: `${path}: invalid JSON (${reason.slice(0, 120)}) — file ignored` };
  }
}

function mergeTarget(base: Target[], incoming: unknown, where: string, warnings: string[]): Target[] {
  if (!Array.isArray(incoming)) {
    warnings.push(`${where}: expected an array of {provider, model} — ignored`);
    return base;
  }
  const out: Target[] = [];
  for (const item of incoming) {
    if (!isRecord(item) || typeof item.provider !== "string" || typeof item.model !== "string") {
      warnings.push(`${where}: entry missing provider/model strings — entry dropped`);
      continue;
    }
    const target: Target = { provider: item.provider, model: item.model, explicit: true } as Target;
    if (typeof item.thinkingLevel === "string" && THINKING_LEVELS.includes(item.thinkingLevel)) {
      target.thinkingLevel = item.thinkingLevel as ThinkingLevel;
    } else if (item.thinkingLevel !== undefined) {
      warnings.push(`${where}: thinkingLevel must be one of ${THINKING_LEVELS.join("|")} — ignored`);
    }
    if (typeof item.minTier === "string" && (TIERS as readonly string[]).includes(item.minTier)) {
      target.minTier = item.minTier as Target["minTier"];
    } else if (item.minTier !== undefined) {
      warnings.push(`${where}: minTier must be one of ${TIERS.join("|")} — ignored`);
    }
    if (isFiniteNumber(item.priority)) target.priority = item.priority;
    out.push(target);
  }
  return out.length > 0 ? out : base;
}

/**
 * 把 config.json 的 patch 合到基準設定上。
 *
 * 三條規則（Part 3.4）：
 * 1. **白名單** — 未宣告的頂層鍵被丟棄並具名警告，不會靜默存活
 * 2. **Patch 非覆寫** — 只改被指定的鍵；預設值與衍生鏈不寫回
 * 3. **寫前驗證** — 型別不符就留在前一層的值，並具名警告
 */
function applyFilePatch(
  base: CompassConfig,
  patch: Record<string, unknown>,
  warnings: string[],
): CompassConfig {
  const next: CompassConfig = {
    ...base,
    classify: { ...base.classify },
    routes: Object.fromEntries(
      Object.entries(base.routes).map(([tier, chain]) => [tier, [...chain]]),
    ) as CompassConfig["routes"],
    kindModels: Object.fromEntries(
      Object.entries(base.kindModels).map(([kind, chain]) => [kind, [...chain]]),
    ),
    kindMinimumTier: { ...base.kindMinimumTier },
    taskKinds: Object.fromEntries(
      Object.entries(base.taskKinds).map(([kind, spec]) => [kind, { ...spec }]),
    ),
    xpremium: { ...base.xpremium },
    freePool: { ...base.freePool, models: [...base.freePool.models] },
    specialistPriority: Object.fromEntries(
      Object.entries(base.specialistPriority).map(([kind, list]) => [kind, [...list]]),
    ),
    suggest: { ...base.suggest },
    budget: { ...base.budget },
    ceilings: { ...base.ceilings },
    deny: [...base.deny],
    allowProviders: [...base.allowProviders],
    prefer: Object.fromEntries(
      Object.entries(base.prefer).map(([tier, list]) => [tier, [...list]]),
    ),
    cache: { ...base.cache },
    thinking: { ...base.thinking },
  };

  for (const [key, value] of Object.entries(patch)) {
    if (!TOP_LEVEL_KEYS.includes(key)) {
      warnings.push(`config.json: unknown key "${key}" dropped (not in the whitelist)`);
      continue;
    }
    switch (key) {
      case "enabled":
      case "useDefaultModels":
      case "autoRoutes":
      case "allowUnratedPicks":
      case "freeOnly":
      case "stickiness":
        if (typeof value === "boolean") Object.assign(next, { [key]: value });
        else warnings.push(`config.json: ${key} must be a boolean — ignored`);
        break;
      case "mode":
        if (inSet(value, MODES)) next.mode = value as CompassConfig["mode"];
        else warnings.push(`config.json: mode must be one of ${MODES.join("|")} — ignored`);
        break;
      case "modelPick":
        if (inSet(value, MODEL_PICKS)) next.modelPick = value as CompassConfig["modelPick"];
        else warnings.push(`config.json: modelPick must be one of ${MODEL_PICKS.join("|")} — ignored`);
        break;
      case "profile":
        if (inSet(value, PROFILES)) next.profile = value as CompassConfig["profile"];
        else warnings.push(`config.json: profile must be one of ${PROFILES.join("|")} — ignored`);
        break;
      case "classify": {
        if (!isRecord(value)) {
          warnings.push("config.json: classify must be an object — ignored");
          break;
        }
        for (const [ck, cv] of Object.entries(value)) {
          if (ck === "provider") {
            if (inSet(cv, PROVIDERS)) next.classify.provider = cv as CompassConfig["classify"]["provider"];
            else warnings.push(`config.json: classify.provider must be ${PROVIDERS.join("|")} — ignored`);
          } else if (ck === "model" || ck === "python") {
            if (typeof cv === "string" && cv.trim()) next.classify[ck] = cv.trim();
            else warnings.push(`config.json: classify.${ck} must be a non-empty string — ignored`);
          } else if (ck === "cloud") {
            if (isRecord(cv) && typeof cv.provider === "string" && typeof cv.model === "string") {
              next.classify.cloud = { provider: cv.provider, model: cv.model };
            } else warnings.push("config.json: classify.cloud needs provider+model strings — ignored");
          } else if (ck === "timeoutMs" || ck === "minPromptChars" || ck === "historyTurns" || ck === "cacheTtlSeconds") {
            if (isFiniteNumber(cv) && cv >= 0 && Number.isInteger(cv)) {
              if (ck === "timeoutMs") next.classify.timeoutMs = cv;
              else if (ck === "minPromptChars") next.classify.minPromptChars = cv;
              else if (ck === "historyTurns") next.classify.historyTurns = cv;
              else next.classify.cacheTtlSeconds = cv;
            } else warnings.push(`config.json: classify.${ck} must be an integer >= 0 — ignored`);
          } else if (ck === "cache") {
            if (typeof cv === "boolean") next.classify.cache = cv;
            else warnings.push("config.json: classify.cache must be a boolean — ignored");
          } else if (ck === "confidenceThreshold") {
            if (isFiniteNumber(cv) && cv >= 0 && cv <= 1) next.classify.confidenceThreshold = cv;
            else warnings.push("config.json: classify.confidenceThreshold must be within 0-1 — ignored");
          } else {
            warnings.push(`config.json: unknown key "classify.${ck}" dropped`);
          }
        }
        break;
      }
      case "routes": {
        if (!isRecord(value)) {
          warnings.push("config.json: routes must be an object — ignored");
          break;
        }
        for (const [tier, chain] of Object.entries(value)) {
          if (!(TIERS as readonly string[]).includes(tier)) {
            warnings.push(`config.json: routes.${tier} is not a known tier — ignored`);
            continue;
          }
          next.routes[tier as Target["minTier"] as keyof CompassConfig["routes"]] = mergeTarget(
            next.routes[tier as keyof CompassConfig["routes"]],
            chain,
            `config.json: routes.${tier}`,
            warnings,
          );
        }
        break;
      }
      case "kindModels": {
        if (!isRecord(value)) {
          warnings.push("config.json: kindModels must be an object — ignored");
          break;
        }
        for (const [kind, chain] of Object.entries(value)) {
          next.kindModels[kind] = mergeTarget(next.kindModels[kind] ?? [], chain, `config.json: kindModels.${kind}`, warnings);
        }
        break;
      }
      case "kindMinimumTier": {
        if (!isRecord(value)) {
          warnings.push("config.json: kindMinimumTier must be an object — ignored");
          break;
        }
        for (const [kind, tier] of Object.entries(value)) {
          if (inSet(tier, TIERS)) next.kindMinimumTier[kind] = tier as CompassConfig["kindMinimumTier"][string];
          else warnings.push(`config.json: kindMinimumTier.${kind} must be one of ${TIERS.join("|")} — ignored`);
        }
        break;
      }
      case "taskKinds": {
        if (!isRecord(value)) {
          warnings.push("config.json: taskKinds must be an object — ignored");
          break;
        }
        for (const [kind, spec] of Object.entries(value)) {
          if (!isRecord(spec) || typeof spec.label !== "string" || !isFiniteNumber(spec.floor)) {
            warnings.push(`config.json: taskKinds.${kind} needs {label: string, floor: number} — ignored`);
            continue;
          }
          const out: TaskKindSpec = { label: spec.label, floor: spec.floor };
          if (isFiniteNumber(spec.priority)) out.priority = spec.priority;
          next.taskKinds[kind] = out;
        }
        break;
      }
      case "xpremium":
        if (isRecord(value) && typeof value.enabled === "boolean") next.xpremium.enabled = value.enabled;
        else warnings.push("config.json: xpremium needs {enabled: boolean} — ignored");
        break;
      case "freePool":
        if (!isRecord(value)) {
          warnings.push("config.json: freePool must be an object — ignored");
          break;
        }
        if (typeof value.enabled === "boolean") next.freePool.enabled = value.enabled;
        if (value.models !== undefined) {
          next.freePool.models = mergeTarget(next.freePool.models, value.models, "config.json: freePool.models", warnings);
        }
        break;
      case "specialistPriority":
        if (!isRecord(value)) {
          warnings.push("config.json: specialistPriority must be an object — ignored");
          break;
        }
        for (const [kind, list] of Object.entries(value)) {
          if (isStringArray(list)) next.specialistPriority[kind] = [...list];
          else warnings.push(`config.json: specialistPriority.${kind} must be an array of strings — ignored`);
        }
        break;
      case "suggest":
        if (isRecord(value) && typeof value.scoresFile === "string") next.suggest.scoresFile = value.scoresFile;
        else warnings.push("config.json: suggest needs {scoresFile: string} — ignored");
        break;
      case "budget": {
        if (!isRecord(value)) {
          warnings.push("config.json: budget must be an object — ignored");
          break;
        }
        for (const [bk, bv] of Object.entries(value)) {
          if (bk === "dailyUsd" || bk === "monthlyUsd") {
            if (bv === null) next.budget[bk] = null;
            else if (isFiniteNumber(bv) && bv >= 0) next.budget[bk] = bv;
            else warnings.push(`config.json: budget.${bk} must be a number >= 0 or null to clear — ignored`);
          } else if (bk === "softRatio" || bk === "hardRatio") {
            if (isFiniteNumber(bv) && bv >= 0 && bv <= 1) next.budget[bk] = bv;
            else warnings.push(`config.json: budget.${bk} must be within 0-1 — ignored`);
          } else {
            warnings.push(`config.json: unknown key "budget.${bk}" dropped`);
          }
        }
        break;
      }
      case "ceilings":
        if (!isRecord(value)) {
          warnings.push("config.json: ceilings must be an object — ignored");
          break;
        }
        for (const [tier, ceiling] of Object.entries(value)) {
          if (!(TIERS as readonly string[]).includes(tier)) {
            warnings.push(`config.json: ceilings.${tier} is not a known tier — ignored`);
          } else if (ceiling === null || (isFiniteNumber(ceiling) && ceiling >= 0)) {
            next.ceilings[tier as keyof CompassConfig["ceilings"]] = ceiling as number | null;
          } else warnings.push(`config.json: ceilings.${tier} must be a number >= 0 or null — ignored`);
        }
        break;
      case "deny":
      case "allowProviders":
        if (isStringArray(value)) next[key] = [...value];
        else warnings.push(`config.json: ${key} must be an array of non-empty strings — ignored`);
        break;
      case "prefer":
        if (!isRecord(value)) {
          warnings.push("config.json: prefer must be an object — ignored");
          break;
        }
        for (const [tier, list] of Object.entries(value)) {
          if (!(TIERS as readonly string[]).includes(tier)) {
            warnings.push(`config.json: prefer.${tier} is not a known tier — ignored`);
          } else if (isStringArray(list) && list.length > 0) {
            next.prefer[tier as keyof CompassConfig["prefer"]] = [...list];
          } else warnings.push(`config.json: prefer.${tier} must be a non-empty string array — ignored`);
        }
        break;
      case "cache": {
        if (!isRecord(value)) {
          warnings.push("config.json: cache must be an object — ignored");
          break;
        }
        for (const [ck, cv] of Object.entries(value)) {
          if (ck === "aware") {
            if (typeof cv === "boolean") next.cache.aware = cv;
            else warnings.push("config.json: cache.aware must be a boolean — ignored");
          } else if (ck === "deadband" || ck === "maxPenaltyUsd" || ck === "cooldownSeconds") {
            if (isFiniteNumber(cv) && cv >= 0) {
              if (ck === "deadband") next.cache.deadband = cv;
              else if (ck === "maxPenaltyUsd") next.cache.maxPenaltyUsd = cv;
              else next.cache.cooldownSeconds = cv;
            } else warnings.push(`config.json: cache.${ck} must be a number >= 0 — ignored`);
          } else if (ck === "bypassTierDelta") {
            if (isFiniteNumber(cv) && cv >= 0 && Number.isInteger(cv)) next.cache.bypassTierDelta = cv;
            else warnings.push("config.json: cache.bypassTierDelta must be an integer >= 0 — ignored");
          } else {
            warnings.push(`config.json: unknown key "cache.${ck}" dropped`);
          }
        }
        break;
      }
      case "thinking":
        if (!isRecord(value)) {
          warnings.push("config.json: thinking must be an object — ignored");
          break;
        }
        for (const [tk, tv] of Object.entries(value)) {
          if (inSet(tv, THINKING_LEVELS)) next.thinking[tk] = tv as ThinkingLevel;
          else warnings.push(`config.json: thinking.${tk} must be one of ${THINKING_LEVELS.join("|")} — ignored`);
        }
        break;
      default:
        break;
    }
  }
  return next;
}

/** 應用環境層（Part 3.3）。`null` 的預算值 = 清除該維度上限。 */
function applyEnvPatch(base: CompassConfig, patch: EnvPatch): CompassConfig {
  const next: CompassConfig = {
    ...base,
    classify: { ...base.classify },
    budget: { ...base.budget },
    cache: { ...base.cache },
    xpremium: { ...base.xpremium },
    freePool: { ...base.freePool },
    kindMinimumTier: { ...base.kindMinimumTier },
  };
  for (const key of [
    "enabled",
    "mode",
    "useDefaultModels",
    "stickiness",
    "autoRoutes",
    "modelPick",
    "allowUnratedPicks",
    "freeOnly",
    "profile",
  ] as const) {
    const value = patch[key];
    if (value !== undefined) Object.assign(next, { [key]: value });
  }
  if (patch.classify) Object.assign(next.classify, patch.classify);
  if (patch.budget) Object.assign(next.budget, patch.budget);
  if (patch.cache) Object.assign(next.cache, patch.cache);
  if (patch.xpremium?.enabled !== undefined) next.xpremium.enabled = patch.xpremium.enabled;
  if (patch.freePool?.enabled !== undefined) next.freePool.enabled = patch.freePool.enabled;
  if (patch.kindMinimumTier) Object.assign(next.kindMinimumTier, patch.kindMinimumTier);
  return next;
}

/** `useDefaultModels: false` 的基準：空鏈 + 空專家（Part 3.1）。 */
function emptyChains(): CompassConfig {
  return {
    ...DEFAULT_CONFIG,
    routes: { quick: [], standard: [], high: [], premium: [], xpremium: [] },
    kindModels: {},
  };
}

/**
 * L1 + L2 組合，在 `resolveConfig()` 最後執行（Part 9，優先序由低到高）：
 *
 *   1. 事實切帶 — 只填**使用者沒寫過**的層級（`explicit` 條目 = 使用者
 *      擁有該層，L3 勝出）；事實檔不可用 → 跳過，保留內建鏈（fail-open）
 *   2. 政策過濾 — `deny` / `allowProviders` 只作用於非顯式條目
 *   3. `prefer` 插入鏈首 — 顯式，永不被過濾
 *
 * 專家鏈與層級鏈都要過濾；`useDefaultModels: false` 時不推導（只用
 * 使用者自帶的模型），但政策與 prefer 仍然適用。
 */
function applyModelPolicy(config: CompassConfig): CompassConfig {
  // 事實推導只在 `useDefaultModels` 為真時發生（Part 3.1：false = 連內建鏈
  // 都不存在，不能被事實檔案填回）。
  const factsUsable = config.useDefaultModels && config.autoRoutes && factsValid(MODEL_FACTS);
  const bands = factsUsable ? sliceBands(rankedFacts(MODEL_FACTS), TIERS.map((tier) => ceilingFor(config, tier))) : undefined;

  if (bands) {
    TIERS.forEach((tier, index) => {
      const own = config.routes[tier];
      if (own.some((target) => target.explicit)) return; // 使用者擁有此層（L3）
      const derived = bands[index].map((fact) => ({ provider: fact.provider, model: fact.model }));
      if (derived.length > 0) config.routes[tier] = derived;
    });
  }

  // L2 政策（只碰非顯式）。
  for (const tier of TIERS) config.routes[tier] = filterChain(config.routes[tier], config);
  for (const kind of Object.keys(config.kindModels)) {
    config.kindModels[kind] = filterChain(config.kindModels[kind], config);
  }

  // L3 `prefer` 最後插入鏈首。
  for (const tier of TIERS) config.routes[tier] = insertPrefer(config.routes[tier], tier, config);
  return config;
}

/**
 * 合併後的自洽性檢查（Part 3.3：只報告，不改值）。 */
function invariantWarnings(config: CompassConfig): string[] {
  const warnings: string[] = [];
  const bounded = (label: string, value: number): void => {
    if (!(value >= 0 && value <= 1)) warnings.push(`${label} (${value}) should be within 0-1`);
  };
  const nonNegative = (label: string, value: number): void => {
    if (!(value >= 0)) warnings.push(`${label} (${value}) should be >= 0`);
  };
  bounded("classify.confidenceThreshold", config.classify.confidenceThreshold);
  bounded("budget.softRatio", config.budget.softRatio);
  bounded("budget.hardRatio", config.budget.hardRatio);
  if (config.budget.softRatio > config.budget.hardRatio) {
    warnings.push(
      `budget.softRatio (${config.budget.softRatio}) exceeds budget.hardRatio (${config.budget.hardRatio}) — downgrade and force thresholds fire in the wrong order`,
    );
  }
  nonNegative("classify.timeoutMs", config.classify.timeoutMs);
  nonNegative("classify.minPromptChars", config.classify.minPromptChars);
  nonNegative("classify.historyTurns", config.classify.historyTurns);
  nonNegative("budget.dailyUsd", config.budget.dailyUsd ?? 0);
  nonNegative("budget.monthlyUsd", config.budget.monthlyUsd ?? 0);
  nonNegative("cache.deadband", config.cache.deadband);
  nonNegative("cache.maxPenaltyUsd", config.cache.maxPenaltyUsd);
  nonNegative("cache.bypassTierDelta", config.cache.bypassTierDelta);
  nonNegative("cache.cooldownSeconds", config.cache.cooldownSeconds);
  return warnings;
}

/**
 * 讀取設定：內建預設 → `~/.pi/agent/pi-compass/config.json` →
 * `COMPASS_*` 環境變數，後者勝。無專案級設定檔（Part 3.2）。
 *
 * `options.filePath` 覆寫設定檔路徑——**僅供測試**使用；生產環境與預設
 * 一律是 `CONFIG_FILE`，沒有任何設定鍵能改它（Part 3.2：無專案級設定）。
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  options: { filePath?: string } = {},
): LoadResult {
  const warnings: string[] = [];
  const file = readJsonFile(options.filePath ?? CONFIG_FILE);
  if (file.warning) warnings.push(file.warning);

  const envResult = parseEnvOverrides(env);
  warnings.push(...envResult.warnings);

  // `useDefaultModels: false` 選擇的是**基準鏈**，故必須在合併前判定：
  // env 先看、再看檔案、最後預設（Part 3.1）。基準一旦確定，檔案裡使用者
  // 自己寫的 routes/kindModels 仍照常合入——「不要內建」不等於「不要我写的」。
  const patch = file.patch ?? {};
  const patchUseDefault = typeof patch.useDefaultModels === "boolean" ? patch.useDefaultModels : undefined;
  const useDefaults = envResult.overrides.useDefaultModels ?? patchUseDefault ?? DEFAULT_CONFIG.useDefaultModels;
  const base = useDefaults ? DEFAULT_CONFIG : emptyChains();

  let config: CompassConfig = applyFilePatch(base, patch, warnings);
  config = applyEnvPatch(config, envResult.overrides);

  // L1+L2 組合最後跑，使 env 選的 profile 也能塑造價格帶（Part 9）。
  config = applyModelPolicy(config);

  warnings.push(...invariantWarnings(config));
  return { config, warnings };
}

// ---------------------------------------------------------------------------
// 寫入驗證（Part 3.4 / `compass_config` 工具白名單）
// ---------------------------------------------------------------------------

type Check = (value: unknown) => string | null;
const bad = (reason: string): string => reason;
const ok = (): null => null;

const bool: Check = (v) => (typeof v === "boolean" ? ok() : bad("expected true or false"));
const nonEmptyString: Check = (v) =>
  typeof v === "string" && v.trim().length > 0 ? ok() : bad("expected a non-empty string");
const stringArray: Check = (v) =>
  isStringArray(v) ? ok() : bad("expected an array of non-empty strings");
const nonEmptyStringArray: Check = (v) =>
  isStringArray(v) && v.length > 0 ? ok() : bad("expected a non-empty array of strings");

function enumCheck(values: readonly string[]): Check {
  return (v) => (inSet(v, values) ? ok() : bad(`expected one of ${values.join("|")}`));
}

function chainCheck(v: unknown): string | null {
  if (!Array.isArray(v) || v.length === 0) return bad("expected a non-empty array of {provider, model}");
  for (const item of v) {
    if (!isRecord(item) || typeof item.provider !== "string" || typeof item.model !== "string") {
      return bad("each entry needs provider and model strings");
    }
    if (item.thinkingLevel !== undefined && !inSet(item.thinkingLevel, THINKING_LEVELS)) {
      return bad(`thinkingLevel: expected ${THINKING_LEVELS.join("|")}`);
    }
    if (item.minTier !== undefined && !inSet(item.minTier, TIERS)) {
      return bad(`minTier: expected ${TIERS.join("|")}`);
    }
    if (item.priority !== undefined && !isFiniteNumber(item.priority)) return bad("priority: expected a number");
  }
  return ok();
}

function recordOf(itemCheck: Check, label: string): Check {
  return (v) => {
    if (!isRecord(v)) return bad(`expected an object of ${label}`);
    const keys = Object.keys(v);
    if (keys.length === 0) return bad(`expected an object of ${label}`);
    for (const [key, entry] of Object.entries(v)) {
      const problem = itemCheck(entry);
      if (problem) return bad(`${key}: ${problem}`);
    }
    return ok();
  };
}

/**
 * 子項可為 `null`：**patch 層的 `null` = 刪掉該子鍵**（回預設／回自動
 * 派生，2026-10-02 解單向門）。檔案層的 `null` 仍有各自的值意涵（如
 * `ceilings.<tier>: null` = 無上限、`budget.dailyUsd: null` = 無上限），
 * 兩層不衝突：寫入器從不把刪除標記寫進檔案（直接移除該子鍵）。
 */
function nullableItem(check: Check): Check {
  return (v) => (v === null ? ok() : check(v));
}

const budgetCheck: Check = (v) => {
  if (!isRecord(v)) return bad("expected an object");
  const allowed = new Set(["dailyUsd", "monthlyUsd", "softRatio", "hardRatio"]);
  for (const [key, value] of Object.entries(v)) {
    if (!allowed.has(key)) return bad(`budget.${key}: unknown setting`);
    if (key === "dailyUsd" || key === "monthlyUsd") {
      if (value === null) continue;
      if (!isFiniteNumber(value) || value <= 0) return bad(`budget.${key}: expected a number > 0, or null to clear the cap`);
    } else if (!isFiniteNumber(value) || value < 0 || value > 1) {
      return bad(`budget.${key}: expected a number within 0-1`);
    }
  }
  return Object.keys(v).length > 0 ? ok() : bad("expected at least one of dailyUsd, monthlyUsd, softRatio, hardRatio");
};

const cacheCheck: Check = (v) => {
  if (!isRecord(v)) return bad("expected an object");
  const fields: Record<string, Check> = {
    aware: bool,
    deadband: (x) => (isFiniteNumber(x) && x >= 0 ? ok() : bad("expected a number >= 0")),
    maxPenaltyUsd: (x) => (isFiniteNumber(x) && x >= 0 ? ok() : bad("expected a number >= 0")),
    bypassTierDelta: (x) =>
      isFiniteNumber(x) && x >= 0 && Number.isInteger(x) ? ok() : bad("expected an integer >= 0"),
    cooldownSeconds: (x) => (isFiniteNumber(x) && x >= 0 ? ok() : bad("expected a number >= 0")),
  };
  for (const [key, value] of Object.entries(v)) {
    const check = fields[key];
    if (!check) return bad(`cache.${key}: unknown setting`);
    const problem = check(value);
    if (problem) return bad(`cache.${key}: ${problem}`);
  }
  return Object.keys(v).length > 0 ? ok() : bad(`expected at least one of ${Object.keys(fields).join(", ")}`);
};

const classifyCheck: Check = (v) => {
  if (!isRecord(v)) return bad("expected an object");
  const fields: Record<string, Check> = {
    provider: enumCheck(PROVIDERS),
    model: nonEmptyString,
    python: nonEmptyString,
    timeoutMs: (x) => (isFiniteNumber(x) && x >= 0 && Number.isInteger(x) ? ok() : bad("expected an integer >= 0")),
    minPromptChars: (x) => (isFiniteNumber(x) && x >= 0 && Number.isInteger(x) ? ok() : bad("expected an integer >= 0")),
    historyTurns: (x) => (isFiniteNumber(x) && x >= 0 && Number.isInteger(x) ? ok() : bad("expected an integer >= 0")),
    cache: bool,
    cacheTtlSeconds: (x) => (isFiniteNumber(x) && x >= 0 && Number.isInteger(x) ? ok() : bad("expected an integer >= 0")),
    confidenceThreshold: (x) => (isFiniteNumber(x) && x >= 0 && x <= 1 ? ok() : bad("expected a number within 0-1")),
    cloud: (x) =>
      isRecord(x) && typeof x.provider === "string" && typeof x.model === "string"
        ? ok()
        : bad("expected {provider, model} strings"),
  };
  for (const [key, value] of Object.entries(v)) {
    const check = fields[key];
    if (!check) return bad(`classify.${key}: unknown setting`);
    const problem = check(value);
    if (problem) return bad(`classify.${key}: ${problem}`);
  }
  return Object.keys(v).length > 0 ? ok() : bad("expected at least one classify setting");
};

const PATCH_CHECKS: Record<string, Check> = {
  enabled: bool,
  useDefaultModels: bool,
  autoRoutes: bool,
  allowUnratedPicks: bool,
  freeOnly: bool,
  stickiness: bool,
  mode: enumCheck(MODES),
  modelPick: enumCheck(MODEL_PICKS),
  profile: enumCheck(PROFILES),
  classify: classifyCheck,
  routes: recordOf(nullableItem(chainCheck), `per-tier model chains (${TIERS.join("|")})`),
  kindModels: recordOf(nullableItem(chainCheck), "task-kind model chains"),
  kindMinimumTier: recordOf(nullableItem(enumCheck(TIERS)), "task-kind -> tier"),
  taskKinds: recordOf(
    (v) =>
      isRecord(v) && typeof v.label === "string" && isFiniteNumber(v.floor)
        ? ok()
        : bad("expected {label: string, floor: number}"),
    "task-kind specs",
  ),
  xpremium: (v) =>
    isRecord(v) && typeof v.enabled === "boolean" ? ok() : bad("expected {enabled: boolean}"),
  freePool: (v) => {
    if (!isRecord(v)) return bad("expected an object");
    if (v.enabled !== undefined && typeof v.enabled !== "boolean") return bad("freePool.enabled: expected true or false");
    if (v.models !== undefined) {
      const problem = chainCheck(v.models);
      if (problem) return bad(`freePool.models: ${problem}`);
    }
    return Object.keys(v).length > 0 ? ok() : bad("expected enabled and/or models");
  },
  suggest: (v) => (isRecord(v) && typeof v.scoresFile === "string" ? ok() : bad("expected {scoresFile: string}")),
  budget: budgetCheck,
  ceilings: recordOf(
    (v) => (v === null || (isFiniteNumber(v) && v >= 0) ? ok() : bad("expected a number >= 0 or null")),
    "per-tier ceilings",
  ),
  deny: stringArray,
  allowProviders: stringArray,
  prefer: recordOf(nullableItem(nonEmptyStringArray), "per-tier preferred models"),
  cache: cacheCheck,
  thinking: recordOf(nullableItem(enumCheck(THINKING_LEVELS)), "thinking pin"),
  specialistPriority: recordOf(nullableItem(nonEmptyStringArray), "task-kind -> model id list"),
};

/**
 * 寫入前驗證單一鍵值（Part 3.4）：白名單 + 型別/範圍檢查。
 * 回傳 `key: reason` 表示拒絕；通過則回傳 null。
 */
export function validatePatch(key: string, value: unknown): string | null {
  const check = PATCH_CHECKS[key];
  if (!check) return `${key}: unknown setting (not in the whitelist)`;
  const problem = check(value);
  return problem ? `${key}: ${problem}` : null;
}

/**
 * 驗證並把 patch 結構化合入 config.json（Part 3.4 三條規則的落檔實作）。
 *
 * - **白名單 + 寫前驗證**：逐鍵跑 `validatePatch`，任一不過 → 回第一個
 *   `key: reason`、**一個字都不寫**（原子：不能半寫）。
 * - **Patch 非覆寫**：只動 patch 提到的鍵；**預設值與衍生鏈永不物化進
 *   使用者檔案**——舊版會把整個預設設定寫進檔，使所有鏈都變成
 *   `explicit`：L1 事實自動推導整組停擺、`deny` 對它們失效
 *   （显式勝政策）。2026-10-02 修。
 * - **`null` = 刪除（單向門解藥）**：patch 裡 `routes.<tier>`／
 *   `kindModels.<kind>`／`kindMinimumTier.<kind>`／`prefer.<tier>`／
 *   `ceilings.<tier>`／`thinking.<kind>`／`specialistPriority.<kind>` 給
 *   `null` → **從檔案移除該子鍵**（回預設／回自動派生），寫進去就能清。
 *   例外：`budget.dailyUsd`／`budget.monthlyUsd` 的 `null` 是值（無上限）。
 *   刪除標記從不落檔——寫入時直接移除，檔案層的 `null` 仍維持舊值意涵。
 * - **時間戳備份**：落檔前把現有檔複製為 `<name>.bak-<ISO 去冒號>`（同目錄）；
 *   備份失敗**不阻擋寫入**（備份是安全網不是鎖）。
 *
 * 回 `null` 表成功。
 *
 * @param filePath **僅供測試**注入路徑；預設與生產一律 `CONFIG_FILE`。
 */
export function writeConfigPatch(
  patch: Record<string, unknown>,
  filePath: string = CONFIG_FILE,
): string | null {
  // 1. 全部驗證通過才動檔（原子）。
  for (const [key, value] of Object.entries(patch)) {
    const problem = validatePatch(key, value);
    if (problem) return problem;
  }

  // 2. 在**檔案物件**上結構化合併（不是合入預設值）。
  const current = readJsonFile(filePath).patch ?? {};
  const next = structuredClone(current) as Record<string, unknown>;
  applyPatchToFile(next, patch);

  // 3. 時間戳備份（同目錄；失敗不阻擋）。
  if (existsSync(filePath)) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      copyFileSync(filePath, `${filePath}.bak-${stamp}`);
    } catch {
      // 備份失敗不阻擋寫入（安全網不是鎖）。
    }
  }

  // 4. 寫回（只有現檔 ∪ patch 的鍵；預設值不物化）。
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    return `${basename(filePath)}: write failed (${(error instanceof Error ? error.message : String(error)).slice(0, 120)})`;
  }
  return null;
}

/** 子鍵逐項合併的頂層鍵（物件值；其餘鍵整值替換）。 */
const OBJECT_MERGE_KEYS: ReadonlySet<string> = new Set([
  "classify",
  "routes",
  "kindModels",
  "kindMinimumTier",
  "taskKinds",
  "budget",
  "cache",
  "ceilings",
  "prefer",
  "thinking",
  "specialistPriority",
  "freePool",
  "xpremium",
]);

/** `null` 本身是「值」的子鍵（null = 無上限，不是刪除標記）。 */
const NULL_IS_VALUE_SUBKEYS: ReadonlySet<string> = new Set([
  "budget.dailyUsd",
  "budget.monthlyUsd",
]);

/**
 * 把 patch 結構化合入**檔案物件**（Patch 非覆寫）：逐子鍵合併，子鍵值
 * `null` = 刪除該子鍵（除非該子鍵的 `null` 是值）；沒提到的鍵/子鍵原樣
 * 保留；合併後變空的物件直接移除。
 */
function applyPatchToFile(file: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (OBJECT_MERGE_KEYS.has(key) && isRecord(value)) {
      const target = isRecord(file[key]) ? (file[key] as Record<string, unknown>) : (file[key] = {});
      for (const [sub, subValue] of Object.entries(value)) {
        if (subValue === null && !NULL_IS_VALUE_SUBKEYS.has(`${key}.${sub}`)) delete target[sub];
        else target[sub] = subValue;
      }
      if (Object.keys(target).length === 0) delete file[key];
    } else {
      file[key] = value;
    }
  }
}

/** 供文件與工具提示列出可寫鍵（Part 3.4）。 */
export const WRITABLE_KEYS: readonly string[] = Object.keys(PATCH_CHECKS);

/** 內建價格帶／能力下限／思考預設，供 Stage 2–3 與狀態列共用。 */
export const POLICY_TABLES = { PROFILE_CEILINGS, TIER_CAPABILITY_FLOOR, TIER_THINKING } as const;

/** 環境變數表，供 `/compass` 狀態列顯示來源（Part 3.3）。 */
export const ENV_KEYS: readonly string[] = Object.keys(COMPASS_ENV_MAP);