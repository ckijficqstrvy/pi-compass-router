// test/menu-flow.test.ts — menu 兩階段分類（W5）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyInStages } from "../extensions/pi-compass-router/classify/flow.js";
import { DEFAULT_CONFIG, type CompassConfig } from "../extensions/pi-compass-router/schema.js";
import type { Classifier, ClassifyInput, Judgment } from "../extensions/pi-compass-router/classify/types.js";

function config(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return { ...DEFAULT_CONFIG, ...overrides } as CompassConfig;
}

/** 記錄每次呼叫的 input；回傳可由 map 控制的 judgment。 */
function fakeClassifier(judgmentFor: (input: ClassifyInput) => Judgment | Error) {
  const calls: ClassifyInput[] = [];
  const classifier: Classifier = {
    id: "laya",
    async classify(input) {
      calls.push(input);
      const result = judgmentFor(input);
      if (result instanceof Error) throw result;
      return result;
    },
    dispose() {},
  };
  return { classifier, calls };
}

const judgment = (overrides: Partial<Judgment> = {}): Judgment => ({
  kind: "chat",
  kindConfidence: 0.9,
  complexity: 1.6,
  capability: 1.6,
  source: "laya",
  latencyMs: 1,
  ...overrides,
});

test("menu mode runs a second pass with the real tier's menu (W5)", async () => {
  const { classifier, calls } = fakeClassifier((input) =>
    input.menu === undefined ? judgment() : judgment({ modelPick: input.menu[0] }),
  );
  const out = await classifyInStages(
    classifier,
    { request: "x", kinds: ["chat"] },
    config({ modelPick: "menu", routes: { quick: [], standard: [{ provider: "p", model: "a" }], high: [{ provider: "p", model: "b" }, { provider: "p", model: "c" }], premium: [], xpremium: [] } }),
    new AbortController().signal,
  );
  assert.equal(calls.length, 2, "two passes in menu mode");
  assert.equal(calls[0].menu, undefined, "first pass has no menu");
  assert.ok(calls[1].menu && calls[1].menu.length > 1, "second pass carries the tier menu");
  assert.equal(out?.modelPick, calls[1].menu?.[0]);
});

test("non-menu mode runs a single pass", async () => {
  const { classifier, calls } = fakeClassifier(() => judgment());
  await classifyInStages(classifier, { request: "x", kinds: ["chat"] }, config(), new AbortController().signal);
  assert.equal(calls.length, 1);
});

test("menu mode with <=1 candidate stays single-pass", async () => {
  const { classifier, calls } = fakeClassifier(() => judgment());
  await classifyInStages(
    classifier,
    { request: "x", kinds: ["chat"] },
    config({
      modelPick: "menu",
      kindModels: {},
      routes: { quick: [], standard: [{ provider: "p", model: "only" }], high: [], premium: [], xpremium: [] },
    }),
    new AbortController().signal,
  );
  assert.equal(calls.length, 1, "no pointless sixth question");
});

test("a failing second pass falls back to the first judgment", async () => {
  const { classifier, calls } = fakeClassifier((input) =>
    input.menu === undefined ? judgment({ kind: "plan" }) : new Error("boom"),
  );
  const out = await classifyInStages(
    classifier,
    { request: "x", kinds: ["plan"] },
    config({ modelPick: "menu", routes: { quick: [], standard: [{ provider: "p", model: "a" }], high: [{ provider: "p", model: "b" }, { provider: "p", model: "c" }], premium: [], xpremium: [] } }),
    new AbortController().signal,
  );
  assert.equal(calls.length, 2);
  assert.equal(out?.kind, "plan", "first-pass judgment survives the menu failure");
});
