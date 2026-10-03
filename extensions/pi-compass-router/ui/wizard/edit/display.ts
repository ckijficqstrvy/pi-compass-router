// ui/wizard/edit/display.ts — 設定選單「display」組的逐項編輯。
import { t } from "../i18n.js";
import { DEFAULT_CONFIG, DISPLAY_COLORS, DISPLAY_DETAILS, DISPLAY_FIELDS, PROFILE_CEILINGS, THINKING_LEVELS, TIERS } from "../../../schema.js";
import type { CompassConfig, DisplayColor, DisplayDetail, DisplayField, Mode, Profile, Target, ThinkingLevel, Tier } from "../../../schema.js";
import type { WizardHooks } from "../types.js";
import type { MenuItem } from "../items.js";
import {
  CLASSIFY_NUM_PRESETS, CLEAR_OPTION, CUSTOM_OPTION, DAILY_PRESETS, DETAIL_HINT, MAX_CANDIDATES,
  MONTHLY_PRESETS, RATIO_PRESETS, SEARCH_OPTION, chainSummary, dedupe, factKeys, factsDate, keyOf,
  modeFromLabel, modeLabel, money, onOff, parseAmount, parseChain, profileFromLabel, profileLabel,
  providerFromLabel, providerLabel, splitTarget, staleDays, thinkingFromLabel, thinkingLabel,
  tierFromLabel, tierLabel,
} from "../labels.js";
import {
  applyChainFor, chooseModel, classifyEdit, displayEdit, modelCandidates, notice, ownModelKeys,
  ownProviders, pickFrom, pickModelFrom, promptLoop, simpleEdit, type EditResult,
} from "./shared.js";

export async function editDisplay(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    // ------------------------------------------------------------ ⑥ 顯示
    case "detail": {
      const labels = (DISPLAY_DETAILS as readonly DisplayDetail[]).map((d) => `${d} — ${DETAIL_HINT[d]()}`);
      const picked = await pickFrom(hooks, t`呈現密度（目前：${config.display.detail}）`, labels);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ detail: picked.split(" — ")[0] as DisplayDetail });
    }

    case "fields": {
      // toggle 迴圈：選一項切換顯示/隱藏；「← 完成」才一次性落檔（沒動就取消）。
      let fields = [...config.display.fields];
      for (;;) {
        const rows = DISPLAY_FIELDS.map((f) => `${fields.includes(f) ? "✓" : "✗"} ${f}`);
        const pickedRow = await pickFrom(hooks, "收合列欄位：選一項切換（✓ = 顯示）", [
          ...rows,
          "← 完成（套用）",
        ]);
        if (pickedRow === undefined || pickedRow === null) return pickedRow;
        if (pickedRow.startsWith("←")) break;
        const field = pickedRow.slice(2) as DisplayField;
        // 加回時依 DISPLAY_FIELDS 固定順序插入（wizard 不產生自訂順序）。
        fields = fields.includes(field)
          ? fields.filter((f) => f !== field)
          : DISPLAY_FIELDS.filter((f) => f === field || fields.includes(f));
      }
      if (fields.join("\u0000") === config.display.fields.join("\u0000")) return undefined;
      return displayEdit({ fields });
    }

    case "badge": {
      const picked = await pickFrom(hooks, "compass 徽章", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ badge: picked === "開" });
    }

    case "color": {
      const picked = await pickFrom(hooks, "配色", [
        "rich — 全彩（跟隨主題）",
        "mono — 單色（只留明暗，適合截圖／淺色主題）",
      ]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ color: (picked.startsWith("mono") ? "mono" : "rich") as DisplayColor });
    }

    case "hint": {
      const picked = await pickFrom(hooks, "expand 提示（收合行尾）", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ hint: picked === "開" });
    }

    case "rails": {
      const picked = await pickFrom(hooks, "樹狀導軌（├/└）", ["開", "關"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ rails: picked === "開" });
    }

    case "uiLang": {
      const picked = await pickFrom(hooks, "界面語言", ["中文", "English"]);
      if (picked === undefined || picked === null) return picked;
      return displayEdit({ language: picked === "English" ? "en" : "zh" });
    }
    default:
      return null;
  }
}
