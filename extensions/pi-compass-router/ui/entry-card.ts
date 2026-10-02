// ui/entry-card.ts — transcript entry 的主題化卡片渲染（SPEC Part 10.4 視覺規格）。
//
// 內容全部來自 `entries.ts` 的 `buildEntryView`（單一來源）；本檔只做
// Tone → theme token 的映射與卡片排版。收合一列脈絡、展開樹狀明細，
// 以 accent 徽章 + customMessageBg 卡片底把路由決策從 transcript 中凸顯出來。
import { keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";

import {
  buildEntryView,
  padRowLabel,
  type EntrySegment,
  type RouteEntry,
  type Tone,
} from "./entries.js";

/** 層級色階：cheap → 中性 → 強 → 昂貴（quick…xpremium 由低到高）。 */
const TIER_FG: Record<string, ThemeColor> = {
  quick: "success",
  standard: "text",
  high: "accent",
  premium: "warning",
  xpremium: "error",
};

/** thinking 色票直接用 theme 的 thinking<Level> 系列（與 thinking 面板一致）。 */
const THINKING_FG: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

/** 一段段落上色。badge 加底色徽章；`tier:*`／`thinking:*` 前綴走色階表。 */
function paint(part: EntrySegment, theme: Theme): string {
  const t = part.text;
  switch (part.tone) {
    case "badge":
      // accent 底 + 卡片底色字：整塊 entry 的視覺錨點。
      return theme.style(` ${t} `, { fg: theme.colors.customMessageBg, bg: theme.colors.accent, bold: true });
    case "title":
      return theme.style(t, { fg: "text", bold: true });
    case "label":
      return theme.fg("customMessageLabel", t);
    case "dim":
      return theme.fg("dim", t);
    case "rail":
      return theme.fg("borderMuted", t);
    case "number":
      return theme.fg("syntaxNumber", t);
    case "muted":
      return theme.fg("muted", t);
    case "accent":
      return theme.fg("accent", t);
    case "success":
      return theme.fg("success", t);
    case "warning":
      return theme.fg("warning", t);
    case "error":
      return theme.fg("error", t);
    // 五種 entry 結果（Part 5 Stage 5）：切換=綠、保持=灰、通知=藍、跳過=橙、未路由=暗。
    case "switched":
      return theme.style(t, { fg: "success", bold: true });
    case "held":
      return theme.style(t, { fg: "muted", bold: true });
    case "notify":
      return theme.style(t, { fg: "accent", bold: true });
    case "skipped":
      return theme.style(t, { fg: "warning", bold: true });
    case "unrouted":
      return theme.style(t, { fg: "dim", bold: true });
    default: {
      const [kind, value] = part.tone.split(":") as [string, string];
      if (kind === "tier") {
        return theme.style(t, { fg: TIER_FG[value] ?? "text", bold: true });
      }
      if (kind === "thinking") {
        const token = THINKING_FG[value];
        return token ? theme.style(t, { fg: token, bold: true }) : theme.bold(t);
      }
      return theme.fg("text", t);
    }
  }
}

function paintAll(segments: EntrySegment[], theme: Theme): string {
  return segments.map((s) => paint(s, theme)).join("");
}

/** expand 提示。keyHint 依賴已初始化的 keybindings/theme；萬一不在 TUI 環境就退回固定字串，不讓整張卡片炸掉。 */
function expandHint(theme: Theme): string {
  try {
    return theme.fg("dim", keyHint("app.tools.expand", "for the full breakdown"));
  } catch {
    return theme.fg("dim", "(expand for the full breakdown)");
  }
}

/**
 * 渲染 entry 卡片。
 *
 * 收合：徽章首行 + 一列脈絡 + expand 提示；展開：首行 + 樹狀明細列
 * （`├`/`└`，標籤欄固定寬對齊）。卡片底 `customMessageBg`，與官方
 * custom-entry 範例一致。
 */
export function renderEntryCard(
  entry: RouteEntry,
  options: { expanded: boolean },
  theme: Theme,
): Component {
  const view = buildEntryView(entry, options.expanded);
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(paintAll(view.head, theme), 0, 0));

  if (options.expanded) {
    // 空 rows 退回收合脈絡列，避免只剩孤零零的首行。
    const rows = view.rows.length > 0 ? view.rows : [{ label: "", segments: view.summary }];
    rows.forEach((row, i) => {
      const rail = i === rows.length - 1 ? "└ " : "├ ";
      const line =
        theme.fg("borderMuted", rail) +
        (row.label ? theme.fg("customMessageLabel", padRowLabel(row.label)) : "") +
        paintAll(row.segments, theme);
      box.addChild(new Text(line, 0, 0));
    });
  } else {
    const hint = expandHint(theme);
    const summary = paintAll(view.summary, theme);
    box.addChild(new Text(summary ? `${summary}  ${hint}` : hint, 0, 0));
  }

  return box;
}
