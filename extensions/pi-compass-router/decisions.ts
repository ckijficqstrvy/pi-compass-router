// decisions.ts — 決策日誌（本地 JSONL，SPEC Part 8/11）。
//
// 只記**非內容欄位**：任務種類/信心、demand、tier、模型、thinking、結果、
// cache 估算、以及使用者的回饋（revert / 手動換模型）。**不寫 prompt 原文**
// ——Part 4.4「對話內容不寫盤」不變。
//
// 預設開啟（2026-10-03 使用者拍板），可用 config `decisionLog: false` 關閉；
// 永久 best-effort：任何寫入失敗都吞掉，絕不影響回合。
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 唯一的日誌路徑（與 config/state 同目錄；不可配置）。**呼叫時解析**。 */
export function decisionsFile(): string {
  return join(homedir(), ".pi", "agent", "pi-compass", "decisions.jsonl");
}

/** @deprecated 相容用；新程式碼請用 `decisionsFile()`。 */
export const DECISIONS_FILE = decisionsFile();

/** 一條路由決策（不含 prompt 內容）。 */
export interface RouteDecisionRecord {
  type: "route";
  kind?: string;
  kindConfidence?: number;
  demand?: number;
  tier?: string | null;
  model: string | null;
  thinking?: string;
  symbol: string;
  outcome?: string;
  cacheMissUsd?: number;
  classify?: { source: string; latencyMs: number; hit: boolean };
}

/** 使用者回饋：revert（明確）或 manual-override（下一輪偵測到模型被換掉）。 */
export interface FeedbackRecord {
  type: "feedback";
  feedback: "revert" | "manual-override";
  from: string | null;
  to: string | null;
  tier?: string | null;
  kind?: string;
}

/**
 * 逐輪的真實用量與成本（2026-10-05 新增；非內容欄位）。
 * 為什麼要有：先前只把 `usage.cost.total` 記進 `state.json` 的**聚合總額**，
 * 決策日誌只有 cache miss 估算，無法回答「哪類決策實際最花錢」。
 */
export interface UsageRecord {
  type: "usage";
  /** `provider/model`，缺失時 `null`。 */
  model: string | null;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** registry 回報的實際成本（USD）。 */
  costUsd?: number;
  /** 該輪是否為正常完成（`stopReason !== "error"`）。 */
  ok: boolean;
  /** 最近一次路由的層級／種類（供成本歸類；無則省略）。 */
  tier?: string | null;
  kind?: string;
}

/**
 * 一次 provider 故障事件（2026-10-05 新增；非內容欄位）。
 * 為什麼要有：`health.json` 的冷卻**會過期／成功即清除**，無法回答
 * 「過去一週哪些 provider 最常壞」。這筆是持久的歷史。
 */
export interface HealthRecord {
  type: "health";
  provider: string;
  model: string;
  /** `rate_limit` / `quota` / `auth` / `server` / `timeout`。 */
  klass: string;
  /** `provider` = 整帳號層級（quota/auth），`model` = 單一模型。 */
  scope: "model" | "provider";
}

export type DecisionRecord = RouteDecisionRecord | FeedbackRecord | UsageRecord | HealthRecord;

/** 測試可注入路徑。回傳實際寫入的檔案（成功時）或 undefined（失敗吞掉）。 */
export function appendDecision(record: DecisionRecord, file: string = decisionsFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch {
    // 記日誌是 best-effort：寫不進去也不打斷回合。
  }
}

/**
 * 記錄是否落在最近 `days` 天內（`ts` 缺失或無法解析時保留，fail-open）。
 * 供 `suggest` 與 `stats` 共用，避免兩處各寫一份視窗邏輯。
 */
export function decisionWithinDays(record: unknown, now: number, days: number): boolean {
  const ts = (record as { ts?: unknown } | null | undefined)?.ts;
  if (typeof ts !== "string") return true;
  const parsed = Date.parse(ts);
  if (!Number.isFinite(parsed)) return true;
  return now - parsed <= days * 24 * 60 * 60 * 1000;
}

/** 讀決策日誌（best-effort）：檔案不存在或個別行壞掉都跳過，永不 throw。 */
export function readDecisions(file: string = decisionsFile()): DecisionRecord[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
        out.push(parsed as DecisionRecord);
      }
    } catch {
      // 壞行跳過
    }
  }
  return out;
}
