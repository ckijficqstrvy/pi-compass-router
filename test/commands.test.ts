// test/commands.test.ts — 整合測試：用真實 factory + 假 pi/ctx 跑命令。
//
// 這支測試來自 2026-10-03 的實跑審查：單元測試全綠，但整合層有三個真 bug
// （無參數 /compass 失效、stickiness 永不命中、/compass why 名不副實）。
// 這裡固定最容易回歸的一個：無參數 /compass 必須顯示狀態。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 建一個獨立的 HOME（config 檔在裡面），再動態載入擴充——行程層級隔離。 */
async function boot() {
  const home = mkdtempSync(join(tmpdir(), "compass-cmd-"));
  mkdirSync(join(home, ".pi/agent/pi-compass"), { recursive: true });
  writeFileSync(
    join(home, ".pi/agent/pi-compass/config.json"),
    JSON.stringify({ mode: "auto", enabled: true, decisionLog: false }),
  );
  process.env.HOME = home;

  const { default: factory } = await import("../extensions/pi-compass-router/index.js");
  const handlers: Record<string, Function> = {};
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }> = {};
  const notices: Array<{ type: string; message: string }> = [];

  const pi = {
    on(event: string, handler: Function) {
      handlers[event] = handler;
      return () => {};
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<unknown> }) {
      commands[name] = def;
    },
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry() {},
    async setModel() {
      return true;
    },
    setThinkingLevel() {},
    getThinkingLevel() {
      return "off";
    },
  };

  const model = { provider: "openrouter", id: "m1", cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 } };
  const ctx = {
    model,
    modelRegistry: { find: (p: string, id: string) => (p === "openrouter" && id === "m1" ? model : undefined) },
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
  return { commands, ctx, notices, cleanup: () => rmSync(home, { recursive: true, force: true }) };
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
