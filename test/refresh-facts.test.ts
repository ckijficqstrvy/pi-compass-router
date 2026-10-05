import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * refresh-facts 的價格決策回歸測試（2026-10-05）。
 *
 * 背景：實測同一支腳本會因為 OpenRouter API 時好時壞，把
 * `openrouter/deepseek/deepseek-v4.1-flash` 在 API 價（$0.003/$2.4）與 pi
 * catalogue 價（$0.3/$1.2）之間來回改寫，price-band 也跟著飄。修正後：
 * API 取不到時保留既存價格，只有「事實還沒有價格」才用 catalogue 填。
 *
 * `--no-api` 讓腳本跳過網路，測試因此決定性。
 */
const SCRIPT = join(process.cwd(), "scripts", "refresh-facts.mjs");

interface Fact {
  provider: string;
  model: string;
  capability: number;
  price?: { input: number; output: number };
  estimated?: boolean;
}

function runRefresh(catalog: unknown, facts: Fact[]): { out: string; written: { models: Fact[] } } {
  const dir = mkdtempSync(join(tmpdir(), "compass-refresh-"));
  try {
    const catalogFile = join(dir, "catalog.json");
    const factsFile = join(dir, "facts.json");
    writeFileSync(catalogFile, JSON.stringify(catalog));
    writeFileSync(factsFile, JSON.stringify({ generatedAt: "2026-01-01", source: "fixture", models: facts }));
    const out = execFileSync(process.execPath, [SCRIPT, "--no-api", "--catalog", catalogFile, "--facts", factsFile], {
      encoding: "utf8",
    });
    return { out, written: JSON.parse(readFileSync(factsFile, "utf8")) as { models: Fact[] } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("refresh-facts keeps an existing price when the OpenRouter API price is unavailable", () => {
  const { out, written } = runRefresh(
    { openrouter: { models: [{ id: "a/model", provider: "openrouter", cost: { input: 9, output: 9 } }] } },
    [{ provider: "openrouter", model: "a/model", capability: 10, price: { input: 1, output: 2 } }],
  );
  assert.deepEqual(
    written.models[0].price,
    { input: 1, output: 2 },
    "API 取不到時不得用 catalogue 快照覆蓋既存價格",
  );
  assert.match(out, /retained/);
});

test("refresh-facts fills a missing price from the catalogue", () => {
  const { written } = runRefresh(
    { openrouter: { models: [{ id: "b/model", provider: "openrouter", cost: { input: 3, output: 4 } }] } },
    [{ provider: "openrouter", model: "b/model", capability: 10 }],
  );
  assert.deepEqual(written.models[0].price, { input: 3, output: 4 }, "沒有價格的事實才由 catalogue 填坑");
});

test("refresh-facts reports a fact with no price and no catalogue match as missing, and keeps it", () => {
  const { out, written } = runRefresh({}, [{ provider: "ghost", model: "ghost/model", capability: 5 }]);
  assert.equal(written.models.length, 1, "缺價事實不會被刪除");
  assert.equal(written.models[0].price, undefined);
  assert.match(out, /not in catalogue/);
  assert.match(out, /ghost\/ghost\/model/);
});
