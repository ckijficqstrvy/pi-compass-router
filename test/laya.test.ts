// test/laya.test.ts — bridge 規約、崩潰重啟、fail-open、超時（SPEC Part 4.2、Part 12）。
//
// 用**假 python 腳本**（回固定 JSONL）驗證協定行為，不依賴真模型——
// 真延遲由 test/latency.ts 另驗（Part 4.2 橋接契約節）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { createLayaClassifier } from "../extensions/pi-compass-router/classify/laya.js";
import { ClassifyError } from "../extensions/pi-compass-router/classify/analysis.js";
import { DEFAULT_CONFIG } from "../extensions/pi-compass-router/schema.js";
import type { CompassConfig } from "../extensions/pi-compass-router/schema.js";

const dir = mkdtempSync(join(tmpdir(), "laya-test-"));

/**
 * 跑假 .py 腳本用的 python：優先用本機 laya venv，找不到就用 PATH 的 python3。
 * （不可硬編碼使用者家目錄路徑——那讓測試只能在作者機器上過，CI 終結此依賴。）
 */
const LOCAL_VENV_PYTHON = join(homedir(), ".pi", "agent", "pi-compass", "venv", "bin", "python");
const VENV_PYTHON = process.env.COMPASS_TEST_PYTHON ?? (existsSync(LOCAL_VENV_PYTHON) ? LOCAL_VENV_PYTHON : "python3");

function config(overrides: Partial<CompassConfig["classify"]> = {}): CompassConfig {
  return { ...DEFAULT_CONFIG, classify: { ...DEFAULT_CONFIG.classify, ...overrides } } as CompassConfig;
}

function fakeServer(body: string): string {
  const path = join(dir, `server-${Math.random().toString(36).slice(2)}.py`);
  writeFileSync(path, body);
  return path;
}

/** 假 server：啟動即 ready；收到請求回一筆合法 analysis（kind=chat）。 */
const OK = `import sys, json
print(json.dumps({"ready": True})); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    print(json.dumps({"id": req["id"], "analysis": {"answers": {
      "task_kind": {"type":"choice","confidence":0.9,"choice":"chat","action":{"act_probability":1.0},"probabilities":{"chat":0.9}},
      "complexity": {"type":"score","confidence":0.5,"score":1.0,"legend":{"0":"a","1":"b","2":"c","3":"d"},"action":{"act_probability":1.0},"probabilities":{"0":0.25,"1":0.25,"2":0.25,"3":0.25}},
      "capability_deserved": {"type":"score","confidence":0.5,"score":2.0,"legend":{"0":"a","1":"b","2":"c","3":"d"},"action":{"act_probability":1.0},"probabilities":{"0":0.25,"1":0.25,"2":0.25,"3":0.25}},
      "needs_deep_reasoning": {"type":"noul","confidence":0.2,"noul":0.2,"action":{"act_probability":1.0}},
      "thinking_level": {"type":"choice","confidence":0.7,"choice":"low","action":{"act_probability":1.0},"probabilities":{"low":0.7}}
    }, "usage": {"input_tokens": 5, "output_tokens": 0}}})); sys.stdout.flush()
`;

/** 每次請求回 error（協定層失敗）。 */
const ERROR_EVERY = `import sys, json
print(json.dumps({"ready": True})); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    print(json.dumps({"id": req["id"], "error": "model exploded"})); sys.stdout.flush()
`;

/** 超過 timeoutMs 才回（觸發逾時）。 */
const SLOW = `import sys, json, time
print(json.dumps({"ready": True})); sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    req = json.loads(line)
    time.sleep(2.0)
    print(json.dumps({"id": req["id"], "analysis": {"answers": {"task_kind": {"type":"choice","confidence":0.9,"choice":"chat","action":{"act_probability":1.0},"probabilities":{"chat":0.9}}}}})); sys.stdout.flush()
`;

const REQ = { request: "say hello", kinds: ["chat", "plan"] };

test.after?.(() => rmSync(dir, { recursive: true, force: true }));

test("a healthy fake server yields a parsed judgment (source=laya)", async () => {
  const clf = createLayaClassifier(config({ python: VENV_PYTHON }), fakeServer(OK));
  const j = await clf.classify(REQ, new AbortController().signal);
  assert.equal(j.source, "laya");
  assert.equal(j.kind, "chat");
  assert.ok(j.complexity !== undefined, "complexity parsed from the wire");
  clf.dispose?.();
});

test("the same request twice hits the classification cache", async () => {
  const clf = createLayaClassifier(config({ python: VENV_PYTHON }), fakeServer(OK));
  await clf.classify(REQ, new AbortController().signal);
  const second = await clf.classify(REQ, new AbortController().signal);
  assert.equal(second.cacheHit, true);
  assert.equal(second.source, "cache");
  clf.dispose?.();
});

test("a missing python marks the backend unavailable and fails fast (fail-open path)", async () => {
  const clf = createLayaClassifier(config({ python: "/nonexistent/python-bin" }));
  const first = await clf.classify(REQ, new AbortController().signal).catch((e: Error) => e);
  assert.ok(first instanceof ClassifyError && first.kind === "spawn", `got ${first}`);
  // 第二次應該同樣快速地 throw（不重試、不掛起——Part 6.3 fail-open 快路徑）。
  const second = await clf.classify(REQ, new AbortController().signal).catch((e: Error) => e);
  assert.ok(second instanceof ClassifyError, "still fails, not stuck");
  clf.dispose?.();
});

test("a per-request protocol error rejects without crashing the classifier", async () => {
  const clf = createLayaClassifier(config({ python: VENV_PYTHON }), fakeServer(ERROR_EVERY));
  const result = await clf.classify(REQ, new AbortController().signal).catch((e: Error) => e);
  assert.ok(result instanceof ClassifyError, `expected ClassifyError, got ${result}`);
  clf.dispose?.();
});

test("a request slower than timeoutMs rejects with a timeout, not a hang", async () => {
  const clf = createLayaClassifier(
    config({ python: VENV_PYTHON, timeoutMs: 300 }),
    fakeServer(SLOW),
  );
  const start = Date.now();
  const result = await clf.classify(REQ, new AbortController().signal).catch((e: Error) => e);
  const elapsed = Date.now() - start;
  assert.ok(result instanceof ClassifyError && result.kind === "timeout", `got ${result}`);
  assert.ok(elapsed < 1500, `timed out in ${elapsed}ms, should be near timeoutMs`);
  clf.dispose?.();
});

test("aborting the signal rejects the pending classify", async () => {
  const clf = createLayaClassifier(config({ python: VENV_PYTHON, timeoutMs: 5000 }), fakeServer(SLOW));
  const ctrl = new AbortController();
  const promise = clf.classify(REQ, ctrl.signal).catch((e: Error) => e);
  ctrl.abort();
  const result = await promise;
  assert.ok(result instanceof ClassifyError, `got ${result}`);
  clf.dispose?.();
});

test("dispose() never throws and can be called twice", () => {
  const clf = createLayaClassifier(config({ python: VENV_PYTHON }), fakeServer(OK));
  clf.dispose?.();
  clf.dispose?.();
});