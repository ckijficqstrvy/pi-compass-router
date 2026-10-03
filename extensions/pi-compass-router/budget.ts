// budget.ts — 預算記帳與壓力（SPEC Part 8）。
//
// 上游版本（108 行）列為禁讀來源（Part 0.2），本檔依 Part 8 規格重寫。
// 行為定義只有兩條：壓力公式與記帳到固定路徑。
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { CompassConfig } from "./schema.js";

/** 記帳來源的花費快照（state.json）。 */
export interface SpendSnapshot {
  todayUsd: number;
  monthUsd: number;
}

/**
 * 唯一的記帳路徑（Part 8：固定所有權，不可配置，不是設定鍵）。
 * 與 `~/.pi/agent/pi-compass/config.json` 同目錄。
 *
 * **呼叫時解析**（不是模組載入時）——`homedir()` 會跟著行程環境變動，
 * 測試注入 temp HOME 才不會被模組快取釘死。
 */
export function stateFile(): string {
  return join(homedir(), ".pi", "agent", "pi-compass", "state.json");
}

/** @deprecated 相容用；新程式碼請用 `stateFile()`（呼叫時解析）。 */
export const STATE_FILE = stateFile();

/** state.json 的內部形狀。以 UTC 日／月為滾動窗（Part 8）。 */
interface LedgerFile {
  /** UTC `YYYY-MM-DD`。 */
  day: string;
  todayUsd: number;
  /** UTC `YYYY-MM`。 */
  month: string;
  monthUsd: number;
  updatedAt: string;
}

const emptyLedger = (at: Date): LedgerFile => ({
  day: utcDay(at),
  todayUsd: 0,
  month: utcMonth(at),
  monthUsd: 0,
  updatedAt: at.toISOString(),
});

function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function utcMonth(at: Date): string {
  return at.toISOString().slice(0, 7);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 讀取帳本。**永不 throw**——記帳失敗不能阻擋使用者的回合，
 * 檔案不存在、格式壞掉、權限不足一律回報零。
 */
function readLedger(at: Date, stateFile: string): LedgerFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return emptyLedger(at);
  }
  if (!isRecord(parsed)) return emptyLedger(at);

  const ledger = emptyLedger(at);
  if (typeof parsed.day === "string" && parsed.day === ledger.day && typeof parsed.todayUsd === "number" && Number.isFinite(parsed.todayUsd)) {
    ledger.todayUsd = Math.max(0, parsed.todayUsd);
  }
  if (typeof parsed.month === "string" && parsed.month === ledger.month && typeof parsed.monthUsd === "number" && Number.isFinite(parsed.monthUsd)) {
    ledger.monthUsd = Math.max(0, parsed.monthUsd);
  }
  return ledger;
}

function writeLedger(ledger: LedgerFile, stateFile: string): void {
  try {
    mkdirSync(dirname(stateFile), { recursive: true });
    // 原子寫：先寫同目錄 temp 再 rename（同檔案系統 rename 是原子的），
    // 避免兩個 session 並寫時交錯出半個 JSON。
    const tmp = `${stateFile}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, stateFile);
  } catch {
    // 記帳是 best-effort：寫不進去也不打斷回合（Part 8：上限是政策不是硬擋）。
  }
}

/** 跨行程鎖的目錄；持有者寫入前建立，寫完删除。 */
const LOCK_STALE_MS = 2000;

/**
 * 以 `mkdir`（原子操作）取得跨行程鎖；拿不到就回 false。
 * 超過 `LOCK_STALE_MS` 的鎖視為持有者已死，搶一次。
 */
function acquireLock(stateFile: string): boolean {
  const lockDir = `${stateFile}.lock`;
  try {
    mkdirSync(lockDir);
    return true;
  } catch {
    try {
      const age = Date.now() - statSync(lockDir).mtimeMs;
      if (age > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        return true;
      }
    } catch {
      // 鎖目錄剛被释放或無法讀取——就當沒拿到（best-effort）
    }
    return false;
  }
}

function releaseLock(stateFile: string): void {
  try {
    rmSync(`${stateFile}.lock`, { recursive: true, force: true });
  } catch {
    // 解锁失敗不影響回合
  }
}

/**
 * 當前 UTC 日／月的花費快照，供 `computePressure` 與狀態列使用。
 *
 * @param stateFile **僅供測試**注入路徑；預設與生產一律 `STATE_FILE`
 *   （不可配置，Part 8）。
 */
export function loadSpend(at: Date = new Date(), file: string = stateFile()): SpendSnapshot {
  const stateFile = file;
  const ledger = readLedger(at, stateFile);
  return { todayUsd: ledger.todayUsd, monthUsd: ledger.monthUsd };
}

/**
 * `pressure = max(today ÷ dailyUsd, month ÷ monthlyUsd)`。
 *
 * 該維度為 `null` 或 `0` → **移除上限、不計入**（Part 8）。
 * 兩個維度都無上限 → 恆為 `0`（無壓力）。
 */
export function computePressure(spend: SpendSnapshot, config: CompassConfig): number {
  const ratios: number[] = [];
  const daily = config.budget.dailyUsd;
  const monthly = config.budget.monthlyUsd;
  if (daily !== null && daily > 0) ratios.push(spend.todayUsd / daily);
  if (monthly !== null && monthly > 0) ratios.push(spend.monthUsd / monthly);
  if (ratios.length === 0) return 0;
  return Math.max(...ratios);
}

/**
 * 記入一筆 assistant message 的計算成本到 state.json。
 *
 * - `amountUsd <= 0` 或非有限值 → 忽略（不寫檔）
 * - 跨 UTC 日／月 → 該維度歸零再累加
 * - laya 分類不記帳（Part 4.2、Part 8）——呼叫端不傳即可
 * - **永不 throw**
 * - `stateFile` **僅供測試**注入；生產與預設一律 `STATE_FILE`
 */
export function recordSpend(amountUsd: number, at: Date = new Date(), file: string = stateFile()): void {
  const stateFile = file;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return;
  // 讀-改-寫要互斥，否則兩個 pi session 同時記帳會掉更新。
  // 拿不到鎖（別的行程持有且未過期）→ 仍寫（best-effort，最後寫者勝）；
  // 記帳絕不擋住使用者的回合（Part 8）。
  const locked = acquireLock(stateFile);
  try {
    const ledger = readLedger(at, stateFile);
    ledger.todayUsd += amountUsd;
    ledger.monthUsd += amountUsd;
    ledger.updatedAt = at.toISOString();
    writeLedger(ledger, stateFile);
  } finally {
    if (locked) releaseLock(stateFile);
  }
}