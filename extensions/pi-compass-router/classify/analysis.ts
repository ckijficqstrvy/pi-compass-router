/**
 * 分類問題定義、回應解析與遠端輸出清洗。
 *
 * 這三個職責原本位於禁讀來源 `jev.ts`（Part 0.2），依 SPEC Part 11 於
 * 2026-10-01 重新實作。問題措辭、rubric 文案與解析邏輯均為原創，
 * 不參照任何上游實作。
 *
 * 回應格式的依據是 laya-mlx 官方 API（github.com/mizorewww/laya-mlx，
 * `laya_mlx/agent.py` 的 `system_one()`），實測讀過其程式碼後定義如下：
 *
 *   { model, answers: { <qid>: { type, confidence, action: { act_probability },
 *       choice?: label, probabilities?: {...}      -- type === "choice"
 *       score?:  number, legend?: {...}            -- type === "score"
 *       noul?:   number                           -- type === "noul" } },
 *     usage: { input_tokens, output_tokens } }
 *
 * `score` 是 rubric 層級的**期望值**（0 基準），範圍 [0, k-1]，k = legend 大小。
 * cloud 後端的實際線格式**尚未驗證**（見 SPEC Part 4.3 的未決項），
 * 故 `pickAnswers()` 同時接受 payload 本身就是 answers map 的形狀，
 * 但解析仍以「能取到就用、取不到就留空」為原則——上層 fail-open。
 */

import type { TaskKind, ThinkingLevel } from "../schema.js";
import type { ClassifierSource, Judgment } from "./types.js";

/** 分類失敗（不阻擋回合；上層 fail-open，Part 5 Stage 1）。 */
export class ClassifyError extends Error {
  readonly kind: "timeout" | "protocol" | "unusable" | "spawn";
  constructor(message: string, kind: ClassifyError["kind"] = "protocol") {
    super(message);
    this.name = "ClassifyError";
    this.kind = kind;
  }
}

/** 問題定義（laya/cloud 通用；形狀與 laya-mlx 的 `questions` 一致）。 */
export interface QuestionSpec {
  type: "choice" | "score" | "noul";
  instructions: string;
  /** choice 用：選項標籤（list）或標籤→說明（dict）。 */
  criteria?: string[] | Record<string, string>;
  /** score 的 rubric 層級（由低到高）。**送入 laya 時用 `criteria` 鍵**——
   *  laya-mlx 的 `_to_internal` 對 score 只認 `criteria`（非空 list），
   *  `legend` 是它**回傳**答案時用的鍵（`parseAnalysis` 讀回 `answer.legend`）。 */
  legend?: string[];
}

export type Questions = Record<string, QuestionSpec>;

/** 六個問題的 key。改名會使分類快取失效（Part 6.2），故集中定義。 */
export const Q = {
  kind: "task_kind",
  complexity: "complexity",
  capability: "capability_deserved",
  deepReasoning: "needs_deep_reasoning",
  thinking: "thinking_level",
  modelPick: "model_pick",
} as const;

/** 思考層級選項，順序即由淺至深（Part 3.1）。 */
export const THINKING_CHOICES: readonly ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * complexity rubric：四層，對應 0–3 刻度（Part 5 Stage 2 的 demand 階梯
 * 門檻 0.5 / 1.5 / 2.5 / 2.9 建立在 0–3 範圍上）。
 */
const COMPLEXITY_RUBRIC = [
  "trivial - one obvious local edit",
  "simple - a few coordinated edits",
  "moderate - several files, or a real trade-off",
  "architectural - cross-cutting design or a migration",
];

/** capability rubric：四層。刻意**不含價格資訊**（Part 2：判斷與政策分離）。 */
const CAPABILITY_RUBRIC = [
  "minimal - any small model handles it",
  "standard - a solid coding model is enough",
  "high - a strong reasoner is worth it",
  "maximum - use the best model available",
];

const KIND_INSTRUCTIONS =
  "Classify this request by what the work actually is. Answer with exactly one of the given ids.";

const COMPLEXITY_INSTRUCTIONS =
  "How much design uncertainty does this request carry? Answer with the rubric level.";

