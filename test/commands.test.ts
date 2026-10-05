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
  hasUI?: boolean;
  /** 設了就在 config 寫 prefer.standard=[id]，測 prefer 解析。 */
  prefer?: string;
  /** true = session 還沒有任何訊息（首則），測 continuation 不該觸發。 */
  firstMessage?: boolean;
  /** 額外寫進 config.json 的鍵（測警告顯示）。 */
  rawConfig?: Record<string, unknown>;
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
      ...(options.prefer ? { prefer: { standard: [options.prefer] } } : {}),
      ...(options.rawConfig ?? {}),
    }),
  );
  process.env.HOME = home;

  const { default: factory } = await import("../extensions/pi-compass-router/index.js");
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }> = {};
  const notices: Array<{ type: string; message: string }> = [];
  const appends: unknown[] = [];
  const setModels: string[] = [];
  const thinkings: string[] = [];
  const tools: Record<string, { execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }> }> = {};

  const models: Record<string, unknown> = {
    "openrouter/m0": { provider: "openrouter", id: "m0", cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0 } },
    "openrouter/m1": { provider: "openrouter", id: "m1", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
    // N2：模型 id 自帶 `/`（真實案例：xiaomi/mimo-v2.6-pro）；prefer 用裸 id 指到它。
    "openrouter/xiaomi/mimo": { provider: "openrouter", id: "xiaomi/mimo", cost: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 } },
  };

  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers[event] = handler;
      return () => {};
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
      commands[name] = def;
    },
    registerTool(def: { name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text?: string }> }> }) {
      tools[def.name] = def;
    },
    registerEntryRenderer() {},
    appendEntry(_type: string, data: unknown) {
      appends.push(data);
    },
    async setModel(model: { provider: string; id: string }) {
      setModels.push(`${model.provider}/${model.id}`);
      return true;
    },
    setThinkingLevel(level: string) {
      thinkings.push(level);
    },
    getThinkingLevel() {
      return thinkings[thinkings.length - 1] ?? "off";
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
    sessionManager: {
      getBranch: () =>
        options.firstMessage
          ? []
          : [{ type: "message", message: { role: "user", content: "earlier prompt" } }],
    },
    hasUI: options.hasUI ?? true,
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
    thinkings,
    tools,
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

test("/compass-route classifies the given text (and rejects empty input) (W12)", async () => {
  const { commands, ctx, notices, cleanup } = await boot();
  try {
    notices.length = 0;
    await commands["compass"].handler("", ctx); // 先熱一下狀態（與本測試無關）
    await commands["compass-route"].handler("refactor this module with tests", ctx);
    const preview = notices.map((n) => n.message).join("\n");
    assert.match(preview, /kind (fallback|\w+) · demand [\d.]+ · tier (quick|standard|high|premium|xpremium)/, preview);
    assert.match(preview, /→/, "shows a target or (no route available)");

    notices.length = 0;
    await commands["compass-route"].handler("   ", ctx);
    assert.match(notices[0]?.message ?? "", /expected some text/);
  } finally {
    cleanup();
  }
});

test("prefer with a slash-containing bare model id resolves and gets picked (N2/T2)", async () => {
  const { handlers, ctx, setModels, cleanup } = await boot({ prefer: "xiaomi/mimo" });
  try {
    await handlers["before_agent_start"]({ prompt: "implement a streaming parser with tests" }, ctx);
    assert.deepEqual(setModels, ["openrouter/xiaomi/mimo"], "the prefer head is actually selected");
  } finally {
    cleanup();
  }
});

test("a short prompt takes the continuation path through Stage 5 (T3)", async () => {
  const { handlers, ctx, appends, setModels, thinkings, cleanup } = await boot();
  try {
    await handlers["before_agent_start"]({ prompt: "ok" }, ctx);
    assert.equal(setModels.length, 0, "continuation never switches");
    assert.equal(appends.length, 1);
    const entry = appends[0] as { reason?: string; symbol?: string };
    assert.equal(entry.reason, "continuation");
    assert.equal(entry.symbol, "×");
    assert.equal(thinkings[thinkings.length - 1], "low", "skipped applies thinking (W10)");
  } finally {
    cleanup();
  }
});

test("a short FIRST prompt is classified, not skipped as a continuation", async () => {
  const { handlers, ctx, appends, setModels, cleanup } = await boot({ firstMessage: true });
  try {
    await handlers["before_agent_start"]({ prompt: "ok" }, ctx);
    const entry = appends[0] as { reason?: string };
    assert.notEqual(entry.reason, "continuation", "SPEC Stage 1: first message is never a continuation");
    assert.deepEqual(setModels, ["openrouter/m1"], "short first prompt still routes");
  } finally {
    cleanup();
  }
});

test("the route entry carries the demand/budget fields the display exposes (F3)", async () => {
  const { handlers, ctx, appends, cleanup } = await boot();
  try {
    await handlers["before_agent_start"]({ prompt: "implement a streaming parser with tests" }, ctx);
    const entry = appends[appends.length - 1] as { demand?: number; budgetPressure?: number };
    assert.equal(typeof entry.demand, "number");
    assert.equal(typeof entry.budgetPressure, "number");
  } finally {
    cleanup();
  }
});

test("config warnings are surfaced at session start (F1)", async () => {
  const { notices, cleanup } = await boot({ rawConfig: { totallyMadeUp: 1 } });
  try {
    assert.ok(
      notices.some((n) => n.type === "warning" && n.message.includes("totallyMadeUp")),
      JSON.stringify(notices),
    );
  } finally {
    cleanup();
  }
});

test("the compass_route tool classifies its text params (T4)", async () => {
  const { tools, cleanup } = await boot();
  try {
    const result = await tools["compass_route"].execute("id", { text: "refactor this module" });
    const text = result.content[0]?.text ?? "";
    assert.match(text, /kind (fallback|\w+) · demand [\d.]+ · tier (quick|standard|high|premium|xpremium)/, text);
  } finally {
    cleanup();
  }
});

test("confirm without UI is recorded as skipped, never as applied (N4)", async () => {
  const { handlers, ctx, appends, setModels, home, cleanup } = await boot({ mode: "confirm", hasUI: false });
  try {
    await handlers["before_agent_start"]({ prompt: "implement a streaming parser with tests" }, ctx);
    assert.equal(setModels.length, 0);
    assert.equal(appends.length, 1);
    const entry = appends[0] as { reason?: string };
    assert.match(String(entry.reason), /confirm required UI/);
    const routes = decisionLines(home).filter((r) => r.type === "route");
    assert.equal(routes[0]?.outcome, "skipped", "no phantom applied record");
  } finally {
    cleanup();
  }
});

test("/compass log shows recent decisions and the aggregate summary (D1/D2)", async () => {
  const { commands, handlers, ctx, notices, cleanup } = await boot({ mode: "auto" });
  try {
    await handlers["before_agent_start"]({ prompt: "implement a streaming parser with tests" }, ctx);
    notices.length = 0;
    await commands["compass"].handler("log", ctx);
    const text = notices.map((n) => n.message).join("\n");
    assert.match(text, /compass log · 最近/);
    assert.match(text, /統計 applied 1/);
    assert.match(text, /openrouter\/m1/);
  } finally {
    cleanup();
  }
});

test("/compass log with no records explains itself instead of erroring", async () => {
  const { commands, ctx, notices, cleanup } = await boot();
  try {
    notices.length = 0;
    await commands["compass"].handler("log", ctx);
    assert.match(notices[0]?.message ?? "", /沒有紀錄/);
  } finally {
    cleanup();
  }
});

test("an assistant turn writes a per-turn usage record (non-content) (2026-10-05)", async () => {
  const { handlers, home, cleanup } = await boot();
  try {
    handlers["message_end"]({
      message: {
        role: "assistant",
        provider: "openrouter",
        model: "m1",
        stopReason: "stop",
        usage: { input: 1000, output: 500, cacheRead: 100, cacheWrite: 0, cost: { total: 0.02 } },
      },
    });
    const usage = decisionLines(home).filter((r) => r.type === "usage");
    assert.equal(usage.length, 1, "exactly one usage record per assistant message");
    assert.equal(usage[0].model, "openrouter/m1");
    assert.equal(usage[0].input, 1000);
    assert.equal(usage[0].output, 500);
    assert.equal(usage[0].cacheRead, 100);
    assert.equal(usage[0].costUsd, 0.02);
    assert.equal(usage[0].ok, true);
    assert.ok(!/prompt|content|request/i.test(JSON.stringify(usage[0])), "no content-bearing fields");
  } finally {
    cleanup();
  }
});
