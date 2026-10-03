// ui/wizard/run.ts — 選單主迴圈（TUI 顯示與落檔全交給 hooks）。
import { t, setLang } from "../strings.js";
import type { CompassConfig } from "../../schema.js";
import type { WizardHooks } from "./types.js";
import { GROUP_ITEMS, GROUPS, groupName, groupOf, itemOf, renderGroupRow, renderItemRow, BACK_OPTION, DONE_OPTION, MENU_LABEL } from "./items.js";
import { editItem, notice, pickFrom } from "./edit.js";

// 主迴圈
// ---------------------------------------------------------------------------

/**
 * 執行 /compass-set 選單（Part 10.2）：組 → 項目 → 編輯 → 寫 config.json
 * （時間戳備份）→ 重載 → 重繪。
 *
 * 本函式是**選單迴圈**，TUI 顯示與檔案落地全交給 `hooks`（純資料 + 掛點，
 * 便於測試）。寫入被拒（`write()` 回 `key: reason`）→ 顯示原因、不落檔。
 */
export async function runSettingsWizard(
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<void> {
  let live = config;
  for (;;) {
    setLang(live.display.language);
    const groupRows = GROUPS.map((group) => renderGroupRow(group.id, live));
    const chosen = await pickFrom(hooks, MENU_LABEL, [...groupRows, DONE_OPTION]);
    if (chosen === undefined || chosen === null || chosen === DONE_OPTION) return;
    const group = groupOf(chosen);
    if (group === null) {
      notice(hooks, t`未識別的選單項目：${chosen.slice(0, 40)}`, "error");
      return;
    }

    for (;;) {
      // 語言可能剛在這一層被改（uiLang 項目）——每輪同步，列立即換語言。
      setLang(live.display.language);
      const itemRows = GROUP_ITEMS[group].map((item) => renderItemRow(item, live));
      const picked = await pickFrom(hooks, t`${groupName(group)}：選一項`, [...itemRows, BACK_OPTION]);
      if (picked === undefined || picked === null || picked === BACK_OPTION) break;
      const item = itemOf(group, picked);
      if (item === null) {
        notice(hooks, t`未識別的項目：${picked.slice(0, 40)}`, "error");
        break;
      }

      const edited = await editItem(item, live, hooks);
      if (edited === undefined || edited === null) continue; // 取消 / 寫入被拒
      const problem = hooks.write(edited.key, edited.value);
      if (problem !== null) {
        notice(hooks, t`未寫入：${problem}`, "error");
        continue;
      }
      notice(hooks, t`已寫入 ${edited.key}`, "info");
      const fresh = await hooks.reload();
      if (fresh !== null && fresh !== undefined && typeof fresh === "object") live = fresh;
      Object.assign(live, edited.applyTo(live));
    }
  }
}

