// health.ts — provider / model 健康狀態與錯誤分類（SPEC Part 8.4）。
//
// 問題（2026-10-04 實測）：擴充只監聽 4 個事件，`message_end` 只把
// assistant 成本記帳，完全忽略同一則訊息的 `provider` / `model` /
// `stopReason` / `errorMessage`。因此模型商 429、額度/付費失敗、5xx 之後，
// 下一輪 auto 路由仍可能再選同一個模型，畫面上也沒有任何說明。
//
// 這支模組提供兩件事：
//   1. `classifyModelError()` — 把 provider 錯誤字串收斂成可避開的類別
//      （context overflow 一律回 null：那是 pi 會自行壓縮重試，不是故障）。
//   2. `ModelHealth` — 每個 model（必要時整個 provider）的冷卻狀態，
//      含到期時間與可持久化的讀寫（best-effort、0600、只存非內容欄位）。
//
// 路由端只在 `deps.isAvailable` 查 `coolingReason()`，因此 `planTurn`
// 維持純函式，不需改簽名。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 可避開的錯誤類別。`context_overflow` 刻意不在其中（見檔頭）。 */
export type ModelErrorClass = "rate_limit" | "quota" | "auth" | "server" | "timeout";

/** 一次失敗標記（只含非內容欄位）。 */
export interface ModelFailure {
  /** `provider/model`，或整provider 的 `provider:<name>`。 */
  key: string;
  scope: "model" | "provider";
  klass: ModelErrorClass;
  /** 顯示用人類可讀原因。 */
  label: string;
  /** 冷卻到期時間（epoch ms）。 */
  until: number;
  /** 標記時間（epoch ms）。 */
  at: number;
}

/** 各類別的冷卻長度。額度/認證是帳號層級，需要人工處理，故較長。 */
export const COOLDOWN_MS: Readonly<Record<ModelErrorClass, number>> = {
  rate_limit: 60_000,
  quota: 30 * 60_000,
  auth: 360 * 60_000,
  server: 60_000,
  timeout: 30_000,
};

const LABELS: Readonly<Record<ModelErrorClass, string>> = {
  rate_limit: "rate limit (429)",
  quota: "quota / insufficient credits",
  auth: "authentication failed",
  server: "provider server error",
  timeout: "timeout / connection error",
};

/** 整帳號層級、需一併標記 provider 的類別。 */
const PROVIDER_WIDE: ReadonlySet<ModelErrorClass> = new Set(["quota", "auth"]);

/** 唯一的健康狀態檔（與 config/state/decisions 同目錄；呼叫時解析 HOME）。 */
export function healthFile(): string {
  return join(homedir(), ".pi", "agent", "pi-compass", "health.json");
}

// 判別順序刻意固定：context overflow 先排除，quota 先於 rate（「402 + rate」
// 少見但額度更嚴重），再依 5xx/認證/連線。全部用字界或明確狀態碼，避免
// 「5000 tokens」被當成 5xx。
const CONTEXT_OVERFLOW =
  /context[_ ]?length|context[_ ]?window|maximum context|too many tokens|max(imum)? tokens|ctx_len/i;
const QUOTA = /\b402\b|payment required|insufficient|out of (funds|credits)|quota|billing|no credits/i;
const RATE = /\b429\b|rate.?limit|too many requests|slow down/i;
const AUTH = /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid api key|authentication/i;
const SERVER = /\b5\d\d\b|overloaded|internal server|bad gateway|service unavailable|server error/i;
const TIMEOUT = /timeout|timed out|etimedout|econnreset|socket hang up|network error|fetch failed/i;

/**
 * 把 provider 的錯誤訊息/原始 stop reason 分類。
 * 回 `null` 表示「不該標記」（context overflow 或無法辨識）。
 */
export function classifyModelError(
  errorMessage: string | undefined,
  rawStopReason?: string,
): { klass: ModelErrorClass; label: string } | null {
  const text = `${errorMessage ?? ""} ${rawStopReason ?? ""}`;
  if (text.trim() === "") return null;
  if (CONTEXT_OVERFLOW.test(text)) return null; // pi 會壓縮後重試，非故障
  if (QUOTA.test(text)) return { klass: "quota", label: LABELS.quota };
  if (RATE.test(text)) return { klass: "rate_limit", label: LABELS.rate_limit };
  if (AUTH.test(text)) return { klass: "auth", label: LABELS.auth };
  if (SERVER.test(text)) return { klass: "server", label: LABELS.server };
  if (TIMEOUT.test(text)) return { klass: "timeout", label: LABELS.timeout };
  return null;
}

