// test/commands.test.ts — 整合測試：用真實 factory + 假 pi/ctx 跑命令與回合。
//
// 這支測試來自 2026-10-03 的實跑審查：單元測試全綠，但整合層有真 bug
// （無參數 /compass 失效、stickiness 永不命中、confirm 記帳錯亂…）。
// 這裡以真實事件接線固定行為：命令、回合、confirm yes/no、記帳。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface BootOptions {
  mode?: "auto" | "confirm" | "notify";
  confirm?: boolean;
}

/** 建一個獨立的 HOME（config 檔在裡面），再動態載入擴充——行程層級隔離。 */
async function boot(options: BootOptions = {}) {
  const home = mkdtempSync(join(tmpdir(), "compass-cmd-"));
  mkdirSync(join(home, ".pi/agent/pi-compass"), { recursive: true });
  writeFileSync(
    join(home, ".pi/agent/pi-compass/config.json"),
    JSON.stringify({
      mode: options.mode ?? "auto",
      enabled: true,
      decisionLog: true,
      useDefaultModels: false,
      classify: { provider: "laya", python: "/nonexistent/python" }, // 分類 fail-open → compose standard
      routes: {
        quick: [{ provider: "openrouter", model: "m0" }],
        standard: [{ provider: "openrouter", model: "m1" }],
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
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }> = {};
  const notices: Array<{ type: string; message: string }> = [];
  const appends: unknown[] = [];
  const setModels: string[] = [];

  const models: Record<string, unknown> = {
    "openrouter/m0": { provider: "openrouter", id: "m0", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
    "openrouter/m1": { provider: "openrouter", id: "m1", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
  };

  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers[event] = handler;
      return () => {};
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
      commands[name] = def;
    },
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry(_type: string, data: unknown) {
      appends.push(data);
    },
    async setModel(model: { provider: string; id: string }) {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel() {},
    getThinkingLevel() {
      return "off";
    },
  };

  const model = models["openrouter/m0"];
  const ctx = {
    model,
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
      confirm: async () => options.confirm ?? true,
    },
  };

  factory(pi as never);
  handlers["session_start"]({}, ctx);
  return {
    commands,
    handlers,
    ctx,
    notices,
    appends,
    setModels,
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function decisionLines(home: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(home, ".pi/agent/pi-compass/decisions.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

test("bare /compass shows status instead of 'unknown subcommand'", async () => {
  const { commands, ctx, notices, cleanup } = await boot();
  try {
    notices.length = 0;
    await commands["compass"].handler("", ctx);
    assert.ok(notices.length > 0, "notified");
    assert.ok(
      notices.every((n) => !n.message.includes("unknown subcommand")),
      `no unknown-subcommand: ${JSON.stringify(notices)}`,
    );
    assert.match(notices.map((n) => n.message).join("\n"), /compass:/, "status line shown");
  } finally {
    cleanup();
  }
});

test("/compass with an unknown subcommand still warns", async () => {
  const { commands, ctx, notices, cleanup } = await boot();
  try {
    notices.length = 0;
    await commands["compass"].handler("nonsense", ctx);
    assert.equal(notices[0]?.type, "warning");
    assert.match(notices[0]?.message ?? "", /unknown subcommand: nonsense/);
  } finally {
    cleanup();
  }
});

test("assistant usage is recorded into the spend ledger (W1)", async () => {
  const { handlers, home, cleanup } = await boot();
  try {
    handlers["message_end"]({ message: { role: "assistant", usage: { cost: { total: 0.25 } } } });
    handlers["message_end"]({ message: { role: "assistant", usage: { cost: { total: 0.75 } } } });
    handlers["message_end"]({ message: { role: "user" } });
    handlers["message_end"]({ message: { role: "assistant", usage: { cost: { total: 0 } } } });

    const state = JSON.parse(readFileSync(join(home, ".pi/agent/pi-compass/state.json"), "utf8"));
    assert.equal(state.todayUsd, 1.0, "assistant costs accumulate");
    assert.equal(state.monthUsd, 1.0);
  } finally {
    cleanup();
  }
});

test("a turn records exactly one entry, applies once, and marks the expected model (W7)", async () => {
  const { handlers, ctx, appends, setModels, home, cleanup } = await boot({ mode: "auto" });
  try {
    await handlers["before_agent_start"]({ prompt: "implement a streaming parser with tests" }, ctx);
    assert.deepEqual(setModels, ["openrouter/m1"], "switched to the standard chain");
    assert.equal(appends.length, 1, "exactly one entry per turn");

    // 下一輪：模擬模型已照我們切的在位 → 不該記成 manual-override。
    (ctx as { model: unknown }).model = { provider: "openrouter", id: "m1", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    await handlers["before_agent_start"]({ prompt: "continue implementing the parser now" }, ctx);
    const feedback = decisionLines(home).filter((r) => r.type === "feedback" && r.feedback === "manual-override");
    assert.deepEqual(feedback, [], "no spurious manual-override");
  } finally {
    cleanup();
  }
});

test("confirm yes produces one applied entry and switches (W7)", async () => {
  const { handlers, ctx, appends, setModels, home, cleanup } = await boot({ mode: "confirm", confirm: true });
  try {
    await handlers["before_agent_start"]({ prompt: "implement a streaming parser with tests" }, ctx);
    assert.deepEqual(setModels, ["openrouter/m1"], "confirm-yes switches");
    assert.equal(appends.length, 1, "single final entry");
    const entry = appends[0] as { symbol: string };
    assert.equal(entry.symbol, "→");
    const routes = decisionLines(home).filter((r) => r.type === "route");
    assert.equal(routes.length, 1, "single route record");
    assert.equal(routes[0].outcome, "applied");
  } finally {
    cleanup();
  }
});

test("confirm no writes exactly one cancelled entry and never switches (W7)", async () => {
  const { handlers, ctx, appends, setModels, home, cleanup } = await boot({ mode: "confirm", confirm: false });
  try {
    await handlers["before_agent_start"]({ prompt: "implement a streaming parser with tests" }, ctx);
    assert.deepEqual(setModels, [], "confirm-no never switches");
    assert.equal(appends.length, 1, "single final entry");
    const entry = appends[0] as { symbol: string; reason?: string };
    assert.equal(entry.symbol, "×");
    assert.match(String(entry.reason), /cancelled/);
    const routes = decisionLines(home).filter((r) => r.type === "route");
    assert.equal(routes.length, 1);
    assert.equal(routes[0].outcome, "cancelled", "the log records the user's decision, not applied");

    // 下一輪：模型仍在 m0（我們沒動）→ 不該出現 manual-override。
    await handlers["before_agent_start"]({ prompt: "continue implementing the parser now" }, ctx);
    const feedback = decisionLines(home).filter((r) => r.type === "feedback" && r.feedback === "manual-override");
    assert.deepEqual(feedback, [], "cancelled switch leaves the expected model untouched");
  } finally {
    cleanup();
  }
});
