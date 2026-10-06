// test/routes.test.ts — S1 資料層：canonical 身分 + route/endpoint 報價。
// 設計見 docs/canonical-model-routes.md。這批測試存在的理由：把「能力 = 模型屬性、
// 價格/可用性 = route 屬性」固定下來，並防止將來退回「只看 openrouter 分數」或
// 「單一價格」的舊行為。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bestEndpoint,
  blendedOf,
  buildRoutes,
  canonicalKeyMap,
  canonicalOf,
  capabilityByCanonical,
  isHealthy,
  type EndpointQuote,
} from "../extensions/pi-compass-router/policy/routes.js";
import type { ModelFact } from "../extensions/pi-compass-router/policy/facts.js";

const ep = (upstream: string, input: number, output: number, status?: number): EndpointQuote => ({
  upstream,
  input,
  output,
  status,
});

test("blended price is input + 2x output", () => {
  assert.equal(blendedOf({ input: 1, output: 2 }), 5);
});

test("isHealthy: missing status is healthy, 0 is healthy, non-zero is not", () => {
  assert.equal(isHealthy({ upstream: "a", input: 1, output: 1 }), true);
  assert.equal(isHealthy({ upstream: "a", input: 1, output: 1, status: 0 }), true);
  assert.equal(isHealthy({ upstream: "a", input: 1, output: 1, status: -2 }), false);
});

test("bestEndpoint picks the cheapest healthy upstream and ignores degraded ones", () => {
  const endpoints = [
    ep("priciest", 0.3, 1.2),
    ep("cheap-but-down", 0.001, 0.002, -2),
    ep("cheap-ok", 0.003, 2.4),
    ep("mid", 0.05, 0.3),
  ];
  assert.equal(bestEndpoint(endpoints)?.upstream, "mid", "cheap-ok blended 4.8 vs mid 0.65");
  assert.equal(bestEndpoint([ep("down", 0.001, 0.001, -1)]), undefined);
});

test("canonicalOf: openrouter slug is already canonical, direct provider needs an override", () => {
  assert.equal(canonicalOf("openrouter", "deepseek/deepseek-v4.1-flash"), "deepseek/deepseek-v4.1-flash");
  assert.equal(canonicalOf("deepseek", "deepseek-flash"), "deepseek/deepseek-flash");
  assert.equal(
    canonicalOf("deepseek", "deepseek-flash", "deepseek/deepseek-v4.1-flash"),
    "deepseek/deepseek-v4.1-flash",
    "explicit canonical unifies a direct provider with the openrouter route",
  );
});

test("capability is shared across providers of the same canonical model", () => {
  const facts: ModelFact[] = [
    { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", capability: { intelligence: 39 } },
    { provider: "deepseek", model: "deepseek-flash", canonical: "deepseek/deepseek-v4.1-flash", capability: { intelligence: 39 } },
  ];
  const { byCanonical, conflicts } = capabilityByCanonical(facts);
  assert.equal(byCanonical.size, 1, "two routes of the same model collapse to one canonical");
  assert.equal(byCanonical.get("deepseek/deepseek-v4.1-flash")?.capability.intelligence, 39);
  assert.deepEqual(conflicts, []);
});

test("capabilityByCanonical reports (does not silently resolve) conflicting scores", () => {
  const facts: ModelFact[] = [
    { provider: "openrouter", model: "x/y", capability: { intelligence: 40 } },
    { provider: "x", model: "y", canonical: "x/y", capability: { intelligence: 30 } },
  ];
  const { conflicts } = capabilityByCanonical(facts);
  assert.deepEqual(conflicts, ["x/y"]);
});

test("buildRoutes marks aggregators, keeps per-endpoint quotes, and skips unpriced models", () => {
  const registry = [
    { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", cost: { input: 0.3, output: 1.2 } },
    { provider: "deepseek", id: "deepseek-flash", cost: { input: 0.3, output: 1.2 } },
    { provider: "nvidia", id: "deepseek-ai/deepseek-v4.1-flash" }, // no cost, no endpoints
  ];
  const endpointsByKey = new Map<string, EndpointQuote[]>([
    ["openrouter/deepseek/deepseek-v4.1-flash", [ep("Relace", 0.003, 2.4), ep("InferenceNet", 0.05, 0.3)]],
  ]);
  const canonicalByKey = new Map([["deepseek/deepseek-flash", "deepseek/deepseek-v4.1-flash"]]);

  const routes = buildRoutes(registry, { endpointsByKey, canonicalByKey });
  const or = routes.find((r) => r.provider === "openrouter");
  const direct = routes.find((r) => r.provider === "deepseek");

  assert.equal(routes.length, 2, "unpriced model is skipped in S1");
  assert.equal(or?.kind, "aggregator");
  assert.equal(or?.endpoints.length, 2, "per-endpoint quotes are preserved, not collapsed to one price");
  assert.equal(or?.canonical, "deepseek/deepseek-v4.1-flash");
  assert.equal(direct?.kind, "direct");
  assert.equal(direct?.canonical, "deepseek/deepseek-v4.1-flash", "direct route unifies with the openrouter canonical");
  assert.equal(bestEndpoint(or!.endpoints)?.upstream, "InferenceNet");
});

test("buildRoutes falls back to the registry cost when no endpoint cache is given", () => {
  const routes = buildRoutes([{ provider: "openrouter", id: "a/b", cost: { input: 1, output: 2 }, contextWindow: 1000 }]);
  assert.equal(routes.length, 1);
  assert.deepEqual(routes[0].endpoints, [{ upstream: "openrouter", input: 1, output: 2, contextWindow: 1000 }]);
});

test("canonicalKeyMap maps only facts that declare a canonical identity", () => {
  const facts: ModelFact[] = [
    {
      provider: "deepseek",
      model: "deepseek-flash",
      canonical: "deepseek/deepseek-v4.1-flash",
      capability: { intelligence: 39 },
    },
    { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", capability: { intelligence: 39 } },
    { provider: "x", model: "y", canonical: "   ", capability: { intelligence: 30 } },
  ];
  const map = canonicalKeyMap(facts);
  assert.equal(map.get("deepseek/deepseek-flash"), "deepseek/deepseek-v4.1-flash");
  assert.equal(map.has("openrouter/deepseek/deepseek-v4.1-flash"), false, "no explicit canonical -> absent");
  assert.equal(map.has("x/y"), false, "whitespace canonical -> absent");
});
