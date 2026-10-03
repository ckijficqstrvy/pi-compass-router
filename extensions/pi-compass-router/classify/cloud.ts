// classify/cloud.ts — cloud 分類後端（SPEC Part 4.3：opt-in、provider 可替換、
// endpoint 寫死、計費入帳本）。
//
// 線格式已驗證（2026-10-02，見 SPEC Part 4.3「已驗證線格式」）：
//   POST https://api.typesafe.ai/v1/systemone
//   req  { state, model, questions }   — choice 的 criteria 必須是 **object map**
//        （array → 422「Input should be a valid dictionary」，實抓確認）
//   resp { model, answers, usage }     — 就是 parseAnalysis() 已接受的
//        {answers} 形狀，無第三種形狀。
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { buildQuestions, ClassifyError, parseAnalysis } from "./analysis.js";
import { cacheKey, ClassificationCache, configGeneration } from "./cache.js";
import type { ClassifyInput, Classifier, Judgment } from "./types.js";
import { recordSpend } from "../budget.js";
import type { CompassConfig } from "../schema.js";

/** Endpoint 寫死（Part 4.3：無 `endpoint` 設定鍵，防止設定檔轉向 Bearer key）。 */
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** 金鑰檔（Part 4.3：必須 0600，否則拒絕讀取）。 */
const AUTH_FILE = join(homedir(), ".pi", "agent", "pi-typesafe", "auth.json");

/**
 * input token 單價（USD/M）。Part 4.3 要求「分類耗用計入帳本」但未定換算；
 * OpenAPI 載明 **output tokens 目前免費**，故只計 input。此價為佔位，
 * 若 typesafe 實際計價不同，改這裡即可（回填 Part 4.3）。
 */
const INPUT_USD_PER_M = 0.002;

/** 讀 API 金鑰：環境變數 → auth.json（0600，否則拒讀）。回 undefined = 沒有。 */
function resolveApiKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const fromEnv = env.TYPESAFE_API_KEY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const mode = statSync(AUTH_FILE).mode & 0o777;
    if (mode !== 0o600) return undefined; // 權限過寬 → 拒絕讀取（Part 4.3）
    const parsed: unknown = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const key = (parsed as Record<string, unknown>).apiKey;
      if (typeof key === "string" && key.length > 0) return key;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * choice 的 `criteria` array → object map。
 *
 * typesafe 的 `ChoiceQuestion.criteria` 是 map（array → 422）；laya 兩者都收。
 * `buildQuestions()` 維持傳 array（laya 與快取鍵穩定），只在 cloud client 這裡轉。
 * 無描述 → 以標籤自身為值（OpenAPI：無描述按名字解釋）。
 */
function toChoiceMap(questions: Record<string, { type: string; criteria?: unknown }>): void {
  for (const q of Object.values(questions)) {
    if (q.type === "choice" && Array.isArray(q.criteria)) {
      const map: Record<string, string> = {};
      for (const label of q.criteria as unknown[]) {
        if (typeof label === "string") map[label] = label;
      }
      q.criteria = map;
    }
  }
}

/**
 * 建立 cloud 分類器（`classify.provider: "cloud"` 時使用）。
 *
 * - 金鑰：`TYPESAFE_API_KEY` → `~/.pi/agent/pi-typesafe/auth.json`（0600）。
 *   沒有 → `classify()` throw `ClassifyError("spawn")`（上層 fail-open）。
 * - provider 由 `classify.cloud.provider` 決定（移植 #1）；此實作只支援
 *   `typesafe`（endpoint 寫死），其他 provider 回 unsupported（Part 4.3）。
 * - 每請求受 `classify.timeoutMs` 約束；逾時 throw（Part 6.1 cloud < 800ms）。
 * - 計費：input tokens → `recordSpend`（output 免費，Part 4.3）。
 * - 快取：與 laya 同一 `ClassificationCache` 語意（Part 6.2）。
 */
export function createCloudClassifier(
  config: CompassConfig,
  options: { apiKey?: string; env?: Record<string, string | undefined> } = {},
): Classifier {
  const provider = config.classify.cloud.provider;
  const model = config.classify.cloud.model;
  const cache = new ClassificationCache({
    enabled: config.classify.cache,
    ttlSeconds: config.classify.cacheTtlSeconds,
  });
  const generation = configGeneration(config.taskKinds, config.modelPick);
  // 金鑰可由呼叫端注入（測試 hermeticro：不依賴本機 ~/.pi auth.json）。
  const apiKey = options.apiKey !== undefined ? options.apiKey : resolveApiKey(options.env);

  async function classify(input: ClassifyInput, signal: AbortSignal): Promise<Judgment> {
    // 快取查（Part 6.2）。
    const hitStart = Date.now();
    const hit = cache.get(cacheKey(input.request, generation), Date.now() - hitStart);
    if (hit) return hit;

    if (provider !== "typesafe") {
      throw new ClassifyError(`cloud provider "${provider}" not supported (endpoint is typesafe-only)`, "spawn");
    }
    if (!apiKey) {
      throw new ClassifyError("no typesafe API key (set TYPESAFE_API_KEY or auth.json 0600)", "spawn");
    }

    const questions = buildQuestions(input.kinds, input.menu) as Record<
      string,
      { type: string; criteria?: unknown }
    >;
    toChoiceMap(questions);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.classify.timeoutMs);
    const onOuterAbort = (): void => controller.abort();
    signal.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state: input.request, model, questions }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 200);
        throw new ClassifyError(`typesafe HTTP ${response.status}: ${detail}`, "protocol");
      }
      const payload: unknown = await response.json();
      const latencyMs = Date.now() - startedAt;

      const judgment = parseAnalysis(payload, latencyMs, {
        source: "cloud",
        allowedKinds: input.kinds,
        menuKeys: input.menu,
      });

      // 計費（Part 4.3）：input tokens → 帳本（output 免費）。
      billUsage(payload);

      cache.set(cacheKey(input.request, generation), judgment);
      return judgment;
    } catch (error) {
      if (error instanceof ClassifyError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new ClassifyError(`cloud classify timed out after ${config.classify.timeoutMs}ms`, "timeout");
      }
      throw new ClassifyError(
        `cloud request failed: ${error instanceof Error ? error.message : String(error)}`,
        "protocol",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onOuterAbort);
    }
  }

  return {
    id: "cloud",
    classify,
    // cloud 無需預熱（每次 HTTPS 呼叫獨立）。
    warm() {},
    dispose() {
      // 無長生命資源。
    },
  };
}

/** `usage.input_tokens` → `recordSpend`（output 免費，Part 4.3）。 */
function billUsage(payload: unknown): void {
  if (typeof payload !== "object" || payload === null) return;
  const usage = (payload as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return;
  const inputTokens = (usage as Record<string, unknown>).input_tokens;
  if (typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens <= 0) return;
  recordSpend((inputTokens / 1_000_000) * INPUT_USD_PER_M);
}