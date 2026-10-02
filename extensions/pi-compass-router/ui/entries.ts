// ui/entries.ts — transcript entry 檢視模型與純文字渲染（SPEC Part 5 Stage 5、Part 10.4）。
//
// 本檔保持**純函式**（無 pi-tui / theme 依賴）：資料 → 色調段落（EntrySegment）
// 的唯一來源。主題化卡片渲染在 `ui/entry-card.ts`，純文字 `renderEntry`
// 供測試與非 TUI 端共用，兩者共用 `buildEntryView`，不會各自長歪。
import {
  DISPLAY_DEFAULTS,
  type DisplayConfig,
  type DisplayField,
  type Target,
  type Tier,
  type ThinkingLevel,
} from "../schema.js";

/** entry 符號（Part 5 Stage 5）：→ 切換、= 保持、• 通知、× 跳過、· 未路由。 */
export type EntrySymbol = "→" | "=" | "•" | "×" | "·";

/** 一條路由決策的 entry 資料（Part 10.4 首行與展開欄位）。 */
export interface RouteEntry {
  symbol: EntrySymbol;
  tier: Tier | null;
  target: Target | null;
  kind?: string;
  kindConfidence?: number;
  complexity?: number;
  capability?: number;
  deepReasoning?: number;
  demand?: number;
  budgetPressure?: number;
  thinking?: {
    resolved: ThinkingLevel;
    judged?: ThinkingLevel;
    applied?: ThinkingLevel;
  };
  picked?: string;
  classify?: {
    source: string;
    latencyMs: number;
    hit: boolean;
  };
  cacheMissUsd?: number;
  /** 未路由原因（acknowledgement / continuation / no route available）。 */
  reason?: string;
  /** 拒絕原因 notes（menu gate 等）。 */
  notes?: string[];
}

// ---------------------------------------------------------------------------
// 檢視模型：一段文字 + 語意色調。text 自帶間距/標點，純渲染直接串接。
// ---------------------------------------------------------------------------

/**
 * 語意色調。卡片端（entry-card.ts）映射到 theme tokens；純文字端忽略色調。
 * `tier:*` 與 `thinking:*` 為開放前綴，值分別是 Tier / ThinkingLevel。
 */
export type Tone =
  | "badge" // COMPASS 徽章（卡片：accent 底）
  | "title" // 主體亮字（模型名）
  | "text" // 一般文字
  | "label" // 欄位標籤
  | "dim" // 分隔、provider 前綴、延遲
  | "rail" // 樹狀導軌
  | "number" // 數值
  | "muted" // 次要說明（reason / notes）
  | "accent"
  | "success"
  | "warning"
  | "error"
  // 符號語意（Part 5 Stage 5 的五種 entry 結果）
  | "switched"
  | "held"
  | "notify"
  | "skipped"
  | "unrouted"
  | `tier:${Tier}`
  | `thinking:${ThinkingLevel}`;

/** 一段同色文字。 */
export interface EntrySegment {
  text: string;
  tone: Tone;
}

/** 展開時的一列：固定寬度標籤 + 內容段落。 */
export interface EntryRow {
  label: string;
  segments: EntrySegment[];
}

/** 整條 entry 的結構化檢視。 */
export interface EntryView {
  /** 首行：徽章 + 符號 + 層級 + 目標模型。 */
  head: EntrySegment[];
  /** 收合時的脈絡列（一列帶過）；展開時由 rows 取代。 */
  summary: EntrySegment[];
  /** 展開明細列。 */
  rows: EntryRow[];
}

const SYMBOL_TONE: Record<EntrySymbol, Tone> = {
  "→": "switched",
  "=": "held",
  "•": "notify",
  "×": "skipped",
  "·": "unrouted",
};

const TIER_TONE: Record<Tier, Tone> = {
  quick: "tier:quick",
  standard: "tier:standard",
  high: "tier:high",
  premium: "tier:premium",
  xpremium: "tier:xpremium",
};

/** 展開列標籤固定寬度（ASCII 標籤，不含 CJK）。 */
const ROW_LABEL_WIDTH = 9;

/** 標籤補空白對齊（兩端共用，避免純文字與卡片各自對齊）。 */
export function padRowLabel(label: string): string {
  return label.padEnd(ROW_LABEL_WIDTH, " ");
}

function seg(text: string, tone: Tone = "text"): EntrySegment {
  return { text, tone };
}

function round(value: number, places: number): string {
  return value.toFixed(places);
}