const CAPABILITY_INSTRUCTIONS =
  "How capable a model does this request deserve? Ignore price. Answer with the rubric level.";

const DEEP_REASONING_INSTRUCTIONS =
  "Does this request benefit from long deliberate reasoning before answering?";

const THINKING_INSTRUCTIONS =
  "How much extended pre-answer thinking does this request deserve on its own merits? The model and its price are excluded.";

const MODEL_PICK_INSTRUCTIONS =
  "Pick the single best model for this request from the given menu. Price annotations are context, not a constraint.";

/**
 * 建立送給分類器的問題集。
 *
 * `criteria` 一律用 **kind key**（不是 label）——key 短、穩定、易驗證，
 * label 只用在 UI 顯示（Part 3.1a）。
 */
export function buildQuestions(kinds: readonly TaskKind[], menu?: readonly string[]): Questions {
  if (kinds.length === 0) {
    throw new ClassifyError("no task kinds configured", "unusable");
  }
  const questions: Questions = {
    [Q.kind]: {
      type: "choice",
      instructions: KIND_INSTRUCTIONS,
      criteria: [...kinds],
    },
    [Q.complexity]: {
      type: "score",
      instructions: COMPLEXITY_INSTRUCTIONS,
      criteria: [...COMPLEXITY_RUBRIC],
    },
    [Q.capability]: {
      type: "score",
      instructions: CAPABILITY_INSTRUCTIONS,
      criteria: [...CAPABILITY_RUBRIC],
    },
    [Q.deepReasoning]: {
      type: "noul",
      instructions: DEEP_REASONING_INSTRUCTIONS,
    },
    [Q.thinking]: {
      type: "choice",
      instructions: THINKING_INSTRUCTIONS,
      criteria: [...THINKING_CHOICES],
    },
  };
  if (menu && menu.length > 1) {
    questions[Q.modelPick] = {
      type: "choice",
      instructions: MODEL_PICK_INSTRUCTIONS,
      criteria: [...menu],
    };
  }
  return questions;
}

/**
 * 遠端字串清洗：控制字元移除、折疊空白、上限 200 字元。
 *
 * 目的有二：(1) 遠端/子行程的訊息不得把整段堆疊或環境內容灌進 transcript；
 * (2) 與 Part 3.3 的警告規則一致——長度先截斷再判斷可列印性，
 * 使任何值都不可能以原始形狀被回顯。
 */
