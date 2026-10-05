// ui/wizard/edit.ts — 逐項編輯入口：把 MenuItem 分派到各組模組
// （2026-10-03 拆自單一 758 行 switch）。
import type { CompassConfig } from "../../schema.js";
import type { WizardHooks } from "./types.js";
import type { MenuItem } from "./items.js";
import { editRouting } from "./edit/routing.js";
import { editBudget } from "./edit/budget.js";
import { editModels } from "./edit/models.js";
import { editClassifier } from "./edit/classifier.js";
import { editPolicy } from "./edit/policy.js";
import { editDisplay } from "./edit/display.js";
import { editDiagnostics } from "./edit/diagnostics.js";
import { notice, pickFrom, type EditResult } from "./edit/shared.js";

type GroupEditor = (
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
) => Promise<EditResult | undefined | null>;

const GROUP_EDITORS: ReadonlyArray<readonly [readonly MenuItem[], GroupEditor]> = [
  [["enabled", "mode", "advanced", "stickiness", "modelPick", "allowUnratedPicks", "thinking", "cache"], editRouting],
  [["daily", "monthly", "ratios", "profile", "freeOnly", "strictFreeOnly"], editBudget],
  [["chains", "kindModels", "prefer", "kindTiers", "xpremium", "useDefaultModels"], editModels],
  [["provider", "checkpoint", "classifyCache", "classifyNums"], editClassifier],
  [["filters", "ceilings", "scoresFile"], editPolicy],
  [["detail", "fields", "badge", "color", "hint", "rails", "uiLang"], editDisplay],
  [["reset", "testClassifier", "chainSource"], editDiagnostics],
];

/** 依項目分派；找不到組（不應發生）回 null = 這次編輯作廢。 */
export async function editItem(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  const found = GROUP_EDITORS.find(([items]) => items.includes(item));
  return found ? found[1](item, config, hooks) : null;
}

export { notice, pickFrom };
