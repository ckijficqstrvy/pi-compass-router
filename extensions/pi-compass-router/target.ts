// target.ts — `Target` 與 menu／config key 的編碼（**唯一 codec**）。
//
// 抽成中立模組的理由（2026-10-03 審查 W3）：同一個 key 形狀原本有三份實作
// （route/select 的 targetKey/targetFromKey、suggest.ts 自帶一份、index.ts
// 直接切 slash），policy/filter.ts 的 prefer 注入又用第四種假設
// （一律 provider:"" 塞完整字串）。結果 prefer head 永遠過不了 availability。
// 現在全部走這裡。
import type { Target } from "./schema.js";

/**
 * `Target` → key：`"<provider>/<model>"`；provider 為空（prefer 注入、
 * 或呼叫端只給了裸 id）時**只回裸 `model`**。
 */
export function targetKey(target: Target): string {
  return target.provider ? `${target.provider}/${target.model}` : target.model;
}

/**
 * key → `Target`（`targetKey` 的反向）。
 *
 * 關鍵：`~z-ai/glm-latest` 這類 id 有**前導 `~`**，它的 `/` 不是 provider 分隔
 * 而是模型 id 的一部分。直接按第一個 `/` 分割會得到 `provider: "~z-ai"`、
 * `model: "glm-latest"`——丟失 `~` 前綴、破壞 round-trip，且使 menu gate 的
 * `factFor` 查不到事實。故先剝離前導 `~`：只有**無前導 `~`** 才視第一個 `/`
 * 為 provider 分隔（有 `~` → provider 為空字串、整個字串是 model id）。
 */
export function targetFromKey(key: string): Target {
  if (key.startsWith("~")) return { provider: "", model: key };
  const slash = key.indexOf("/");
  if (slash <= 0) return { provider: "", model: key };
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}
