// test/latency.ts — laya 後端延遲量測（SPEC Part 12、驗收 4：p95 < 80ms）。
//
// 跑真模型（classify.model 預設 checkpoint），量端到端 classify 延遲（含
// JSONL 往返與橋行程式開銷）。**不含**首輪模型載入（Part 6.1：載入歸預熱）。
// 用法：node --test 不適用（這是腳本，非 test 檔）——直接執行：
//   npx esbuild test/latency.ts --bundle --packages=external --platform=node \
//     --format=esm --outdir=build/latency && node build/latency/latency.js
import { createLayaClassifier } from "../extensions/pi-compass-router/classify/laya.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";

const RUNS = 20;
const KINDS = ["plan", "review", "implement", "debug", "research", "chat"] as const;
const PROMPTS = [
  "refactor the database layer to use connection pooling instead of per-request connections",
  "why does this unit test fail with a timeout when run in parallel?",
  "plan a migration from REST to GraphQL for the public API",
  "explain what this regex does: ^(?=.*\\d)(?=.*[a-z]).{8,}$",
  "review this diff for security issues around SQL injection",
  "say hello to the team",
  "add retry with exponential backoff to the HTTP client",
  "research the tradeoffs between event sourcing and CRUD for an audit log",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function main(): Promise<void> {
  const config = {
    ...DEFAULT_CONFIG,
    classify: { ...DEFAULT_CONFIG.classify },
  } as typeof DEFAULT_CONFIG;

  const clf = createLayaClassifier(config);
  clf.warm?.();

  // 首輪（模型載入）單獨記，不計入 p95。
  const warmStart = Date.now();
  await clf.classify({ request: PROMPTS[0], kinds: [...KINDS] }, new AbortController().signal);
  const warmMs = Date.now() - warmStart;

  const samples: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const prompt = PROMPTS[i % PROMPTS.length];
    const started = Date.now();
    await clf.classify({ request: `${prompt} (run ${i})`, kinds: [...KINDS] }, new AbortController().signal);
    samples.push(Date.now() - started);
  }

  clf.dispose?.();

  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const max = samples[samples.length - 1];

  console.log(`warm (model load, excluded): ${warmMs}ms`);
  console.log(`classify n=${samples.length}  p50=${p50}ms  p95=${p95}ms  max=${max}ms`);
  console.log(`samples: ${samples.join(", ")}`);

  if (p95 < 80) {
    console.log(`PASS  p95 ${p95}ms < 80ms (acceptance 4)`);
    process.exit(0);
  } else {
    console.log(`FAIL  p95 ${p95}ms >= 80ms (acceptance 4)`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error("latency measurement failed:", error);
  process.exit(1);
});