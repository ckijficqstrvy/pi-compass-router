// config/patch.ts — 可寫設定鍵的**單一驗證來源**（SPEC Part 3.4 白名單）。
//
// 為什麼要有這支：先前 `config.json` 的解析（`load.ts` 的 `applyFilePatch`）
// 與 `/compass-set` / `compass_config` 的寫入驗證（`PATCH_CHECKS`）是**兩套
// 手寫檢查**；加一個設定鍵常要改兩處，兩邊遲早漂移（2026-10-03 檢討）。
// 這裡用 typebox 描述一次，兩邊都吃它：白名單鍵、型別、範圍、枚舉、
// 未知子鍵全部由此推導。
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";

import {
  DISPLAY_COLORS,
  DISPLAY_DETAILS,
  DISPLAY_FIELDS,
  MODEL_PICKS,
  MODES,
  PROFILES,
  PROVIDERS,
  THINKING_LEVELS,
  TIERS,
  UI_LANGS,
} from "../schema.js";

/** 非空字串（至少一個非空白字元；與舊 `nonEmptyString` 同義）。 */
const NonEmpty = Type.String({ pattern: "\\S" });
const NonNeg = Type.Number({ minimum: 0 });
const NonNegInt = Type.Integer({ minimum: 0 });
const Ratio = Type.Number({ minimum: 0, maximum: 1 });

function literalUnion(values: readonly string[]): TSchema {
  return Type.Union(values.map((value) => Type.Literal(value)));
}

/** 模型條目（`routes` / `kindModels` / `freePool.models`）。 */
const TargetSchema = Type.Object({
  provider: Type.String(),
  model: Type.String(),
  minTier: Type.Optional(literalUnion(TIERS)),
  thinkingLevel: Type.Optional(literalUnion(THINKING_LEVELS)),
  priority: Type.Optional(Type.Number()),
  explicit: Type.Optional(Type.Boolean()),
});

/** 非空陣列；`minItems: 1` 保留舊 chainCheck 的「不可為空」。 */
const Chain = Type.Array(TargetSchema, { minItems: 1 });

/**
 * 頂層鍵 → 允許的 patch 值。`null` 不在 schema 內——「整鍵刪除」由
 * `validatePatchValue` 另行放行（Part 3.4：patch `null` = 刪子鍵）。
 */
