// ui/wizard/i18n.ts — wizard 執行期的語言脈絡（**唯一**的可變語言狀態）。
//
// 為什麼留在這裡而不是 strings.ts：設定選單的翻譯發生在執行期、需要一個
// 「這次 wizard 用哪個語言」的脈絡；把它收斂在 wizard 子系統內，共用層
// （strings.ts / entry-card.ts / index.ts 的描述）一律用無狀態的 `tl`/`tr`，
// 不再有跨模組的 ambient 語言。
//
// 生命週期：`runSettingsWizard` 在每次重繪前 `setLang(live.display.language)`，
// 所以語言切換在選單內立即生效；wizard 之外沒有任何呼叫端。
import { rawOf as rawOfLang, tl } from "../strings.js";
import type { UiLang } from "../../schema.js";

let lang: UiLang = "zh";

/** 設定 wizard 執行期的語言（只有 runSettingsWizard 會呼叫）。 */
export function setLang(next: UiLang): void {
  lang = next;
}

/** 目前 wizard 語言（測試用）。 */
export function currentLang(): UiLang {
  return lang;
}

/** 以目前 wizard 語言翻譯：`t("開")` 或 `` t`已寫入 ${key}` ``。 */
export function t(literals: string, ...values: unknown[]): string;
export function t(literals: TemplateStringsArray, ...values: unknown[]): string;
export function t(literals: string | TemplateStringsArray, ...values: unknown[]): string {
  return tl(lang, literals as string, ...values);
}

/** 顯示字串 → 原文鍵（語言與 wizard 一致）。 */
export function rawOf(displayed: string): string {
  return rawOfLang(displayed, lang);
}
