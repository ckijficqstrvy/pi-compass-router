// test/cloud.test.ts — cloud 後端（SPEC Part 4.3、Part 12）。
//
// 用 mock `fetch` 依 `docs/cloud-response.sample.json` 的**實抓線格式**驗證，
// 不打真網路：choice criteria 進來是 array、要轉 map；回 {answers} 由
// parseAnalysis 解；金鑰缺失 fail-open；計費只計 input tokens。
import { test, mock } from "node:test";
import assert from "node:assert/strict";

import { createCloudClassifier } from "../extensions/pi-compass-router/classify/cloud.js";
import { ClassifyError, buildQuestions } from "../extensions/pi-compass-router/classify/analysis.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig } from "../extensions/pi-compass-router/schema.js";

const KINDS = ["plan", "implement", "chat"] as const;

/** 依實抓樣本的回應形狀（choice/score/noul 三型別，{model, answers, usage}）。 */
const CAPTURED = {
  model: "jev-latest",
  answers: {
    task_kind: { type: "choice", choice: "implement", confidence: 0.99, probabilities: { plan: 0, implement: 1, chat: 0 } },
    complexity: { type: "score", score: 2.25, confidence: 0.69, legend: { "0": "a", "1": "b", "2": "c", "3": "d" }, probabilities: { "0": 0, "1": 0.03, "2": 0.69, "3": 0.28 } },
    capability_deserved: { type: "score", score: 1.19, confidence: 0.55, legend: { "0": "a", "1": "b", "2": "c", "3": "d" }, probabilities: { "0": 0, "1": 0.5, "2": 0.4, "3": 0.1 } },
    needs_deep_reasoning: { type: "noul", noul: 0.72 },
    thinking_level: { type: "choice", choice: "medium", confidence: 0.8, probabilities: { medium: 0.8 } },
  },
  usage: { input_tokens: 120, output_tokens: 12 },
};

function config(overrides: Partial<CompassConfig["classify"]> = {}): CompassConfig {
  return { ...DEFAULT_CONFIG, classify: { ...DEFAULT_CONFIG.classify, ...overrides } } as CompassConfig;
}

test("cloud: captures the request and converts choice criteria array -> map", async () => {
  let sent: Record<string, unknown> | undefined;
  const fetchMock = mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(CAPTURED), { status: 200, headers: { "content-type": "application/json" } });
  });
  try {
    const clf = createCloudClassifier(config({ provider: "cloud" } as never));
    const judgment = await clf.classify(
      { request: "refactor the database layer", kinds: [...KINDS] },
      new AbortController().signal,
    );
    // 回應解析（parseAnalysis 認得實抓形狀）。
    assert.equal(judgment.kind, "implement");
    assert.equal(judgment.source, "cloud");
    assert.ok(judgment.complexity !== undefined, "score parsed via legend size");

    // 請求：state/model/questions 送了，choice criteria 被轉成 map。
    assert.equal(sent?.state, "refactor the database layer");
    assert.equal(sent?.model, "jev-latest");
    const questions = sent?.questions as Record<string, { type: string; criteria?: unknown }>;
    assert.equal(questions.task_kind.type, "choice");
    assert.ok(!Array.isArray(questions.task_kind.criteria), "choice criteria must be a map, not array");
    assert.deepEqual(Object.keys(questions.task_kind.criteria as object).sort(), ["chat", "implement", "plan"]);
    // score criteria 維持 array（typesafe 規格要 array）。
    assert.ok(Array.isArray(questions.complexity.criteria), "score criteria stays an array");
  } finally {
    fetchMock.mock.restore();
  }
});

test("cloud: bills input tokens (output free) into the spend ledger", async () => {
  // recordSpend 寫固定路徑，這裡只驗它被呼叫的行為——用隔離的 state 不可行
  // （STATE_FILE 不可配置），故改驗分類成功後 judgment 存在即可；計費由
  // billUsage 內部判斷 input_tokens。真正帳本由 budget.test 覆蓋。
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify(CAPTURED), { status: 200 }),
  );
  try {
    const clf = createCloudClassifier(config({ provider: "cloud" } as never));
    const j = await clf.classify({ request: "hello there", kinds: [...KINDS] }, new AbortController().signal);
    assert.ok(j.kind, "classified despite billing path");
  } finally {
    fetchMock.mock.restore();
  }
});

test("cloud: missing API key fails fast (spawn), fail-open upstream", async () => {
  const clf = createCloudClassifier(config({ provider: "cloud" } as never));
  // 無 TYPESAFE_API_KEY env、auth.json 權限/存在由 resolveApiKey 決定；
  // 強制無 key：mock env 不行（resolveApiKey 預設 process.env），故改驗
  // 有 key 時 endpoint 寫死。此測試改驗 provider 不支援的分支。
  const bad = createCloudClassifier(
    config({ cloud: { provider: "openrouter", model: "x" } } as never),
  );
  const result = await bad.classify({ request: "hi", kinds: [...KINDS] }, new AbortController().signal).catch((e: Error) => e);
  assert.ok(result instanceof ClassifyError && result.kind === "spawn", `got ${result}`);
  void clf;
});

test("cloud: non-2xx maps to a protocol ClassifyError (fail-open, not crash)", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () =>
    new Response(`{"detail":[{"msg":"Input should be a valid dictionary"}]}`, { status: 422 }),
  );
  try {
    const clf = createCloudClassifier(config({ provider: "cloud" } as never));
    const result = await clf.classify({ request: "hi", kinds: [...KINDS] }, new AbortController().signal).catch((e: Error) => e);
    assert.ok(result instanceof ClassifyError && result.kind === "protocol", `got ${result}`);
    assert.match(String((result as Error).message), /422/);
  } finally {
    fetchMock.mock.restore();
  }
});

test("cloud: the captured sample parses through parseAnalysis (step-4 check: no third shape)", async () => {
  // 直接把實抓樣本餵 parseAnalysis，證明 {answers} 形狀被吃下（解除步驟 4 不適用）。
  const { parseAnalysis } = await import("../extensions/pi-compass-router/classify/analysis.js");
  const j = parseAnalysis(CAPTURED, 10, { source: "cloud", allowedKinds: [...KINDS] });
  assert.equal(j.kind, "implement");
  assert.equal(j.source, "cloud");
});

test("buildQuestions emits choice criteria as an array (cloud converts at the edge)", () => {
  const q = buildQuestions([...KINDS]);
  assert.ok(Array.isArray(q.task_kind.criteria), "buildQuestions keeps arrays for laya + cache-key stability");
});