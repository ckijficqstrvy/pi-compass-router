// test/candidates.test.ts — S2：registry 可行集（policy/candidates.ts）。
// 固定「約束過濾 + 排序」語意：能力查 canonical、價格取健康 endpoint 中位數、
// 政策與否決/白名單照舊。
import { test } from "node:test";
import assert from "node:assert/strict";

import { medianHealthyPrice, registryChain } from "../extensions/pi-compass-router/policy/candidates.js";
import type { EndpointQuote, Route } from "../extensions/pi-compass-router/policy/routes.js";
import { DEFAULT_CONFIG, type CompassConfig } from "../extensions/pi-compass-router/schema.js";

const ep = (upstream: string, input: number, output: number, status?: number): EndpointQuote => ({ upstream, input, output, status });

const route = (provider: string, model: string, canonical: string, endpoints: EndpointQuote[]): Route => ({
  provider,
  model,
  canonical,
  kind: provider === "openrouter" ? "aggregator" : "direct",
  endpoints,
});

const ROUTES: Route[] = [
  route("openrouter", "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash", [
    ep("Relace", 0.003, 2.4),
    ep("InferenceNet", 0.05, 0.3),
  ]),
  route("deepseek", "deepseek-flash", "deepseek/deepseek-v4.1-flash", [ep("deepseek", 0.3, 1.2)]),
  route("openrouter", "xiaomi/mimo-v2.6-flash", "xiaomi/mimo-v2.6-flash", [ep("Io Net", 0.14, 0.28)]),
];

const CAP = new Map<string, number>([
  ["deepseek/deepseek-v4.1-flash", 39],
  ["xiaomi/mimo-v2.6-flash", 23],
]);

function configWith(overrides: Partial<CompassConfig> = {}): CompassConfig {
  return { ...DEFAULT_CONFIG, selection: "registry", profile: "cheap", deny: [], allowProviders: [], allowUnratedPicks: false, ...overrides };
}

test("medianHealthyPrice is the median blended price of healthy endpoints", () => {
  assert.equal(medianHealthyPrice([ep("a", 0.003, 2.4), ep("b", 0.05, 0.3)]), (4.803 + 0.65) / 2);
  assert.equal(medianHealthyPrice([ep("down", 0.001, 0.001, -2)]), undefined, "degraded endpoints do not count");
  assert.equal(medianHealthyPrice([]), undefined);
});

test("registryChain keeps models above the tier capability floor and under the ceiling, ordered capability desc then cost", () => {
  const chain = registryChain({ tier: "standard", config: configWith(), routes: ROUTES, capability: CAP });
  // floor 35 / ceiling 3 → deepseek x2 (cap 39, median 2.70 & 2.73) in, mimo (23) out.
  assert.deepEqual(
    chain.map((t) => `${t.provider}/${t.model}`),
    ["deepseek/deepseek-flash", "openrouter/deepseek/deepseek-v4.1-flash"],
    "same capability → cheaper median first",
  );
});

test("registryChain respects the tier floor and ceiling (quick gets only the cheap model)", () => {
  const chain = registryChain({ tier: "quick", config: configWith(), routes: ROUTES, capability: CAP });
  assert.deepEqual(chain.map((t) => t.model), ["xiaomi/mimo-v2.6-flash"]);
  assert.deepEqual(registryChain({ tier: "premium", config: configWith(), routes: ROUTES, capability: CAP }), [], "no model clears the premium floor");
});

test("registryChain applies allowProviders/deny as before", () => {
  const chain = registryChain({ tier: "standard", config: configWith({ allowProviders: ["deepseek"] }), routes: ROUTES, capability: CAP });
  assert.deepEqual(chain.map((t) => t.provider), ["deepseek"]);
});

test("registryChain drops unrated models unless allowUnratedPicks is set", () => {
  const unrated = new Map<string, number>(); // no scores
  assert.deepEqual(registryChain({ tier: "quick", config: configWith(), routes: ROUTES, capability: unrated }), []);
  const chain = registryChain({ tier: "quick", config: configWith({ allowUnratedPicks: true }), routes: ROUTES, capability: unrated });
  assert.equal(chain.length, 1, "unrated models are last-resort candidates, cap -1");
  assert.equal(chain[0].model, "xiaomi/mimo-v2.6-flash");
});

test("registryChain drops routes with no priceable endpoint", () => {
  const routeNoPrice = route("openrouter", "x/noprice", "x/noprice", [ep("down", 0.01, 0.01, -2)]);
  const chain = registryChain({ tier: "standard", config: configWith(), routes: [routeNoPrice], capability: new Map([["x/noprice", 99]]) });
  assert.deepEqual(chain, []);
});

test("registryChain de-duplicates repeated registry slugs and caps the chain", () => {
  const dup = route("openrouter", "dup/model", "c/dup", [ep("x", 0, 0)]);
  const many = Array.from({ length: 30 }, (_, i) => route("openrouter", `m/m${i}`, `c/m${i}`, [ep("x", 0, 0)]));
  const cap = new Map<string, number>([["c/dup", 99], ...many.map((_, i) => [`c/m${i}`, 50] as [string, number])]);
  const chain = registryChain({ tier: "quick", config: configWith(), routes: [dup, dup, ...many], capability: cap });
  assert.equal(chain.length, 25, "the chain is capped to bound per-turn work");
  assert.equal(chain.filter((t) => t.model === "dup/model").length, 1, "repeated registry slugs collapse");
});

test("registryChain bounds unrated models so the tail is not a flood of free slugs", () => {
  const many = Array.from({ length: 10 }, (_, i) => route("openrouter", `u/u${i}`, `u/u${i}`, [ep("x", 0, 0)]));
  const chain = registryChain({ tier: "quick", config: configWith({ allowUnratedPicks: true }), routes: many, capability: new Map() });
  assert.equal(chain.length, 3, "default maxUnrated = 3");
});

test("a bounded preference reorders within the feasible set but cannot lift a model past a hard constraint", () => {
  const liked = registryChain({
    tier: "standard",
    config: configWith(),
    routes: ROUTES,
    capability: CAP,
    kind: "chat",
    preference: (_p, model) => (model === "deepseek/deepseek-v4.1-flash" ? 5 : 0),
  });
  assert.equal(liked[0].model, "deepseek/deepseek-v4.1-flash", "the liked route is promoted");

  const floored = registryChain({
    tier: "standard",
    config: configWith(),
    routes: ROUTES,
    capability: CAP,
    preference: (_p, model) => (model === "xiaomi/mimo-v2.6-flash" ? 50 : 0),
  });
  assert.ok(!floored.some((t) => t.model === "xiaomi/mimo-v2.6-flash"), "capability 23 < floor 35 stays out");
});