export const PATCH_SCHEMA: Record<string, TSchema> = {
  enabled: Type.Boolean(),
  useDefaultModels: Type.Boolean(),
  autoRoutes: Type.Boolean(),
  allowUnratedPicks: Type.Boolean(),
  freeOnly: Type.Boolean(),
  stickiness: Type.Boolean(),
  mode: literalUnion(MODES),
  modelPick: literalUnion(MODEL_PICKS),
  profile: literalUnion(PROFILES),
  classify: Type.Object(
    {
      provider: Type.Optional(literalUnion(PROVIDERS)),
      model: Type.Optional(NonEmpty),
      python: Type.Optional(NonEmpty),
      timeoutMs: Type.Optional(NonNegInt),
      minPromptChars: Type.Optional(NonNegInt),
      historyTurns: Type.Optional(NonNegInt),
      cache: Type.Optional(Type.Boolean()),
      cacheTtlSeconds: Type.Optional(NonNegInt),
      confidenceThreshold: Type.Optional(Ratio),
      cloud: Type.Optional(Type.Object({ provider: NonEmpty, model: NonEmpty })),
    },
    { additionalProperties: false },
  ),
  display: Type.Object(
    {
      detail: Type.Optional(literalUnion(DISPLAY_DETAILS)),
      fields: Type.Optional(Type.Array(literalUnion(DISPLAY_FIELDS))),
      badge: Type.Optional(Type.Boolean()),
      color: Type.Optional(literalUnion(DISPLAY_COLORS)),
      hint: Type.Optional(Type.Boolean()),
      rails: Type.Optional(Type.Boolean()),
      language: Type.Optional(literalUnion(UI_LANGS)),
    },
    { additionalProperties: false },
  ),
  routes: Type.Record(Type.String(), Type.Union([Chain, Type.Null()])),
  kindModels: Type.Record(Type.String(), Type.Union([Chain, Type.Null()])),
  kindMinimumTier: Type.Record(Type.String(), Type.Union([literalUnion(TIERS), Type.Null()])),
  taskKinds: Type.Record(
    Type.String(),
    Type.Object({
      label: NonEmpty,
      floor: Type.Number(),
      priority: Type.Optional(Type.Number()),
    }),
  ),
  xpremium: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }),
  freePool: Type.Object(
    {
      enabled: Type.Optional(Type.Boolean()),
      models: Type.Optional(Type.Array(TargetSchema)),
    },
    { additionalProperties: false },
  ),
  specialistPriority: Type.Record(Type.String(), Type.Array(NonEmpty)),
  suggest: Type.Object({ scoresFile: NonEmpty }, { additionalProperties: false }),
  budget: Type.Object(
    {
      dailyUsd: Type.Optional(Type.Union([NonNeg, Type.Null()])),
      monthlyUsd: Type.Optional(Type.Union([NonNeg, Type.Null()])),
      softRatio: Type.Optional(Ratio),
      hardRatio: Type.Optional(Ratio),
    },
    { additionalProperties: false },
  ),
  ceilings: Type.Record(Type.String(), Type.Union([NonNeg, Type.Null()])),
  deny: Type.Array(NonEmpty),
  allowProviders: Type.Array(NonEmpty),
  prefer: Type.Record(Type.String(), Type.Union([Type.Array(NonEmpty, { minItems: 1 }), Type.Null()])),
  cache: Type.Object(
    {
      aware: Type.Optional(Type.Boolean()),
      deadband: Type.Optional(NonNeg),
      maxPenaltyUsd: Type.Optional(NonNeg),
      bypassTierDelta: Type.Optional(NonNegInt),
      cooldownSeconds: Type.Optional(NonNeg),
    },
    { additionalProperties: false },
  ),
  thinking: Type.Record(Type.String(), Type.Union([literalUnion(THINKING_LEVELS), Type.Null()])),
};

/** 檔案白名單與 `WRITABLE_KEYS` 的單一來源（Part 3.4）。 */
export const TOP_LEVEL_KEYS: readonly string[] = Object.keys(PATCH_SCHEMA);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 未知子鍵的友善訊息（只對 `additionalProperties: false` 的物件做）。 */
function unknownSubkey(key: string, value: Record<string, unknown>): string | null {
  const schema = PATCH_SCHEMA[key] as { properties?: Record<string, unknown>; additionalProperties?: unknown };
  if (!schema.properties || schema.additionalProperties !== false) return null;
  for (const sub of Object.keys(value)) {
    if (!(sub in schema.properties)) return `${key}.${sub}: unknown setting`;
  }
  return null;
}

/**
 * 驗證一個 patch 值。回 `null` = 可寫；否則回 `key[.sub…]: reason`。
 *
 * 規則（與 SPEC Part 3.4 一致）：
 * - 未知的頂層鍵 → `unknown setting (not in the whitelist)`
 * - `null` → 放行（刪除該鍵／子鍵，由寫入層處理）
 * - 空物件 → `expected at least one setting`（空 patch 是無意義的寫入）
 * - 其餘交由 typebox schema（型別、範圍、枚舉、未知子鍵）
 */
export function validatePatchValue(key: string, value: unknown): string | null {
  if (!(key in PATCH_SCHEMA)) return `${key}: unknown setting (not in the whitelist)`;
  if (value === null) return null;
  if (isRecord(value)) {
    if (Object.keys(value).length === 0) return `${key}: expected at least one setting`;
    const unknown = unknownSubkey(key, value);
    if (unknown !== null) return unknown;
  }
  const errors = Value.Errors(PATCH_SCHEMA[key], value);
  if (errors.length === 0) return null;
  const first = errors[0];
  const path = first.instancePath.replace(/^\//, "").replace(/\//g, ".");
  const label = path ? `${key}.${path}` : key;
  const message = /unexpected property|additional propert/i.test(first.message) ? "unknown setting" : first.message;
  return `${label}: ${message}`;
}
