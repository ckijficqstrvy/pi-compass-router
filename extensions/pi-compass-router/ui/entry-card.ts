// ui/entry-card.ts — transcript entry 的主題化卡片渲染（SPEC Part 10.4 視覺規格）。
//
// 內容全部來自 `entries.ts` 的 `buildEntryView` + `composeLines`（單一來源）；
// 本檔只做 Tone → theme token 的映射與卡片排版。收合一列脈絡、展開樹狀明細，
// 以 accent 徽章 + customMessageBg 卡片底把路由決策從 transcript 中凸顯出來。
// 呈現細節由 `display` 設定控制（Part 3.1）：密度、欄位、徽章、配色、提示、導軌。
import { keyHint, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";

import {
  buildEntryView,
  composeLines,
  type EntrySegment,
  type RouteEntry,
  type Tone,
} from "./entries.js";
import { DISPLAY_DEFAULTS, type DisplayConfig } from "../schema.js";

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

/** 單色模式（`display.color: "mono"`）：只留明暗/粗細，適合截圖與淺色主題。 */
function monoPaint(text: string, tone: Tone, theme: Theme): string {
  switch (tone) {
    case "badge":
    case "title":
    case "switched":
    case "held":
    case "notify":
    case "skipped":
    case "unrouted":
      return theme.bold(text);
    case "label":
    case "muted":
      return theme.fg("muted", text);
    case "dim":
    case "rail":
      return theme.fg("dim", text);
    default:
      return tone.startsWith("tier:") || tone.startsWith("thinking:") ? theme.bold(text) : theme.fg("text", text);
  }
}

/** 一段段落上色。badge 加底色徽章；`tier:*`／`thinking:*` 前綴走色階表。 */
function paint(part: EntrySegment, theme: Theme, display: DisplayConfig): string {
  const t = part.text;
  if (display.color === "mono") return monoPaint(t, part.tone, theme);
  switch (part.tone) {
    case "badge":
      if (!display.badge) return theme.fg("muted", t);
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

function paintAll(segments: EntrySegment[], theme: Theme, display: DisplayConfig): string {
  return segments.map((s) => paint(s, theme, display)).join("");
}

/** expand 提示。keyHint 依賴已初始化的 keybindings/theme；萬一不在 TUI 環境就退回固定字串，不讓整張卡片炸掉。 */
function expandHint(theme: Theme, display: DisplayConfig): string {
  try {
    return theme.fg("dim", keyHint("app.tools.expand", "for the full breakdown"));
  } catch {
    return theme.fg("dim", "(expand for the full breakdown)");
  }
}

/**
 * 渲染 entry 卡片（Part 10.4）。
 *
 * 顯示哪些列由 `composeLines`（吃 `display`）決定：收合 = 脈絡一列
 * （`detail: "compact"` 只留首行、`"full"` 直接攤開明細）、展開 = 樹狀列。
 * 卡片底 `customMessageBg`，與官方 custom-entry 範例一致。
 */
export function renderEntryCard(
  entry: RouteEntry,
  options: { expanded: boolean; display?: DisplayConfig },
  theme: Theme,
): Component {
  const display = options.display ?? DISPLAY_DEFAULTS;
  const view = buildEntryView(entry, display);
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(paintAll(view.head, theme, display), 0, 0));

  // expand 提示：還有明細可展開時才顯示（收合 + 非 full），接在最後一列尾巴。
  const hint = display.hint && !options.expanded && display.detail !== "full" ? expandHint(theme, display) : null;
  const lines = composeLines(view, { expanded: options.expanded, display });
  lines.forEach((line, i) => {
    const rail = line.rail !== "" ? theme.fg("borderMuted", line.rail) : "";
    const label = line.label !== "" ? theme.fg("customMessageLabel", line.label) : "";
    const tail = hint !== null && i === lines.length - 1 ? `  ${hint}` : "";
    box.addChild(new Text(rail + label + paintAll(line.segments, theme, display) + tail, 0, 0));
  });
  if (hint !== null && lines.length === 0) box.addChild(new Text(hint, 0, 0));

  return box;
}