/** 段落串列以 ` · ` 串接；直接 mutate out，呼叫端依序 push 各組段落。 */
function joinWith(sep: string, groups: EntrySegment[][]): EntrySegment[] {
  const out: EntrySegment[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (out.length > 0) out.push(seg(sep, "dim"));
    out.push(...group);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 各欄位段落組（收合 summary 與展開 rows 共用）
// ---------------------------------------------------------------------------

function kindSegs(entry: RouteEntry): EntrySegment[] {
  if (entry.kind === undefined) return [];
  const out = [seg(entry.kind, "text")];
  if (entry.kindConfidence !== undefined) {
    out.push(seg(" ", "dim"), seg(`${Math.round(entry.kindConfidence * 100)}%`, "number"));
  }
  return out;
}

function demandSegs(entry: RouteEntry): EntrySegment[] {
  if (entry.demand === undefined) return [];
  return [seg("demand ", "label"), seg(round(entry.demand, 2), "number")];
}

function scoringSegs(entry: RouteEntry): EntrySegment[] {
  const metrics: EntrySegment[][] = [];
  if (entry.complexity !== undefined) {
    metrics.push([seg("complexity ", "label"), seg(`${round(entry.complexity, 2)}/3`, "number")]);
  }
  if (entry.capability !== undefined) {
    metrics.push([seg("capability ", "label"), seg(`${round(entry.capability, 2)}/3`, "number")]);
  }
  if (entry.deepReasoning !== undefined) {
    metrics.push([seg("reasoning ", "label"), seg(round(entry.deepReasoning, 2), "number")]);
  }
  if (entry.demand !== undefined) {
    metrics.push([seg("demand ", "label"), seg(round(entry.demand, 2), "number")]);
  }
  return joinWith(" · ", metrics);
}

function thinkingSegs(entry: RouteEntry): EntrySegment[] {
  const t = entry.thinking;
  if (t === undefined) return [];
  // resolved → judged → applied（applied = clamp 後讀回值，Part 5 Stage 5）。
  const out = [seg("→ ", "dim"), seg(t.resolved, `thinking:${t.resolved}`)];
  if (t.judged !== undefined && t.judged !== t.resolved) {
    out.push(seg(" · judged ", "dim"), seg(t.judged, `thinking:${t.judged}`));
  }
  if (t.applied !== undefined && t.applied !== t.resolved) {
    out.push(seg(" (applied ", "dim"), seg(t.applied, `thinking:${t.applied}`), seg(")", "dim"));
  }
  return out;
}

function classifySegs(entry: RouteEntry): EntrySegment[] {
  const parts: EntrySegment[][] = [];
  if (entry.classify !== undefined) {
    const { source, latencyMs, hit } = entry.classify;
    parts.push([
      seg(source, "text"),
      seg(" ", "dim"),
      seg(`${latencyMs}ms`, "number"),
      seg(" ", "dim"),
      seg(hit ? "(hit)" : "(miss)", hit ? "success" : "dim"),
    ]);
  }
  if (entry.cacheMissUsd !== undefined) {
    parts.push([seg("cache miss ≈ ", "label"), seg(`$${entry.cacheMissUsd.toFixed(3)}`, "number")]);
  }
  return joinWith(" · ", parts);
}

function budgetSegs(entry: RouteEntry): EntrySegment[] {
  if (entry.budgetPressure === undefined) return [];
  return [seg(`${Math.round(entry.budgetPressure * 100)}% of cap`, "number")];
}

function notesSegs(entry: RouteEntry): EntrySegment[] {
  if (entry.notes === undefined || entry.notes.length === 0) return [];
  return [seg(entry.notes.join(" · "), "muted")];
}

function reasonSegs(entry: RouteEntry): EntrySegment[] {
  return entry.reason === undefined ? [] : [seg(entry.reason, "muted")];
}

/** 收合列欄位 → 段落組（`display.fields` 的每個名字各有一組；缺欄位回空）。 */
const SUMMARY_FIELDS: Record<DisplayField, (entry: RouteEntry) => EntrySegment[]> = {
  kind: kindSegs,
  demand: demandSegs,
  thinking: (e) => (e.thinking !== undefined ? [seg("thinking ", "label"), ...thinkingSegs(e)] : []),
  classify: classifySegs,
  budget: (e) => (budgetSegs(e).length > 0 ? [seg("budget ", "label"), ...budgetSegs(e)] : []),
  reason: reasonSegs,
  notes: notesSegs,
};

// ---------------------------------------------------------------------------
// buildEntryView：唯一內容來源
// ---------------------------------------------------------------------------

/**
 * 把 RouteEntry 攤成結構化檢視。
 *
 * - `head`（永遠顯示）：`compass <symbol> <tier>  <provider>/<model>`；
 *   未路由時 tier/target 為 null，head 只留徽章 + 符號。
 * - `summary`（收合時顯示）：一列脈絡——kind、demand、thinking、classify、
 *   budget、reason、notes，**缺欄位整段省略**（不為陳列而堆砌）。
 * - `rows`（展開時顯示）：task / scoring / thinking / budget / classify /
 *   picked / notes / reason 標籤列，取代 summary，不重複。
 */
export function buildEntryView(entry: RouteEntry, display: DisplayConfig = DISPLAY_DEFAULTS): EntryView {
  // 首行。
  const head: EntrySegment[] = [seg("compass", "badge"), seg(" ", "dim"), seg(entry.symbol, SYMBOL_TONE[entry.symbol])];
  if (entry.tier !== null) head.push(seg(" ", "dim"), seg(entry.tier, TIER_TONE[entry.tier]));
  if (entry.target !== null) {
    head.push(seg("  ", "dim"));
    if (entry.target.provider) head.push(seg(`${entry.target.provider}/`, "dim"));
    head.push(seg(entry.target.model, "title"));
  }

  // 收合脈絡列：欄位與順序由 `display.fields` 決定。
  const summary = joinWith(" · ", display.fields.map((field) => SUMMARY_FIELDS[field](entry)));

  // 展開明細列。
  const rows: EntryRow[] = [];
  const push = (label: string, segments: EntrySegment[]) => {
    if (segments.length > 0) rows.push({ label, segments });
  };
  push("task", kindSegs(entry));
  push("scoring", scoringSegs(entry));
  push("thinking", thinkingSegs(entry));
  push("budget", budgetSegs(entry));
  push("classify", classifySegs(entry));
  if (entry.picked !== undefined) push("picked", [seg(entry.picked, "title")]);
  push("notes", notesSegs(entry));
  push("reason", reasonSegs(entry));

  return { head, summary, rows };
}

// ---------------------------------------------------------------------------
// 佈局：依 display 決定顯示哪些列
// ---------------------------------------------------------------------------

/** 一列輸出：導軌 + 標籤 + 內容（純文字與卡片共用）。 */
export interface EntryLine {
  /** `├ `/`└ ` 樹狀導軌（`display.rails: false` 時為空字串）。 */
  rail: string;
  /** 已補寬的列標籤（空字串 = 無標籤列）。 */
  label: string;
  segments: EntrySegment[];
}

/**
 * 決定首行之下要顯示哪些列（Part 10.4、`display`）。
 *
 * - 展開（或 `detail: "full"`）：樹狀明細列；rows 為空時退回收合脈絡列。
 * - 收合 `detail: "standard"`：脈絡一列。
 * - 收合 `detail: "compact"`：只看決策首行（無列）。
 */
export function composeLines(
  view: EntryView,
  options: { expanded?: boolean; display?: DisplayConfig } = {},
): EntryLine[] {
  const display = options.display ?? DISPLAY_DEFAULTS;
  const expanded = options.expanded ?? true;

  if (expanded || display.detail === "full") {
    const rows = view.rows.length > 0 ? view.rows : [{ label: "", segments: view.summary }];
    return rows.map((row, i) => ({
      rail: display.rails ? (i === rows.length - 1 ? "└ " : "├ ") : "",
      label: row.label ? padRowLabel(row.label) : "",
      segments: row.segments,
    }));
  }
  if (display.detail === "standard" && view.summary.length > 0) {
    return [{ rail: "", label: "", segments: view.summary }];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 純文字渲染（測試 / 非 TUI 端；無 ANSI）
// ---------------------------------------------------------------------------

function plain(segments: EntrySegment[]): string {
  return segments.map((s) => s.text).join("");
}

/**
 * 純文字渲染（Part 10.4）。預設 `expanded: true`（完整明細）、預設 display。
 * 各列內容缺欄位時整段省略，不留下孤立分隔。
 */
export function renderEntry(
  entry: RouteEntry,
  options: { expanded?: boolean; display?: DisplayConfig } = {},
): string {
  const view = buildEntryView(entry, options.display);
  const lines = [plain(view.head)];
  for (const line of composeLines(view, options)) {
    lines.push(`${line.rail}${line.label}${plain(line.segments)}`);
  }
  return lines.join("\n");
}
