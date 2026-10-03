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

/** 唯一的日誌路徑（與 config/state 同目錄；不可配置）。 */
export const DECISIONS_FILE = join(homedir(), ".pi", "agent", "pi-compass", "decisions.jsonl");

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

export type DecisionRecord = RouteDecisionRecord | FeedbackRecord;

/** 測試可注入路徑。回傳實際寫入的檔案（成功時）或 undefined（失敗吞掉）。 */
export function appendDecision(record: DecisionRecord, file: string = DECISIONS_FILE): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch {
    // 記日誌是 best-effort：寫不進去也不打斷回合。
  }
}

/** 讀決策日誌（best-effort）：檔案不存在或個別行壞掉都跳過，永不 throw。 */
export function readDecisions(file: string = DECISIONS_FILE): DecisionRecord[] {
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
