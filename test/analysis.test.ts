import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClassifyError,
  Q,
  THINKING_CHOICES,
  buildQuestions,
  parseAnalysis,
  sanitizeRemote,
} from "../extensions/pi-compass-router/classify/analysis.js";

const KINDS = ["plan", "implement", "debug", "chat"] as const;

/** 依 laya-mlx `system_one()` 的實際回傳形狀建構（見 analysis.ts 檔頭註解）。 */
function layaPayload(overrides: Record<string, unknown> = {}): unknown {
  const answers: Record<string, unknown> = {
    [Q.kind]: {
      type: "choice",
      confidence: 0.9132,
      action: { act_probability: 0.84 },
      choice: "plan",
      probabilities: { plan: 0.9132, chat: 0.0868 },
    },
    [Q.complexity]: {
      type: "score",
      confidence: 0.7,
      action: { act_probability: 0.5 },
      score: 1.7,
      legend: { "0": "trivial", "1": "simple", "2": "moderate", "3": "architectural" },
      probabilities: { "0": 0.1, "1": 0.6, "2": 0.2, "3": 0.1 },
    },
    [Q.capability]: {
      type: "score",
      confidence: 0.6,
      action: { act_probability: 0.5 },
      score: 1.55,
      legend: { "0": "minimal", "1": "standard", "2": "high", "3": "maximum" },
      probabilities: { "0": 0.1, "1": 0.7, "2": 0.15, "3": 0.05 },
    },
    [Q.deepReasoning]: {
      type: "noul",
      confidence: 0.82,
      action: { act_probability: 0.82 },
      noul: 0.82,
    },
    [Q.thinking]: {
      type: "choice",
      confidence: 0.7,
      action: { act_probability: 0.7 },
      choice: "high",
      probabilities: { high: 0.7 },
    },
    ...overrides,
  };
  return {
    model: "laya-rl-agent",
    answers,
    usage: { input_tokens: 120, output_tokens: 0 },
  };
}

test("buildQuestions emits the five core questions with matching types", () => {
  const questions = buildQuestions([...KINDS]);
  assert.equal(Object.keys(questions).length, 5);
  assert.equal(questions[Q.kind].type, "choice");
  assert.equal(questions[Q.complexity].type, "score");
  assert.equal(questions[Q.capability].type, "score");
  assert.equal(questions[Q.deepReasoning].type, "noul");
  assert.equal(questions[Q.thinking].type, "choice");
  assert.equal(questions[Q.modelPick], undefined, "no sixth question without a menu");
});

test("buildQuestions uses kind keys as criteria, not labels", () => {
  const questions = buildQuestions([...KINDS]);
  assert.deepStrictEqual(questions[Q.kind].criteria, [...KINDS]);
});

test("buildQuestions adds the sixth question only for a menu larger than one", () => {
  assert.equal(buildQuestions([...KINDS], ["m1"])[Q.modelPick], undefined);
  const withMenu = buildQuestions([...KINDS], ["m1", "m2"]);
  assert.equal(withMenu[Q.modelPick]?.type, "choice");
  assert.deepStrictEqual(withMenu[Q.modelPick]?.criteria, ["m1", "m2"]);
});

test("buildQuestions rejects an empty kind set", () => {
  assert.throws(() => buildQuestions([]), (error: unknown) => {
    assert.ok(error instanceof ClassifyError);
    assert.equal(error.kind, "unusable");
    return true;
  });
});

test("parseAnalysis maps a full laya payload onto Judgment", () => {
  const judgment = parseAnalysis(layaPayload(), 12, {
    source: "laya",
    allowedKinds: [...KINDS],
  });
  assert.equal(judgment.kind, "plan");
  assert.equal(judgment.kindConfidence, 0.9132);
  assert.equal(judgment.complexity, 1.7);
  assert.equal(judgment.capability, 1.55);
  assert.equal(judgment.deepReasoning, 0.82);
  assert.equal(judgment.thinking, "high");
  assert.equal(judgment.latencyMs, 12);
  assert.equal(judgment.source, "laya");
  assert.equal(judgment.modelPick, undefined);
  assert.equal(judgment.cacheHit, undefined);
});

test("score is normalised to the 0-3 scale by legend size", () => {
  // k = 3：score 2 → (2/2)*3 = 3
  const payload = layaPayload({
    [Q.complexity]: {
      type: "score",
      confidence: 0.5,
      score: 2,
      legend: { "0": "low", "1": "mid", "2": "high" },
      probabilities: {},
    },
  });
  const judgment = parseAnalysis(payload, 1, { source: "laya", allowedKinds: [...KINDS] });
  assert.equal(judgment.complexity, 3);
});

