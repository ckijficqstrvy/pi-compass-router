/**
 * 分類快取（SPEC Part 6.2）——本機分類再快也有數十毫秒；使用者常重複
 * 或只改一個字地提問，命中後把延遲壓到 5ms 以內。
 *
 * 三條邊界：
 * - **僅記憶體**，不落磁碟（Part 4.4：對話內容不寫盤）
 * - **鍵含設定世代**：`taskKinds` 或 `modelPick` 變動即全數失效
 * - **預設開啟、可關**（`classify.cache` / `COMPASS_CACHE=0`）
 *
 * 不做的事：不做語意相似度比對（那會引入新的推論成本與誤判面）；
 * 只做精確鍵命中。這是有意的取捨——先拿到確定的 5ms，再談相似度。
 */

import { createHash } from "node:crypto";
import type { Judgment } from "./types.js";

/** 正規化後參與雜湊的請求長度上限（Part 6.2）。 */
const MAX_NORMALIZE_CHARS = 512;
/** 預設容量上限，超出走 LRU 淘汰（Part 6.2）。 */
const DEFAULT_MAX_ENTRIES = 256;

/**
 * 鍵的請求部分：折疊空白、保留大小寫、截到 512 字元。
 * 保留大小寫是有意的——大小寫常是語意差別（identifier vs 散文）。
 */
export function normalizeRequest(request: string): string {
  const collapsed = request.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_NORMALIZE_CHARS ? collapsed.slice(0, MAX_NORMALIZE_CHARS) : collapsed;
}

/**
 * 設定世代：涵蓋會影響判斷結果的設定。改動任一欄位 → 新鍵 → 舊鍵自然失效。
 *
 * 只收「改變分類答案」的欄位：種類集合（決定 choice criteria 與第幾題）、
 * modelPick 模式（決定有沒有第六題）。預算、價格帶、cache 欄位不影響
 * 分類結果，**刻意不收**——它們變動時不應使快取作廢。
 */
export function configGeneration(taskKinds: unknown, modelPickMode: string): string {
  const kindsPart = JSON.stringify(taskKinds ?? {}, Object.keys((taskKinds ?? {}) as object).sort());
  const material = `kinds=${kindsPart}|modelPick=${modelPickMode}|v=1`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** 完整快取鍵：`normalize(request)` 與設定世代的組合雜湊。 */
export function cacheKey(request: string, generation: string): string {
  return createHash("sha256").update(`${generation}\u0000${normalizeRequest(request)}`).digest("hex");
}

export interface CacheStats {
  hits: number;
  misses: number;
  evictions: number;
  size: number;
}

interface Entry {
  judgment: Judgment;
  storedAt: number;
}

export interface ClassificationCacheOptions {
  enabled: boolean;
  ttlSeconds: number;
  maxEntries?: number;
}

export class ClassificationCache {
  private readonly entries = new Map<string, Entry>();
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ClassificationCacheOptions) {
    this.enabled = options.enabled;
    this.ttlMs = Math.max(0, options.ttlSeconds) * 1000;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /**
   * 命中回傳判斷並標記 `cacheHit`；`latencyMs` 改記本次查詢耗時
   * （決策軌跡要顯示的是「這輪花了多久」，不是原始分類耗時）。
   */
  get(key: string, queryMs: number): Judgment | undefined {
    if (!this.enabled || this.ttlMs === 0) return undefined;
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() - entry.storedAt > this.ttlMs) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }
    // LRU：命中即移到尾端。
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return { ...entry.judgment, latencyMs: queryMs, source: "cache", cacheHit: true };
  }

  /** 存入。`cacheHit` 不會被存（那是查詢期的標記）。 */
  set(key: string, judgment: Judgment): void {
    if (!this.enabled || this.ttlMs === 0) return;
    const { cacheHit: _cacheHit, ...stored } = judgment;
    if (this.entries.has(key)) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictions += 1;
    }
    this.entries.set(key, { judgment: stored as Judgment, storedAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** `/compass` 顯示 `classify hits · saved ms`（Part 10.1、6.4）。 */
  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, evictions: this.evictions, size: this.entries.size };
  }
}