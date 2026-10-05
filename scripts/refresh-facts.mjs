#!/usr/bin/env node
/**
 * refresh-facts — 把 `extensions/pi-compass-router/model-facts.json` 與
 * pi 的即時 model catalogue 對齊。
 *
 * 自動化的部分（永遠不要手改）：
 *   · `price` — **OpenRouter 公開 API 優先**（`GET /api/v1/models` 的
 *     `pricing.prompt/completion`，USD/token → USD/M）；取不到時**保留既存價格**
 *     （不拿 pi catalogue 的舊快照覆蓋，避免價格在兩者間來回跳、讓 band 飄移）；
 *     只有在事實還沒有價格時才用 pi catalogue（`cost.input` / `cost.output`）填坑。
 *     讓價格即時且不靠人抄。
 *   · 生命週期 — slug 已從 catalogue 消失的事實會被報告，catalogue 裡
 *     尚未進入 facts 的模型會列成候選。
 *
 * 保持手動的部分（地形變動時花五分鐘看一眼）：
 *   · `capability` — 綜合分數（Artificial Analysis intelligence index，
 *     對照 Terminal-Bench 與社群排行榜）。它是**模型**的屬性而非 provider 的，
 *     所以換 provider 不影響它。腳本永不猜分數；只報告哪些條目帶
 *     `estimated: true`、哪些模型還沒有分數。
 *
 * Usage: npm run refresh-facts [-- --dry-run] [-- --no-api] [-- --catalog <file>] [-- --facts <file>]
 *   `--no-api` 跳過 OpenRouter API（測試／離線；只走保留與 catalogue 兩條路徑）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

let dryRun = false;
let noApi = false;
let catalogFile = join(agentDir, "models-store.json");
let factsFile = join(here, "..", "extensions", "pi-compass-router", "model-facts.json");
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--dry-run") dryRun = true;
  else if (arg === "--no-api") noApi = true;
  else if (arg === "--catalog") catalogFile = process.argv[++i];
  else if (arg === "--facts") factsFile = process.argv[++i];
  else {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`);
    process.exit(1);
  }
};

const catalog = readJson(catalogFile);
const facts = readJson(factsFile);

// 價格來源 1：OpenRouter 公開 API（免金鑰）。失敗 → 空 map，落回既有價/catalogue。
// `--no-api` 跳過網路（測試與離線用）。
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const apiPrices = new Map();
let apiSource = "OpenRouter API";
/** USD/M 取到小數 6 位（per-token 價格 ×1e6 會有浮點雜訊）。 */
const round6 = (n) => Math.round(n * 1e6) / 1e6;
if (noApi) {
  apiSource = "skipped (--no-api)";
} else {
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    for (const entry of payload?.data ?? []) {
      if (typeof entry?.id !== "string" || entry.id.includes(":batch")) continue;
      const input = round6(Number(entry?.pricing?.prompt) * 1e6);
      const output = round6(Number(entry?.pricing?.completion) * 1e6);
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      apiPrices.set(`openrouter/${entry.id}`, { input, output });
    }
  } catch (error) {
    apiSource = `pi catalogue（OpenRouter API 連線失敗：${String(error).slice(0, 60)}）`;
  }
}

/** 攤平目錄：`{ providerKey: { models: [...] } }` → 查找表。 */
const byProviderModel = new Map();
const byId = new Map();
for (const [providerKey, providerValue] of Object.entries(catalog)) {
  for (const model of providerValue?.models ?? []) {
    if (!model?.id) continue;
    const entry = {
      provider: model.provider || providerKey,
      id: model.id,
      name: model.name,
      cost: model.cost,
      contextWindow: model.contextWindow,
    };
    byProviderModel.set(`${entry.provider}/${entry.id}`, entry);
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }
}

const usd = (value) => (value === undefined ? "?" : `$${value}`);
const priceText = (price) => (price ? `${usd(price.input)}/${usd(price.output)}` : "(none)");
const samePrice = (a, b) => !!a && !!b && a.input === b.input && a.output === b.output;

const priced = [];
const kept = [];
const retained = [];
const missing = [];
const estimated = [];
let apiUsed = 0;
let catalogUsed = 0;

for (const fact of facts.models ?? []) {
  const key = `${fact.provider}/${fact.model}`;
  const match = byProviderModel.get(key) ?? byId.get(fact.model);
  const fromApi = apiPrices.get(key);

  // 價格優先序：OpenRouter API > 既存事實價 > catalogue 快照。
  // API 抓不到時**絕不用 catalogue 覆蓋已存在的價格**：catalogue 對 openrouter
  // slug 可能是原生/過期價（實測 v4.1-flash API $0.003/$2.4 vs catalogue $0.3/$1.2），
  // 覆蓋會讓價格在兩者間來回跳、連帶讓 price-band 飄移（2026-10-05）。
  let next = fromApi;
  let via = fromApi ? "api" : null;
  if (!next && fact.price) {
    next = fact.price;
    via = "retained";
  }
  if (!next && match?.cost) {
    next = { input: match.cost.input, output: match.cost.output };
    via = "catalogue";
  }
  if (!next) {
    missing.push(key);
    if (fact.estimated) estimated.push(key);
    continue;
  }
  if (via === "api") apiUsed += 1;
  else if (via === "catalogue") catalogUsed += 1;
  else retained.push(key);
  if (!samePrice(fact.price, next)) {
    priced.push(`${key}: ${priceText(fact.price)} -> ${priceText(next)}`);
    fact.price = next;
  } else {
    kept.push(key);
  }
  if (fact.estimated) estimated.push(key);
}

