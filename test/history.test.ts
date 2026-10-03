// test/history.test.ts — 對話歷史擷取（W6）。
import { test } from "node:test";
import assert from "node:assert/strict";

import { conversationText, CONVERSATION_MAX_CHARS } from "../extensions/pi-compass-router/classify/history.js";

const msg = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

test("turns <= 0 sends nothing", () => {
  assert.equal(conversationText([msg("user", "hi")], 0), undefined);
  assert.equal(conversationText([msg("user", "hi")], -1), undefined);
});

test("only user/assistant text is kept; tool blocks are ignored", () => {
  const entries = [
    msg("system", "ignored"),
    msg("user", "first question"),
    msg("assistant", [{ type: "text", text: "answer text" }, { type: "toolCall", name: "x" }]),
    { type: "custom", message: { role: "user", content: "ignored" } },
  ];
  assert.equal(conversationText(entries, 4), "user: first question\nassistant: answer text");
});

test("keeps only the last N turns and caps from the tail", () => {
  const entries = [msg("user", "a".repeat(50)), msg("assistant", "b".repeat(50)), msg("user", "latest")];
  const text = conversationText(entries, 1, 20) ?? "";
  assert.ok(text.length <= 20, "capped");
  assert.ok(text.endsWith("latest"), "most recent content survives the cap");
});

test("default cap is 4000 characters", () => {
  const entries = [msg("user", "x".repeat(5000))];
  const text = conversationText(entries, 1) ?? "";
  assert.equal(text.length, CONVERSATION_MAX_CHARS);
});
