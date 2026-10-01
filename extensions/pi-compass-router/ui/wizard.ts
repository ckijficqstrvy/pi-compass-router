// ui/wizard.ts — /compass-set 設定選單（SPEC Part 10.2）。
import type { Mode, Target } from "../schema.js";

/** 解析「模型鏈」字串為候選列表（選單顯示與檔案間的往返）。 */
export function parseChain(_input: string): Target[] {
  throw new Error("not implemented: ui/wizard");
}

/** 解析輸入的金額字串；不合法回 null（選單驗證用）。 */
export function parseAmount(_input: string): number | null {
  throw new Error("not implemented: ui/wizard");
}

/** provider 代號 → 顯示標籤。 */
export function providerLabel(_provider: string): string {
  throw new Error("not implemented: ui/wizard");
}

/** 顯示標籤 → provider 代號；不認識回 null。 */
export function providerFromLabel(_label: string): string | null {
  throw new Error("not implemented: ui/wizard");
}

/** mode → 顯示標籤（含短語說明）。 */
export function modeLabel(_mode: Mode): string {
  throw new Error("not implemented: ui/wizard");
}

/** 顯示標籤 → mode；不認識回 null。 */
export function modeFromLabel(_label: string): Mode | null {
  throw new Error("not implemented: ui/wizard");
}

/**
 * 執行 /compass-set 選單（Part 10.2）：每項驗證 → 寫 config.json
 * （同目錄時間戳備份）→ 重載 → 重繪。
 *
 * @param hooks 掛載所需的 pi/檔案 hooks。規格未定義 hook 形狀，骨架先
 *   以 unknown 表示，實作前需補規格。
 */
export async function runSettingsWizard(_hooks: unknown): Promise<void> {
  throw new Error("not implemented: ui/wizard");
}