// S1b（2026-10-05）：抓 OpenRouter 每個模型的 endpoint（多上游）報價 — 同一模型可有
// 數十個上游、價差數十倍（實測 deepseek-v4.1-flash 30 個）。快取寫到 agent 目錄，
// 供 route 層決策時取「最便宜且健康的 endpoint」；抓不到就略過（不動 facts）。
const endpoints = {};
async function fetchEndpoints(modelId) {
  const response = await fetch(`${OPENROUTER_MODELS_URL}/${modelId}/endpoints`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const list = Array.isArray(payload?.data?.endpoints) ? payload.data.endpoints : [];
  return list
    .map((e) => ({
      upstream: typeof e?.provider_name === "string" ? e.provider_name : "unknown",
      input: round6(Number(e?.pricing?.prompt) * 1e6),
      output: round6(Number(e?.pricing?.completion) * 1e6),
      contextWindow: typeof e?.context_length === "number" ? e.context_length : undefined,
      status: typeof e?.status === "number" ? e.status : undefined,
    }))
    .filter((q) => Number.isFinite(q.input) && Number.isFinite(q.output));
}
/** 有限併發 map（避免一次打數十個請求）。 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
if (!noApi) {
  const ids = (facts.models ?? []).filter((f) => f.provider === "openrouter").map((f) => f.model);
  const results = await mapPool(ids, 4, async (id) => {
    try {
      return [id, await fetchEndpoints(id)];
    } catch {
      return [id, null];
    }
  });
  for (const [id, quotes] of results) {
    if (quotes && quotes.length > 0) endpoints[`openrouter/${id}`] = quotes;
  }
}

// 候選：catalogue 裡定價合理、但 facts 還沒描述的模型。
const knownIds = new Set((facts.models ?? []).map((f) => f.model));
const sanePrice = (cost) =>
  Number.isFinite(cost?.input) &&
  Number.isFinite(cost?.output) &&
  cost.input >= 0 &&
  cost.output >= 0 &&
  cost.input < 1000 &&
  cost.output < 1000;
const candidates = [...byId.values()]
  .filter((m) => sanePrice(m.cost) && !knownIds.has(m.id))
  .sort((a, b) => a.cost.input + 2 * a.cost.output - (b.cost.input + 2 * b.cost.output));

facts.generatedAt = new Date().toISOString().slice(0, 10);
facts.source =
  `capability: manual scores (AA intelligence index / Terminal-Bench cross-check), never auto-guessed; ` +
  `prices auto-synced by \`npm run refresh-facts\` from OpenRouter API (fallback: pi model catalogue) on ${facts.generatedAt}.`;

if (!dryRun) {
  writeFileSync(factsFile, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
  if (Object.keys(endpoints).length > 0) {
    const cacheFile = join(agentDir, "pi-compass", "openrouter-endpoints.json");
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(
        cacheFile,
        `${JSON.stringify({ generatedAt: facts.generatedAt, source: "OpenRouter /api/v1/models/{id}/endpoints", routes: endpoints }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch {
      // best-effort：快取寫不進去不能讓 refresh 失敗。
    }
  }
}

console.log(`${dryRun ? "[dry run] " : ""}refreshed ${factsFile}`);
console.log(`catalogue: ${catalogFile} (${byId.size} models, ${byProviderModel.size} provider-scoped ids)`);
console.log(`price source: ${apiSource}（API ${apiUsed} 筆 / catalogue ${catalogUsed} 筆）`);
console.log(`\nprices updated (${priced.length}):`);
for (const line of priced) console.log(`  ${line}`);
if (priced.length === 0) console.log("  (already current)");
console.log(`\nprices unchanged: ${kept.length}`);
console.log(`  of which retained without an OpenRouter API price (kept the existing value): ${retained.length}`);
for (const line of retained) console.log(`    ${line}`);
console.log(`\nendpoint quotes cached: ${Object.keys(endpoints).length} model(s)`);
console.log(`\nnot in catalogue — check the slug (${missing.length}):`);
for (const line of missing) console.log(`  ${line}`);
if (missing.length === 0) console.log("  (none)");
console.log(`\ncapability scores marked estimated — worth a manual check (${estimated.length}):`);
for (const line of estimated) console.log(`  ${line}`);
if (estimated.length === 0) console.log("  (none)");
console.log(
  `\ncatalogue models not in facts (${candidates.length}) — add promising ones with a capability score:\n` +
    `  score sources: artificialanalysis.ai/leaderboards/models · openrouter.ai/rankings · Terminal-Bench\n` +
    candidates
      .slice(0, 15)
      .map((m) => `  ${m.provider}/${m.id} — ${priceText({ input: m.cost.input, output: m.cost.output })} per 1M`)
      .join("\n") +
    (candidates.length > 15 ? `\n  … and ${candidates.length - 15} more` : ""),
);