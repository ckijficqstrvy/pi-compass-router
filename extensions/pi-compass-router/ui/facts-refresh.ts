// ui/facts-refresh.ts — 事實檔更新（SPEC Part 3.1 model-facts、Part 10.1）。
//
// `/compass refresh-facts` 用：跑 `scripts/refresh-facts.mjs`（價格即時同步、
// 生命週期報告；能力分數永不自動猜），把結果摘要成一句話通知使用者。
// spawns 與路徑解析獨立成純函式，便在測試中注入假 spawn。
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 事實檔更新腳本的路徑。本模組位於 `<root>/extensions/pi-compass-router/ui/`，
 * 故上兩層是套件根，再下 `scripts/refresh-facts.mjs`。
 */
export function factsScriptPath(moduleUrl: string = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..", "..", "scripts", "refresh-facts.mjs");
}

/** 更新結果（`/compass refresh-facts` 的通知內容）。 */
export interface RefreshResult {
  ok: boolean;
  message: string;
}

/** 取最後一行非空輸出（refresh-facts 的摘要在尾端）。 */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

/** 把 spawn 結果摘要成一句話（成功帶最後一行摘要，失敗帶 exit code 與 stderr）。 */
export function summarizeRefresh(code: number | null, stdout: string, stderr: string): RefreshResult {
  if (code === 0) {
    const tail = lastLine(stdout);
    return { ok: true, message: tail ? `facts refreshed — ${tail}` : "facts refreshed" };
  }
  const err = lastLine(stderr);
  return {
    ok: false,
    message: `facts refresh failed (exit ${code ?? "?"})${err ? ` — ${err}` : ""}`,
  };
}

/**
 * 跑更新腳本。`spawnFn` 可注入（測試）；逾時 60s（腳本會打 OpenRouter API）。
 * **永不 throw**——失敗回 `{ok:false}`，通知使用者即可，不擋任何回合。
 */
export function runFactsRefresh(
  spawnFn: typeof spawnSync = spawnSync,
  scriptPath: string = factsScriptPath(),
): RefreshResult {
  try {
    const result = spawnFn(process.execPath, [scriptPath], { encoding: "utf8", timeout: 60_000 });
    return summarizeRefresh(result.status, String(result.stdout ?? ""), String(result.stderr ?? ""));
  } catch (error) {
    return { ok: false, message: `facts refresh failed — ${error instanceof Error ? error.message : String(error)}` };
  }
}
