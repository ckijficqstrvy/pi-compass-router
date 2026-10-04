// classify/history.ts — 對話歷史擷取（SPEC Part 4.1/4.4、`classify.historyTurns`）。
//
// 2026-10-03（審查 W6）：`historyTurns` 先前完全沒接線——分類器從沒收到
// conversation，設定形同裝飾。這裡把 session 分支訊息壓成送給分類器的字串：
// 只取最近 N 回合、只取文字、硬性上限 4000 字元（Part 4.4）。
// 純函式，結構型別讓測試不必依賴 session 型別。
import type { ClassifyInput } from "./types.js";

/** 送分類器的對話上限（Part 4.4：conversation 啟用時上限 4000 字元）。 */
export const CONVERSATION_MAX_CHARS = 4000;

/** session entry 的最小結構（只碰我需要的欄位）。 */
interface EntryLike {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** 從 content（字串或 content block 陣列）抽出純文字。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const record = block as { type?: unknown; text?: unknown };
      if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    }
  }
  return parts.join("\n");
}

/**
 * session 分支 → 分類器用的 conversation 字串。
 *
 * - `turns <= 0` → `undefined`（不送；Part 4.4 預設）
 * - 只收 user/assistant 的訊息，各取文字
 * - 取最後 `turns` 回合（≈ 2×turns 則訊息）
 * - 超過 `maxChars` 從**尾端**截（保留最近的上下文）
 */
export function conversationText(
  entries: readonly unknown[],
  turns: number,
  maxChars: number = CONVERSATION_MAX_CHARS,
): string | undefined {
  if (!Number.isFinite(turns) || turns <= 0) return undefined;
  const messages: string[] = [];
  for (const raw of entries) {
    const entry = raw as EntryLike | null | undefined;
    if (entry?.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textOf(entry.message?.content).trim();
    if (text === "") continue;
    messages.push(`${role}: ${text}`);
  }
  if (messages.length === 0) return undefined;
  const joined = messages.slice(-turns * 2).join("\n");
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/** 供分類輸入用的包裝（保持 `ClassifyInput` 形狀在呼叫端單純）。 */
export type ClassifyHistory = Pick<ClassifyInput, "conversation">;