export function sanitizeRemote(raw: unknown): string {
  const text = typeof raw === "string" ? raw : String(raw);
  const cleaned = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface RawAnswer {
  type?: string;
  confidence?: unknown;
  choice?: unknown;
  score?: unknown;
  legend?: unknown;
  noul?: unknown;
  probabilities?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * 收斂到 4 位小數。
 *
 * laya-mlx 的回值本身是 4dp（其文件載明保留四捨五入到四位），
 * 而 `score → 0–3` 的正規化 `raw / (k-1) * 3` 在 k=4 時數學上是恆等，
 * 浮點卻會給出 1.5500000000000003。正規化只該換刻度，不該改變精度，
 * 故落回資料本身的 4dp 精度。
 */
function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * 取出 answers map。
 *
 * laya 的形狀是 `{ model, answers, usage }`；也接受 payload 本身就是
 * `qid -> answer` 的 map（cloud 後端的線格式尚未驗證，見檔頭）。
 * 都不像 → throw，由上層 fail-open。
 */
function pickAnswers(payload: unknown): Record<string, RawAnswer> {
  const root = asRecord(payload);
  if (!root) throw new ClassifyError("analysis payload is not an object", "unusable");
  const nested = asRecord(root.answers);
  if (nested) return nested as Record<string, RawAnswer>;
  // 自我判別：值必須像 answer（有 type 或三型別之一）。
  const looksLikeAnswer = Object.values(root).some((value) => {
    const answer = asRecord(value);
    if (!answer) return false;
    return (
      typeof answer.type === "string" ||
      "choice" in answer ||
      "score" in answer ||
      "noul" in answer
    );
  });
  if (looksLikeAnswer) return root as Record<string, RawAnswer>;
  throw new ClassifyError("analysis payload has no answers", "unusable");
}

function answerOf(answers: Record<string, RawAnswer>, key: string): RawAnswer | undefined {
  const answer = answers[key];
  return answer && typeof answer === "object" ? answer : undefined;
}

function confidenceOf(answer: RawAnswer | undefined): number | undefined {
  const value = asNumber(answer?.confidence);
  return value === undefined ? undefined : clamp(value, 0, 1);
}

/**
 * score → 0–3 刻度。
 *
 * laya 回的是 rubric 期望層級 [0, k-1]；有 `legend` 就用 k 正規化，
 * 沒有 legend 且值已落在 [0,3] 就直接沿用。兩者都不符合 → undefined
 * （上層以層級預設承接，不做猜測）。
 */
function scoreToThree(answer: RawAnswer | undefined): number | undefined {
  const raw = asNumber(answer?.score);
  if (raw === undefined) return undefined;
  const legend = asRecord(answer?.legend);
  const k = legend ? Object.keys(legend).length : 0;
  if (k > 1) return round4(clamp((raw / (k - 1)) * 3, 0, 3));
  if (k === 1) return 0;
  if (raw >= 0 && raw <= 3) return round4(clamp(raw, 0, 3));
  return undefined;
}

function noulOf(answer: RawAnswer | undefined): number | undefined {
  const raw = asNumber(answer?.noul);
  return raw === undefined ? undefined : clamp(raw, 0, 1);
}

function choiceOf(answer: RawAnswer | undefined): string | undefined {
  const value = answer?.choice;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface ParseOptions {
  source: ClassifierSource;
  /** 允許的種類；不在集合內 → throw（Part 4.1：分類器不能自訂種類）。 */
  allowedKinds?: readonly TaskKind[];
  menuKeys?: readonly string[];
  cacheHit?: boolean;
}

/**
 * 把分類器回應解析成 `Judgment`。
 *
 * `kind` 是必需的——沒有可用種類，整輪判斷無法成立，故 throw 讓上層
 * fail-open。其餘五欄皆可缺：缺 `complexity`／`capability` 時 Stage 2
 * 不做 demand 調整（Part 5），缺 `thinking` 時落到 demand 階梯。
 */
export function parseAnalysis(payload: unknown, latencyMs: number, options: ParseOptions): Judgment {
  const answers = pickAnswers(payload);

  const kind = choiceOf(answerOf(answers, Q.kind));
  if (kind === undefined) {
    throw new ClassifyError("task_kind answer missing", "unusable");
  }
  if (options.allowedKinds && !options.allowedKinds.includes(kind)) {
    throw new ClassifyError(`task_kind "${sanitizeRemote(kind)}" not in configured kinds`, "unusable");
  }

  const kindAnswer = answerOf(answers, Q.kind);
  const kindConfidence = confidenceOf(kindAnswer) ?? 0;

  const thinkingRaw = choiceOf(answerOf(answers, Q.thinking));
  const thinking = (THINKING_CHOICES as readonly string[]).includes(thinkingRaw ?? "")
    ? (thinkingRaw as ThinkingLevel)
    : undefined;

  const pickRaw = choiceOf(answerOf(answers, Q.modelPick));
  const modelPick =
    pickRaw !== undefined && options.menuKeys && options.menuKeys.includes(pickRaw)
      ? pickRaw
      : undefined;

  const judgment: Judgment = {
    kind: kind as TaskKind,
    kindConfidence,
    latencyMs,
    source: options.source,
  };
  const complexity = scoreToThree(answerOf(answers, Q.complexity));
  const capability = scoreToThree(answerOf(answers, Q.capability));
  const deepReasoning = noulOf(answerOf(answers, Q.deepReasoning));
  if (complexity !== undefined) judgment.complexity = complexity;
  if (capability !== undefined) judgment.capability = capability;
  if (deepReasoning !== undefined) judgment.deepReasoning = deepReasoning;
  if (thinking !== undefined) judgment.thinking = thinking;
  if (modelPick !== undefined) judgment.modelPick = modelPick;
  if (options.cacheHit) judgment.cacheHit = true;
  return judgment;
}