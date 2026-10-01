#!/usr/bin/env node
/**
 * refresh-facts — 把 `extensions/pi-compass-router/model-facts.json` 與
 * pi 的即時 model catalogue 對齊。
 *
 * 自動化的部分（永遠不要手改）：
 *   · `price` — 從 catalogue 讀（`cost.input` / `cost.output`，USD / 百萬 token），
 *     使價格跟著 `pi update --models` 走，而不是有人抄數字。
 *   · 生命週期 — slug 已從 catalogue 消失的事實會被報告，catalogue 裡
 *     尚未進入 facts 的模型會列成候選。
 *
 * 保持手動的部分（地形變動時花五分鐘看一眼）：
 *   · `capability` — 綜合分數（Artificial Analysis intelligence index，
 *     對照 Terminal-Bench 與社群排行榜）。它是**模型**的屬性而非 provider 的，
 *     所以換 provider 不影響它。腳本永不猜分數；只報告哪些條目帶
 *     `estimated: true`、哪些模型還沒有分數。
 *
 * Usage: npm run refresh-facts [-- --dry-run] [-- --catalog <file>] [-- --facts <file>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");

let dryRun = false;
let catalogFile = join(agentDir, "models-store.json");
let factsFile = join(here, "..", "extensions", "pi-compass-router", "model-facts.json");
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--dry-run") dryRun = true;
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
const missing = [];
const estimated = [];

for (const fact of facts.models ?? []) {
  const match = byProviderModel.get(`${fact.provider}/${fact.model}`) ?? byId.get(fact.model);
  if (!match?.cost) {
    missing.push(`${fact.provider}/${fact.model}`);
    if (fact.estimated) estimated.push(`${fact.provider}/${fact.model}`);
    continue;
  }
  const next = { input: match.cost.input, output: match.cost.output };
  if (!samePrice(fact.price, next)) {
    priced.push(`${fact.provider}/${fact.model}: ${priceText(fact.price)} -> ${priceText(next)}`);
    fact.price = next;
  } else {
    kept.push(`${fact.provider}/${fact.model}`);
  }
  if (fact.estimated) estimated.push(`${fact.provider}/${fact.model}`);
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
  `prices auto-synced from pi's model catalogue by \`npm run refresh-facts\` on ${facts.generatedAt}.`;

if (!dryRun) {
  writeFileSync(factsFile, `${JSON.stringify(facts, null, 2)}\n`, "utf8");
}

console.log(`${dryRun ? "[dry run] " : ""}refreshed ${factsFile}`);
console.log(`catalogue: ${catalogFile} (${byId.size} models, ${byProviderModel.size} provider-scoped ids)`);
console.log(`\nprices updated (${priced.length}):`);
for (const line of priced) console.log(`  ${line}`);
if (priced.length === 0) console.log("  (already current)");
console.log(`\nprices unchanged: ${kept.length}`);
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