// credits.ts — provider 餘額閘（餘額 < 0 的 provider 不再進候選）。
//
// 問題（2026-10-06 實測）：OpenRouter 餘額見底（甚至略負）時，任何需要預借
// max_tokens 的請求都會回 402「…but can only afford N」。health.ts 的
// classifyModelError 會把這句歸為 `credit_cap`（單一 model、5 分鐘冷卻），
// 因為它假設「帳號還有錢，只是這次預借太大」。餘額真的 <= 0 時這個假設不成立：
// 5 分鐘後 compass 又選同一個 provider，於是每 5 分鐘循環失敗一次。
//
// 這支模組把「provider 餘額」變成路由前的硬事實：呼叫端在
// `deps.isAvailable` 讀 last-known 餘額，< 0 的 provider 整批候選視為不可用。
// 探測本身是**非阻塞**的（fail-open、永不 throw、永不擋住回合），由 index.ts
// 在 session 開始與每輪前 best-effort 刷新，只有過期時才真的打 API。
//
// 為什麼是 provider 層而非 model 層：402 的 credit_cap 是 model 冷卻，治不了
// 「帳號沒錢」這個 provider 層事實；這裡刻意做成 provider-wide。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { acquireLock, releaseLock } from "./lock.js";

/** 一次餘額探測的結果（只含非內容欄位）。 */
export interface ProviderBalance {
  /** provider 名（`openrouter`）。 */
  provider: string;
  /** `total_credits - total_usage`（USD；可為負）。 */
  remainingUsd: number;
  /** 探測時間（epoch ms）。 */
  checkedAt: number;
  /** 資料來源（診斷用）。 */
  source: string;
}

/** 記憶體中的餘額快取；可序列化。 */
export class CreditBook {
  private readonly entries = new Map<string, ProviderBalance>();

  constructor(initial: readonly ProviderBalance[] = []) {
    for (const entry of initial) this.entries.set(entry.provider, entry);
  }

  set(balance: ProviderBalance): void {
    this.entries.set(balance.provider, balance);
  }

  get(provider: string): ProviderBalance | undefined {
    return this.entries.get(provider);
  }

  /** 沒有資料，或資料已超過 `ttlMs` → 需要重新探測。 */
  stale(provider: string, now: number, ttlMs: number): boolean {
    const entry = this.entries.get(provider);
    if (!entry) return true;
    return now - entry.checkedAt >= ttlMs;
  }

  /**
   * 已知餘額不高於門檻 → 回該筆（呼叫端據此視 provider 不可用）；
   * 否則回 `undefined`（含「沒有資料」「仍有錢」「資料過舊」）。
   *
   * `minUsd` 預設 0：`remaining <= 0` 即視為見底（餘額 0 也付不出任何需要
   * 預借的請求）。要放寬到「只有負的才擋」，把 `minUsd` 設成負值即可。
   * `maxAgeMs` 讓「很久以前探到的負餘額」失效（fail-open），避免儲值後同一份
   * 過期資料在離線 session 裡永久封鎖 provider。
   */
  exhausted(
    provider: string,
    opts: { minUsd?: number; now?: number; maxAgeMs?: number } = {},
  ): ProviderBalance | undefined {
    const { minUsd = 0, now = Date.now(), maxAgeMs = CREDIT_MAX_AGE_MS } = opts;
    if (!provider) return undefined;
    const entry = this.entries.get(provider);
    if (!entry) return undefined;
    if (maxAgeMs > 0 && now - entry.checkedAt > maxAgeMs) return undefined;
    return entry.remainingUsd <= minUsd ? entry : undefined;
  }

  list(): ProviderBalance[] {
    return [...this.entries.values()];
  }

  toJSON(): ProviderBalance[] {
    return this.list();
  }
}

/** 餘額新鮮度：超過就重新探測（5 分鐘；餘額變動快，且探測只是單一 GET）。 */
export const CREDIT_TTL_MS = 5 * 60_000;

/** 超過這個時間的負餘額不再擋路（fail-open；避免離線/儲值後被過期資料卡死）。 */
export const CREDIT_MAX_AGE_MS = 6 * 60 * 60_000;

/** 唯一的餘額狀態檔（與 config/state/health 同目錄；呼叫時解析 HOME）。 */
export function creditsFile(): string {
  return join(homedir(), ".pi", "agent", "pi-compass", "provider-balance.json");
}

/**
 * HTTP 依賴以最小介面注入，測試可替換；預設用 Node 全域 `fetch`（>= 18）。
 */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, json: () => res.json() as Promise<unknown> };
};

/** 各 provider 的餘額探測定義（可擴充）。 */
export const CREDIT_PROBES: Readonly<
  Record<string, { url: string; parse: (body: unknown) => number | undefined }>
> = {
  openrouter: { url: "https://openrouter.ai/api/v1/credits", parse: parseOpenRouterCredits },
};

/** OpenRouter `/api/v1/credits`：remaining = total_credits - total_usage。 */
export function parseOpenRouterCredits(body: unknown): number | undefined {
  const data = (body as { data?: { total_credits?: unknown; total_usage?: unknown } } | null)?.data;
  const credits = data?.total_credits;
  const usage = data?.total_usage;
  if (typeof credits !== "number" || !Number.isFinite(credits)) return undefined;
  if (typeof usage !== "number" || !Number.isFinite(usage)) return undefined;
  return credits - usage;
}

/**
 * 探測單一 provider 的剩餘餘額。缺探測器 / 非 2xx / 格式不符 / 連線失敗
 * 一律回 `undefined`（呼叫端據此保留上一次的值，fail-open）。
 */
export async function probeProvider(
  provider: string,
  apiKey: string,
  opts: { fetchImpl?: FetchLike; signal?: AbortSignal } = {},
): Promise<number | undefined> {
  const definition = CREDIT_PROBES[provider];
  if (!definition || !apiKey) return undefined;
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  try {
    const res = await fetchImpl(definition.url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: opts.signal,
    });
    if (!res.ok) return undefined;
    return definition.parse(await res.json());
  } catch {
    return undefined;
  }
}

/**
 * 讀取餘額狀態檔。**永不 throw**：檔案不存在/壞掉/欄位不符一律回空。
 */
export function loadCredits(file: string = creditsFile()): CreditBook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return new CreditBook();
  }
  const entries =
    typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { entries?: unknown }).entries)
      ? (parsed as { entries: unknown[] }).entries
      : [];
  const valid = entries.filter((entry): entry is ProviderBalance => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    return (
      typeof e.provider === "string" &&
      e.provider.length > 0 &&
      typeof e.remainingUsd === "number" &&
      Number.isFinite(e.remainingUsd) &&
      typeof e.checkedAt === "number" &&
      Number.isFinite(e.checkedAt) &&
      typeof e.source === "string"
    );
  });
  return new CreditBook(valid);
}

/**
 * 寫入餘額狀態檔（best-effort、0600）。失敗不影響回合。
 * 與 health 同一種跨行程鎖 + 原子寫。
 */
export function saveCredits(book: CreditBook, file: string = creditsFile()): void {
  const locked = acquireLock(file);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ entries: book.toJSON() }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // best-effort：寫不進去也不能打斷回合。
  } finally {
    if (locked) releaseLock(file);
  }
}
