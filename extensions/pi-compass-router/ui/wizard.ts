// ui/wizard.ts — /compass-set 入口（SPEC Part 10.2）。
//
// 2026-10-03 拆分：值↔標籤/顯示工具 ./wizard/labels.ts、選單結構與列渲染
// ./wizard/items.ts、逐項編輯 ./wizard/edit.ts、hooks 型別 ./wizard/types.ts、
// 主迴圈 ./wizard/run.ts。本檔是對外窗口（index.ts 與測試由此匯入）。
export { runSettingsWizard } from "./wizard/run.js";
export type { CandidateKind, WizardHooks } from "./wizard/types.js";
export {
  CUSTOM_OPTION,
  factsAgeDays,
  modeFromLabel,
  modeLabel,
  parseAmount,
  parseChain,
  profileFromLabel,
  profileLabel,
  providerFromLabel,
  providerLabel,
  thinkingFromLabel,
  thinkingLabel,
  tierFromLabel,
  tierLabel,
} from "./wizard/labels.js";
