// classify/laya.ts — 本機分類 bridge（SPEC Part 4.2：JSONL over stdio、
// 無網路監聽、預熱、崩潰重啟、fail-open、不計費）。
//
// 橋接契約見 SPEC Part 4.2「橋接契約」節（2026-10-01 定）：
//   in : { id, state, questions }   out: { id, analysis } | { id, error } | { ready }
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildQuestions, ClassifyError, parseAnalysis } from "./analysis.js";
import { cacheKey, ClassificationCache, configGeneration } from "./cache.js";
import type { ClassifyInput, Classifier, Judgment } from "./types.js";
import type { CompassConfig } from "../schema.js";

/**
 * `laya-server.py` 的固定位置。
 *
 * 不用單純的 `import.meta.dirname`——打包器（esbuild/pi）會把本檔 bundle 到
 * 別的目錄（如 `build/smoke/`），`import.meta.dirname` 就指向 bundle 輸出而非
 * `classify/`。故**向上找到專案根**（含 `package.json` 與
 * `extensions/pi-compass-router/`），再取其下的 `classify/laya-server.py`；
 * 找不到就回退到同目錄（未打包的直接執行），讓 `existsSync` 報錯。
 */
function resolveServerPath(): string {
  let dir = import.meta.dirname;
  for (let up = 0; up < 8; up += 1) {
    const candidate = join(dir, "extensions", "pi-compass-router", "classify", "laya-server.py");
    if (existsSync(candidate)) return candidate;
    const local = join(dir, "laya-server.py");
    if (existsSync(local)) return local; // 已在 classify/ 目錄內（未打包）
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(import.meta.dirname, "laya-server.py"); // 回退：讓 existsSync 報錯
}

/** 連續失敗此數才標記不可用（Part 4.2）。 */
const UNAVAILABLE_AFTER = 3;

/** 展開 `~` 的使用者主目錄路徑。 */
function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/** 一筆待回應的請求。 */
interface Pending {
  resolve(judgment: Judgment): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  input: ClassifyInput;
  startedAt: number;
}

/**
 * 建立 laya 本機分類器（`classify.provider: "laya"`）。
 *
 * - 子行程 `spawn(python, [laya-server.py, model])`，**unref** 掛著（Part 4.2）。
 * - `warm()` 起行程並等 `{"ready":true}`（載入不佔首輪延遲）。
 * - 崩潰 → 下次呼叫重啟；**連續失敗 3 次** → `unavailable`，期間 `classify()`
 *   直接 throw `ClassifyError`（fail-open 快路徑，不重試，Part 6.3）。
 * - 每請求受 `classify.timeoutMs` 約束；逾時 throw，不掛起。
 * - **不計費**：laya 回應的 `usage` 不送入記帳（呼叫端不傳）。
 */
export function createLayaClassifier(
  config: CompassConfig,
  /** **僅供測試**覆寫 server 腳本路徑；生產與預設一律是 `laya-server.py`。 */
  serverPathOverride?: string,
): Classifier {
  const python = expandHome(config.classify.python);
  const cache = new ClassificationCache({
    enabled: config.classify.cache,
    ttlSeconds: config.classify.cacheTtlSeconds,
  });

  let child: ChildProcess | undefined;
  let stdoutBuffer = "";
  let unavailable = false;
  let consecutiveFailures = 0;
  const pending = new Map<string, Pending>();
  let nextId = 0;
  /** spawn 完成 + 收到 `{"ready":true}` 的共享 promise（warm 與首輪共用）。 */
  let readyPromise: Promise<void> | undefined;
  let resolveReady: (() => void) | undefined;

  function ensureChild(): ChildProcess {
    if (child && child.exitCode === null && child.signalCode === null) return child;

    if (!existsSync(python)) {
      unavailable = true;
      throw new ClassifyError(`laya python not found: ${python}`, "spawn");
    }
    const serverPath = serverPathOverride ?? resolveServerPath();
    if (!existsSync(serverPath)) {
      unavailable = true;
      throw new ClassifyError(`laya-server.py not found: ${serverPath}`, "spawn");
    }

    const proc = spawn(python, [serverPath, config.classify.model], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.unref(); // 不阻擋程序退出（Part 4.2）
    stdoutBuffer = "";
    readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) handleLine(line);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    proc.on("error", () => failAll(new ClassifyError("laya subprocess error", "spawn")));
    proc.on("exit", () => {
      child = undefined;
      failAll(new ClassifyError("laya subprocess exited", "spawn"));
    });

    child = proc;
    return proc;
  }

  function failAll(error: Error): void {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function handleLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // 非 JSON 行：忽略（不污染 pending）
    }

    if (message.ready === true) {
      resolveReady?.();
      resolveReady = undefined;
      if (message.load_error !== undefined) {
        unavailable = true;
        failAll(new ClassifyError(String(message.load_error), "spawn"));
      }
      return;
    }

    const id = typeof message.id === "string" ? message.id : undefined;
    if (id === undefined) return;
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);

    if (typeof message.error === "string") {
      noteFailure();
      entry.reject(new ClassifyError(message.error, "protocol"));
      return;
    }

    consecutiveFailures = 0;
    try {
      const judgment = parseAnalysis(message.analysis, Date.now() - entry.startedAt, {
        source: "laya",
        allowedKinds: entry.input.kinds,
        menuKeys: entry.input.menu,
      });
      cache.set(cacheKey(entry.input.request, generation, { conversation: entry.input.conversation, menu: entry.input.menu }), judgment);
      entry.resolve(judgment);
    } catch (error) {
      noteFailure();
      entry.reject(error instanceof Error ? error : new ClassifyError(String(error), "unusable"));
    }
  }

  function noteFailure(): void {
    consecutiveFailures += 1;
    if (consecutiveFailures >= UNAVAILABLE_AFTER) {
      unavailable = true;
      try {
        child?.kill();
      } catch {
        // kill 失敗不加重失敗
      }
      child = undefined;
    }
  }

  const generation = configGeneration(config.taskKinds, config.modelPick);

  async function classify(input: ClassifyInput, signal: AbortSignal): Promise<Judgment> {
    // 快取查（Part 6.2）——命中即回，標 cacheHit、latency 記查詢耗時。
    const hitStart = Date.now();
    const hit = cache.get(cacheKey(input.request, generation, { conversation: input.conversation, menu: input.menu }), Date.now() - hitStart);
    if (hit) return hit;

    if (unavailable) {
      throw new ClassifyError("laya backend unavailable (repeated failures)", "spawn");
    }
    if (signal.aborted) throw new ClassifyError("aborted before classify", "timeout");

    let proc: ChildProcess;
    try {
      proc = ensureChild();
    } catch (error) {
      noteFailure();
      throw error;
    }

    // 等就緒（spawn + {"ready"}）——模型載入不計入 per-classify 預算
    // （Part 6.1：載入歸預熱，首輪延遲另計）。就緒後才啟動逾時時鐘。
    if (readyPromise) {
      const warmBudget = Math.max(config.classify.timeoutMs, 30_000);
      const timedOut = await Promise.race([
        readyPromise.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), warmBudget)),
      ]);
      if (timedOut) {
        noteFailure();
        throw new ClassifyError(`laya warm-up timed out after ${warmBudget}ms`, "timeout");
      }
    }
    if (unavailable) throw new ClassifyError("laya backend unavailable", "spawn");
    // 等待期間可能已被 abort（listener 尚未掛上）——重查，不把已取消的請求送出去。
    if (signal.aborted) throw new ClassifyError("classify aborted", "timeout");

    const id = String(nextId++);
    const startedAt = Date.now();
    const questions = buildQuestions(input.kinds, input.menu);

    return new Promise<Judgment>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        noteFailure();
        reject(new ClassifyError(`classify timed out after ${config.classify.timeoutMs}ms`, "timeout"));
      }, config.classify.timeoutMs);

      const onAbort = (): void => {
        pending.delete(id);
        clearTimeout(timer);
        reject(new ClassifyError("classify aborted", "timeout"));
      };
      signal.addEventListener("abort", onAbort, { once: true });

      pending.set(id, {
        resolve: (judgment) => {
          signal.removeEventListener("abort", onAbort);
          resolve(judgment);
        },
        reject: (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
        timer,
        input,
        startedAt,
      });

      try {
        // Part 4.4：payload 僅 request 與 conversation（有歷史時接在請求前）。
        const state = input.conversation ? `${input.conversation}\n\n${input.request}` : input.request;
        const payload = JSON.stringify({ id, state, questions });
        proc.stdin?.write(`${payload}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        noteFailure();
        reject(error instanceof Error ? error : new ClassifyError(String(error), "spawn"));
      }
    });
  }

  return {
    id: "laya",
    classify,
    warm() {
      try {
        ensureChild();
      } catch {
        // 預熱失敗不 throw——首次 classify 會再試並 fail-open。
      }
    },
    dispose() {
      try {
        child?.kill();
      } catch {
        // dispose 永不 throw
      }
      child = undefined;
      failAll(new ClassifyError("disposed", "spawn"));
    },
  };
}