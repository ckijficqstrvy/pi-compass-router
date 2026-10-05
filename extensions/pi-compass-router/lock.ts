// lock.ts — 跨行程的簡易互斥鎖（Spec：記帳／健康狀態 best-effort）。
//
// 為什麼獨立成模組：budget 的帳本與 health 的健康檔都是「讀-改-寫」，
// 兩個 pi session 並寫會掉更新。兩處都需要同一種鎖，就不該各自複製一份
// mkdir 鎖的實作（2026-10-05 覆核：health 先前完全沒有鎖）。
//
// 語意：以 `mkdir`（原子）取得 `<target>.lock` 目錄；拿不到且持有者超過
// `LOCK_STALE_MS` 未釋放，視為持有者已死，搶一次。**永不 throw**——
// 拿不到回 false，呼叫端自行決定是否仍寫（best-effort）。
import { mkdirSync, rmSync, statSync } from "node:fs";

/** 超過此毫秒數的鎖視為持有者已死。 */
export const LOCK_STALE_MS = 2000;

/**
 * 對 `targetPath` 取得鎖。成功回 true；被他人持有回 false。
 */
export function acquireLock(targetPath: string): boolean {
  const lockDir = `${targetPath}.lock`;
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
      // 鎖目錄剛被釋放或無法讀取——就當沒拿到。
    }
    return false;
  }
}

/** 釋放 `targetPath` 的鎖；失敗不影響回合。 */
export function releaseLock(targetPath: string): void {
  try {
    rmSync(`${targetPath}.lock`, { recursive: true, force: true });
  } catch {
    // 解鎖失敗不影響回合。
  }
}
