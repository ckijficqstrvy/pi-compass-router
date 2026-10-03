// test/facts-refresh.test.ts — `/compass refresh-facts` 的純輔助（SPEC Part 10.1）。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  factsScriptPath,
  runFactsRefresh,
  summarizeRefresh,
} from "../extensions/pi-compass-router/ui/facts-refresh.js";

test("factsScriptPath points at the refresh-facts script", () => {
  // 測試經 esbuild bundle，import.meta.url 指向 build/，故只驗結尾語意（不驗實體存在）。
  assert.match(factsScriptPath(), /scripts\/refresh-facts\.mjs$/);
});

test("summarizeRefresh reports success with the last stdout line", () => {
  assert.deepEqual(summarizeRefresh(0, "line1\nupdated 3 prices\n\n", ""), {
    ok: true,
    message: "facts refreshed — updated 3 prices",
  });
  assert.deepEqual(summarizeRefresh(0, "", ""), { ok: true, message: "facts refreshed" });
});

test("summarizeRefresh reports failure with exit code and stderr tail", () => {
  const result = summarizeRefresh(2, "", "boom\nmore detail\n");
  assert.equal(result.ok, false);
  assert.match(result.message, /exit 2/);
  assert.match(result.message, /more detail/);
});

test("runFactsRefresh summarises an injected spawn and never throws", () => {
  const ok = (() => ({ status: 0, stdout: "done\n", stderr: "" })) as never;
  const okResult = runFactsRefresh(ok, "/nowhere/refresh-facts.mjs");
  assert.equal(okResult.ok, true);
  assert.match(okResult.message, /done/);

  const throwing = (() => {
    throw new Error("ENOENT");
  }) as never;
  const failed = runFactsRefresh(throwing, "/nowhere/refresh-facts.mjs");
  assert.equal(failed.ok, false);
  assert.match(failed.message, /ENOENT/);
});
