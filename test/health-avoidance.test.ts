// Integration: a provider failure at message_end must cool the model down and
// make the next auto route pick another candidate, with an on-screen reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function boot() {
  const home = mkdtempSync(join(tmpdir(), "compass-health-int-"));
  mkdirSync(join(home, ".pi/agent/pi-compass"), { recursive: true });
  writeFileSync(
    join(home, ".pi/agent/pi-compass/config.json"),
    JSON.stringify({
      mode: "auto",
      enabled: true,
      useDefaultModels: false,
      classify: { provider: "laya", python: "/nonexistent/python" },
      routes: {
        quick: [],
        standard: [
          { provider: "openrouter", model: "m2" },
          { provider: "openrouter", model: "m1" },
        ],
        high: [],
        premium: [],
        xpremium: [],
      },
      kindModels: {},
    }),
  );
  process.env.HOME = home;

  const { default: factory } = await import("../extensions/pi-compass-router/index.js");
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const notices: Array<{ type: string; message: string }> = [];
  const appends: Array<Record<string, unknown>> = [];
  const setModels: string[] = [];

  const models: Record<string, unknown> = {
    "openrouter/m0": { provider: "openrouter", id: "m0", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
    "openrouter/m1": { provider: "openrouter", id: "m1", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
    "openrouter/m2": { provider: "openrouter", id: "m2", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
  };

  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers[event] = handler;
      return () => {};
    },
    registerCommand() {},
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry(_type: string, data: Record<string, unknown>) {
      appends.push(data);
    },
    async setModel(model: { provider: string; id: string }) {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel() {},
    getThinkingLevel() {
      return "low";
    },
  };

  const ctx = {
    model: models["openrouter/m0"],
    modelRegistry: {
      find: (p: string, id: string) => models[`${p}/${id}`],
      getAll: () => Object.values(models),
    },
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 1 }),
    hasUI: true,
    mode: "tui",
    signal: new AbortController().signal,
    cwd: process.cwd(),
    ui: {
      notify: (message: string, type?: string) => notices.push({ type: type ?? "info", message }),
      select: async () => null,
      input: async () => null,
      confirm: async () => true,
    },
  };

  factory(pi as never);
  handlers["session_start"]({}, ctx);
  return { handlers, ctx, notices, appends, setModels, home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function failedTurn(provider: string, model: string, errorMessage: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      provider,
      model,
      content: [],
      stopReason: "error",
      errorMessage,
      usage: { cost: { total: 0.01 } },
    },
  };
}

function okTurn(provider: string, model: string) {
  return {
    type: "message_end",
    message: { role: "assistant", provider, model, content: [], stopReason: "stop", usage: { cost: { total: 0 } } },
  };
}

test("a rate-limit failure is explained and the next route avoids that model", async () => {
  const { handlers, ctx, notices, appends, setModels, home, cleanup } = await boot();
  try {
    notices.length = 0;
    handlers["message_end"](failedTurn("openrouter", "m2", "HTTP 429 Too Many Requests"), ctx);

    assert.ok(
      notices.some((n) => n.type === "warning" && n.message.includes("openrouter/m2 failed (rate limit (429))")),
      "the failure is explained in the UI",
    );
    assert.ok(
      appends.some((entry) => typeof entry.reason === "string" && entry.reason.includes("failed (rate limit (429))")),
      "a transcript entry explains the failure",
    );
    const health = JSON.parse(readFileSync(join(home, ".pi/agent/pi-compass/health.json"), "utf8"));
    assert.equal(health.entries[0].key, "openrouter/m2", "health state is persisted");

    setModels.length = 0;
    appends.length = 0;
    notices.length = 0;
    await handlers["before_agent_start"]({ prompt: "implement a resilient rate limiter in typescript" }, ctx);

    assert.deepEqual(setModels, ["openrouter/m1"], "the cooling-down m2 is skipped");
    assert.ok(
      appends.some(
        (entry) =>
          Array.isArray(entry.notes) &&
          entry.notes.some((note) => typeof note === "string" && note.includes("avoiding unhealthy: openrouter/m2")),
      ),
      "the route entry says why m2 was skipped",
    );
  } finally {
    cleanup();
  }
});

test("a quota failure cools the whole provider", async () => {
  const { handlers, ctx, notices, cleanup } = await boot();
  try {
    handlers["message_end"](failedTurn("openrouter", "m1", "402 Payment Required: insufficient credits"), ctx);
    assert.ok(
      notices.some((n) => n.message.includes("provider openrouter failed (quota / insufficient credits)")),
      "account-wide failures name the provider",
    );
  } finally {
    cleanup();
  }
});

test("a successful turn clears the cooldown and the model is routable again", async () => {
  const { handlers, ctx, setModels, cleanup } = await boot();
  try {
    handlers["message_end"](failedTurn("openrouter", "m2", "HTTP 429 Too Many Requests"), ctx);
    handlers["message_end"](okTurn("openrouter", "m2"), ctx);

    setModels.length = 0;
    await handlers["before_agent_start"]({ prompt: "implement a resilient rate limiter in typescript" }, ctx);
    assert.deepEqual(setModels, ["openrouter/m2"], "once healthy again, the preferred model is used");
  } finally {
    cleanup();
  }
});