test("a score with no legend is taken as already being on the 0-3 scale", () => {
  const payload = layaPayload({
    [Q.capability]: { type: "score", confidence: 0.5, score: 2.5, probabilities: {} },
  });
  const judgment = parseAnalysis(payload, 1, { source: "laya", allowedKinds: [...KINDS] });
  assert.equal(judgment.capability, 2.5);
});

test("an unparseable score is omitted rather than guessed", () => {
  const payload = layaPayload({
    [Q.complexity]: { type: "score", confidence: 0.5, score: 42, probabilities: {} },
  });
  const judgment = parseAnalysis(payload, 1, { source: "laya", allowedKinds: [...KINDS] });
  assert.equal(judgment.complexity, undefined);
});

test("parseAnalysis accepts a bare answers map as well as the wrapped payload", () => {
  const bare = {
    [Q.kind]: { type: "choice", confidence: 0.8, choice: "chat" },
    [Q.thinking]: { type: "choice", confidence: 0.9, choice: "off" },
  };
  const judgment = parseAnalysis(bare, 5, { source: "cloud", allowedKinds: [...KINDS] });
  assert.equal(judgment.kind, "chat");
  assert.equal(judgment.thinking, "off");
  assert.equal(judgment.source, "cloud");
});

test("a kind outside the configured set is rejected", () => {
  const payload = layaPayload({
    [Q.kind]: { type: "choice", confidence: 0.9, choice: "legal" },
  });
  assert.throws(() => parseAnalysis(payload, 1, { source: "laya", allowedKinds: [...KINDS] }), (error: unknown) => {
    assert.ok(error instanceof ClassifyError);
    assert.equal(error.kind, "unusable");
    return true;
  });
});

test("a missing task_kind is rejected instead of guessed", () => {
  assert.throws(() => parseAnalysis(layaPayload({ [Q.kind]: undefined }), 1, { source: "laya" }), ClassifyError);
});

test("an unrecognised thinking level falls through so Stage 2 uses the ladder", () => {
  const payload = layaPayload({
    [Q.thinking]: { type: "choice", confidence: 0.4, choice: "banana" },
  });
  const judgment = parseAnalysis(payload, 1, { source: "laya", allowedKinds: [...KINDS] });
  assert.equal(judgment.thinking, undefined);
  assert.ok(THINKING_CHOICES.includes("high"));
});

test("a model pick outside the menu is dropped (a pick is a preference, not an authorization)", () => {
  const payload = layaPayload({
    [Q.modelPick]: { type: "choice", confidence: 0.9, choice: "not-in-menu" },
  });
  const judgment = parseAnalysis(payload, 1, {
    source: "laya",
    allowedKinds: [...KINDS],
    menuKeys: ["m1", "m2"],
  });
  assert.equal(judgment.modelPick, undefined);

  const accepted = parseAnalysis(
    layaPayload({ [Q.modelPick]: { type: "choice", confidence: 0.9, choice: "m2" } }),
    1,
    { source: "laya", allowedKinds: [...KINDS], menuKeys: ["m1", "m2"] },
  );
  assert.equal(accepted.modelPick, "m2");
});

test("a payload with no answers throws instead of fabricating a judgment", () => {
  assert.throws(() => parseAnalysis({ hello: "world" }, 1, { source: "laya" }), ClassifyError);
  assert.throws(() => parseAnalysis("not an object", 1, { source: "laya" }), ClassifyError);
});

test("confidence is clamped into 0-1", () => {
  const payload = layaPayload({
    [Q.kind]: { type: "choice", confidence: 7.5, choice: "plan" },
  });
  const judgment = parseAnalysis(payload, 1, { source: "laya", allowedKinds: [...KINDS] });
  assert.equal(judgment.kindConfidence, 1);
});

test("cacheHit is propagated only when the option says so", () => {
  const withFlag = parseAnalysis(layaPayload(), 1, { source: "cache", cacheHit: true });
  assert.equal(withFlag.cacheHit, true);
  assert.equal(withFlag.source, "cache");
  const without = parseAnalysis(layaPayload(), 1, { source: "laya" });
  assert.equal(without.cacheHit, undefined);
});

test("sanitizeRemote strips control characters and collapses whitespace", () => {
  assert.equal(sanitizeRemote("a\u0000b\u0007c\n\td"), "a b c d");
  assert.equal(sanitizeRemote(12345), "12345");
});

test("sanitizeRemote caps length at 200 characters", () => {
  const out = sanitizeRemote("x".repeat(500));
  assert.equal(out.length, 200);
  assert.ok(out.endsWith("..."));
});