/**
 * 記憶體中的健康狀態；可序列化。查詢會自動清掉過期項（呼叫即 prune），
 * 因此呼叫端不需要手動清理。
 */
export class ModelHealth {
  private readonly entries = new Map<string, ModelFailure>();

  constructor(initial: readonly ModelFailure[] = []) {
    for (const entry of initial) this.entries.set(entry.key, entry);
  }

  private set(key: string, scope: ModelFailure["scope"], klass: ModelErrorClass, now: number): ModelFailure {
    const failure: ModelFailure = {
      key,
      scope,
      klass,
      label: LABELS[klass],
      until: now + COOLDOWN_MS[klass],
      at: now,
    };
    this.entries.set(key, failure);
    return failure;
  }

  /** 標記 `provider/model`，並在帳號層級錯誤時一併標記 provider。 */
  markFailure(provider: string, model: string, klass: ModelErrorClass, now = Date.now()): { model: ModelFailure; provider?: ModelFailure } {
    const modelFailure = this.set(`${provider}/${model}`, "model", klass, now);
    if (PROVIDER_WIDE.has(klass)) {
      return { model: modelFailure, provider: this.set(`provider:${provider}`, "provider", klass, now) };
    }
    return { model: modelFailure };
  }

  clearModel(provider: string, model: string): void {
    this.entries.delete(`${provider}/${model}`);
  }

  /** 清掉一個明確 key（`provider/model` 或 `provider:<name>`）。 */
  clear(key: string): void {
    this.entries.delete(key);
  }

  /** 回傳仍生效的標記；過期即刪除並回 `undefined`。 */
  get(key: string, now = Date.now()): ModelFailure | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.until <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  isCoolingDown(key: string, now = Date.now()): boolean {
    return this.get(key, now) !== undefined;
  }

  /** 生效中的標記（已 prune）。 */
  list(now = Date.now()): ModelFailure[] {
    this.prune(now);
    return [...this.entries.values()];
  }

  prune(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.until <= now) this.entries.delete(key);
    }
  }

  toJSON(): ModelFailure[] {
    return [...this.entries.values()];
  }
}

/**
 * 某候選是否處於冷卻；model 標記優先，其次整 provider 標記。
 * 這是路由端唯一需要的查詢（供 `deps.isAvailable`）。
 */
export function coolingReason(
  health: ModelHealth,
  provider: string,
  model: string,
  now = Date.now(),
): ModelFailure | undefined {
  return health.get(`${provider}/${model}`, now) ?? (provider ? health.get(`provider:${provider}`, now) : undefined);
}

/** 剩餘秒數（>= 0）。 */
export function remainingSeconds(failure: ModelFailure, now = Date.now()): number {
  return Math.max(0, Math.round((failure.until - now) / 1000));
}

/** 人類可讀時距：<90s 用秒，否則用分。 */
export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * 讀取健康狀態檔。**永不 throw**：檔案不存在/壞掉/位數不符一律回空。
 * 過期項在載入時即丟棄。
 */
export function loadHealth(file: string = healthFile(), now = Date.now()): ModelHealth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return new ModelHealth();
  }
  const entries =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries)
      ? ((parsed as { entries: unknown[] }).entries)
      : [];
  const valid = entries.filter((entry): entry is ModelFailure => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.key === "string" &&
      (e.scope === "model" || e.scope === "provider") &&
      typeof e.klass === "string" &&
      e.klass in COOLDOWN_MS &&
      typeof e.label === "string" &&
      typeof e.until === "number" &&
      Number.isFinite(e.until) &&
      e.until > now &&
      typeof e.at === "number"
    );
  });
  return new ModelHealth(valid);
}

/** 寫入健康狀態檔（best-effort、0600）。失敗不影響回合。 */
export function saveHealth(health: ModelHealth, file: string = healthFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ entries: health.toJSON() }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // best-effort：寫不進去也不能打斷回合。
  }
}
