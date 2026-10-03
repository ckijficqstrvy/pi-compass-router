// ui/strings.ts — 界面字串（gettext 式，Part 3.1 `display.language`）。
//
// 用法：所有**使用者可見**字串以 zh 原文為鍵，顯示時經 `t()`：
//   - 純字串：`t("開")`
//   - 帶插值：標籤模板 `` t`已寫入 ${key}` ``（鍵 = 原文、洞以 `${}` 佔位）
// zh 模式原樣回傳（零改動、測試不斷）；en 模式查 `EN` 表，**缺漏回原文**
// （最糟也只是沒翻，不會壞）。
//
// 完整性由 `test/i18n.test.ts` 掃描保證：每個 t() 鍵都必須有 EN 翻譯。
// 模組層常數（CUSTOM_OPTION 等）**保持 raw zh**，在使用處才 t()——避免
// 匯入時凍結語言。
import type { UiLang } from "../schema.js";

/** 標籤模板的洞在鍵/譯文中的佔位符。 */
const HOLE = "${}";

let current: UiLang = "zh";

/** 設定目前界面語言（`runSettingsWizard` 迴圈頂與 session 啟動時呼叫）。 */
export function setLang(lang: UiLang): void {
  current = lang;
}

/** 目前界面語言。 */
export function langOf(): UiLang {
  return current;
}

/** zh 原文 → English。鍵含 `${}` 佔位者依序替換參數。 */
export const EN: Record<string, string> = {
  // ---- 共用小詞 / 選項 ----
  "開": "On",
  "關": "Off",
  "取消": "Cancel",
  "確定，重設": "Yes, reset",
  "無上限": "no cap",
  "無上限（清除）": "No cap (clear)",
  "依 profile": "Per profile",
  "依 profile（清除自訂）": "Per profile (clear override)",
  "依 profile 價格帶": "per-profile price bands",
  "自訂…（打字輸入）": "Custom… (type it in)",
  "搜尋…（打關鍵字縮小清單）": "Search… (narrow the list)",
  "清除（回預設／自動）": "Clear (back to default/auto)",
  "← 返回": "← Back",
  "← 完成（套用）": "← Done (apply)",
  "結束": "Done",
  "空": "empty",
  "(空)": "(empty)",
  "未設定": "unset",
  "不可用": "unavailable",
  "中文": "Chinese",

  // ---- 模式 / 層級 / profile / thinking 標籤 ----
  "mode": "mode",
  "auto — 自動切換": "auto — switch automatically",
  "confirm — 每次切換前先問你": "confirm — ask before each switch",
  "notify — 只提醒不切換": "notify — notify only, never switch",
  "quick — 最快最省": "quick — fastest & cheapest",
  "standard — 一般預設": "standard — everyday default",
  "high — 困難任務": "high — hard tasks",
  "premium — 旗艦": "premium — flagship",
  "xpremium — 需 xpremium.enabled": "xpremium — requires xpremium.enabled",
  "上限下修，更早用便宜模型": "Tighter caps — cheaper models kick in earlier",
  "折衷預設": "Balanced default",
  "放寬上限，品質優先": "Looser caps — quality first",
  "${} — ${}（$/M 上限：${}）": "${} — ${} ($/M caps: ${})",
  "不思考": "none",
  "最少": "minimal",
  "少": "light",
  "中": "moderate",
  "多": "deep",
  "很多": "deeper",
  "最多": "deepest",

  // ---- provider ----
  "laya — 本地 Laya-MLX（離線、免 key）": "laya — local Laya-MLX (offline, no key)",
  "cloud — 雲端 typesafe 分類器（需 API key）": "cloud — cloud typesafe classifier (needs API key)",

  // ---- 分組名與選單框架 ----
  "① 路由行為": "① Routing",
  "② 預算與花費": "② Budget",
  "③ 模型與層級": "③ Models & tiers",
  "④ 分類器": "④ Classifier",
  "⑤ 政策與過濾": "⑤ Policy",
  "⑥ 顯示與呈現": "⑥ Display",
  "⑦ 重設・診斷": "⑦ Reset & diagnostics",
  "compass 設定（↑↓ 選組，Enter 進入，Esc 結束）": "compass settings (↑↓ pick group, Enter open, Esc quit)",

  // ---- 項目名（ITEM_NAMES） ----
  "啟用 compass": "Enable compass",
  "路由模式": "Routing mode",
  "粘住當前模型": "Stick to current model",
  "手動挑模型": "Manual model pick",
  "允許未評分模型": "Allow unrated models",
  "思考層級": "Thinking level",
  "切換成本 cache": "Switch-cost cache",
  "每日上限": "Daily cap",
  "每月上限": "Monthly cap",
  "預算警戒線": "Budget thresholds",
  "價格 profile": "Price profile",
  "特殊情境（free-only）": "Special mode (free-only)",
  "模型鏈": "Model chains",
  "專家鏈": "Expert chains",
  "prefer 首選": "prefer (first pick)",
  "任務最低層級": "Task minimum tier",
  "xpremium 層": "xpremium tier",
  "內建模型鏈": "Built-in chains",
  "分類後端": "Classifier backend",
  "分類模型": "Classifier model",
  "分類快取": "Classifier cache",
  "分類參數": "Classifier params",
  "過濾規則": "Filter rules",
  "價格天花板": "Price ceilings",
  "呈現密度": "Detail density",
  "收合列欄位": "Collapsed fields",
  "compass 徽章": "compass badge",
  "配色": "Color scheme",
  "expand 提示": "Expand hint",
  "樹狀導軌": "Tree rails",
  "界面語言": "UI language",
  "重設某項回預設": "Reset an item to default",
  "測試分類器": "Test classifier",
  "看鏈的來源": "Chain sources",

  // ---- 分組列 ----
  "① 路由行為 ........... ${} · 粘住 ${} · 挑模型 ${}": "① Routing ........... ${} · stick ${} · pick ${}",
  "② 預算與花費 .......... ${}/日 · ${}/月 · ${}": "② Budget ............ ${}/day · ${}/mo · ${}",
  "③ 模型與層級 .......... quick ${} · 專家 ${} 種${}": "③ Models & tiers .... quick ${} · ${} expert kinds${}",
  "④ 分類器 ............. ${} · TTL ${}s · timeout ${}ms": "④ Classifier ........ ${} · TTL ${}s · timeout ${}ms",
  "⑤ 政策與過濾 .......... deny ${} · ceilings ${} · prefer ${}": "⑤ Policy ............ deny ${} · ceilings ${} · prefer ${}",
  "⑥ 顯示與呈現 ........... ${} · 欄位 ${} · ${}${}": "⑥ Display ........... ${} · fields ${} · ${}${}",
  "⑦ 重設・診斷 .......... 重設某項 · 測試分類器 · 看鏈的來源": "⑦ Reset & diagnostics .. reset · test classifier · chain sources",
  " ⚠快照 ${}天": " ⚠ snapshot ${}d old",
  " · 徽章": " · badge",
  "依 profile ${}": "per profile ${}",
  "自訂 ${}": "custom ${}",
  "${} 自訂": "${} custom",
  "${} 層自訂": "${} custom tiers",
  "路由模式（目前：${}）": "routing mode (currently: ${})",
  "off — 不挑，走自動路由": "off — no manual pick, auto-routing",
  "menu — 每次用選單挑": "menu — pick from a list each time",
  "思考層級：選範圍": "Thinking level: pick a scope",
  "分類結果快取": "Classifier result cache",
  "rich — 全彩（跟隨主題）": "rich — full color (follows theme)",
  "mono — 單色（只留明暗，適合截圖／淺色主題）": "mono — grayscale (brightness only; good for screenshots/light themes)",
  "expand 提示（收合行尾）": "Expand hint (on the collapsed line)",

  // ---- 項目列（值） ----
  "${}${}${}（避免反覆切換）": "${}${}${} (avoids flip-flopping)",
  "${}${}${}（menu = 每次用選單挑）": "${}${}${} (menu = pick each time)",
  "${}${}${}（事實檔沒有的模型也能被選）": "${}${}${} (models missing from facts too)",
  "依層級預設": "tier default",
  "${}${}${} · 冷卻 ${}s": "${}${}${} · cooldown ${}s",
  "${}${}${}%（警戒）/ ${}%（強制）": "${}${}${}% (warn) / ${}% (force)",
  "${}${}${}（只用 $0 模型）": "${}${}${} ($0 models only)",
  "${}${}${} 種有專家鏈": "${}${}${} expert chains",
  "${} 層有偏好首選": "${} tiers have a first pick",
  "${}${}${}（premium 之上再一層）": "${}${}${} (one tier above premium)",
  "${}${}${}（關 = 只用你自帶的模型）": "${}${}${} (off = only your own models)",
  "${}${}timeout ${}ms · 門檻 ${} · 最短 ${} 字": "${}${}timeout ${}ms · threshold ${} · min ${} chars",
  "${}${}${}（${}）": "${}${}${} (${})",
  "${}${}${}（- = 不顯示）": "${}${}${} (- = hidden)",
  "mono（單色，只留明暗）": "mono (grayscale, brightness only)",
  "rich（全彩）": "rich (full color)",
  "${}${}跑一輪真分類（不切換）": "${}${}run one real classify (no switch)",
  "${}${}哪一層在決定每條鏈": "${}${}which layer decides each chain",

  // ---- 編輯流程字串 ----
  "pin（全域覆蓋）": "pin (global override)",
  "${} 的思考層級": "thinking level for ${}",
  "切換成本 cache：選欄位": "Switch-cost cache: pick a field",
  "cache 感知": "cache awareness",
  "冷卻秒數 — ${}s": "Cooldown seconds — ${}s",
  "死區 deadband — ${}": "Deadband — ${}",
  "切換懲罰上限 — $${}": "Switch penalty cap — $${}",
  "繞過層級差 — ${}": "Bypass tier delta — ${}",
  "感知（aware）— ${}": "Aware (cost-aware) — ${}",
  "${}（數字）": "${} (number)",
  "「${}」不是有效數字": "“${}” is not a valid number",
  "沿用目前": "Keep current",
  "沿用目前 ${}": "Keep current ${}",
  "${}（美元數字，留空 = 無上限）": "${} (USD amount, empty = no cap)",
  "「${}」不是有效金額（需 > 0；要清除請留空）": "“${}” is not a valid amount (must be > 0; leave empty to clear)",
  "預算警戒線：選欄位": "Budget thresholds: pick a field",
  "軟警戒線 softRatio — ${}": "Soft warning softRatio — ${}",
  "強制線 hardRatio — ${}": "Hard line hardRatio — ${}",
  "${}（0–1 之間）": "${} (between 0–1)",
  "「${}」不是 0–1 之間的數字": "“${}” is not a number between 0–1",
  "價格 profile（目前：${}）": "Price profile (currently: ${})",
  "模型鏈：選層級": "Model chains: pick a tier",
  "專家鏈：選任務種類": "Expert chains: pick a task kind",
  "${} 鏈 · 目前 ${}": "${} chain · currently ${}",
  "設為首選…": "Set as first pick…",
  "放到末尾…": "Append…",
  "移除一個模型…": "Remove a model…",
  "改回自動（清除你寫的）": "Back to auto (clear yours)",
  "自訂整條字串…": "Custom chain string…",
  "${} 鏈（provider/model, 逗號分隔）": "${} chain (provider/model, comma-separated)",
  "至少要一個模型，例如 openrouter/x": "need at least one model, e.g. openrouter/x",
  "${} 鏈：移除哪一個？": "${} chain: remove which one?",
  "鏈不能是空的——至少留一個模型（要整層回自動，選「改回自動」）": "A chain cannot be empty — keep at least one model (to reset the tier, pick “Back to auto”)",
  "${} 鏈：${}": "${} chain: ${}",
  "選首選模型": "pick the first-pick model",
  "選要放的模型": "pick a model to place",
  "prefer 首選：選層級": "prefer first pick: pick a tier",
  "${}（${}）": "${} (${})",
  "${} 的偏好首選（會插到鏈首）": "${} first pick (inserted at chain head)",
  "${} 偏好首選（模型 id）": "${} first pick (model id)",
  "模型 id 不能是空字串": "model id cannot be empty",
  "任務最低層級：選種類": "Task minimum tier: pick a kind",
  "${} — 目前 ${}": "${} — currently ${}",
  "（無下限）": "(no floor)",
  "${} 的最低層級": "minimum tier for ${}",
  "分類後端（目前：${}）": "Classifier backend (currently: ${})",
  "分類模型（cloud）": "Classifier model (cloud)",
  "${}（id 或路徑）": "${} (id or path)",
  "分類快取：選欄位": "Classifier cache: pick a field",
  "分類結果快取 — ${}": "Result cache — ${}",
  "快取秒數（TTL）— ${}s": "TTL seconds — ${}s",
  "分類快取秒數（TTL）": "Cache TTL (seconds)",
  "分類快取秒數（TTL，整數秒）": "Cache TTL (whole seconds)",
  "「${}」不是整數秒": "“${}” is not a whole number of seconds",
  "分類參數：選欄位": "Classifier params: pick a field",
  "分類逾時 timeoutMs — ${}ms": "Timeout timeoutMs — ${}ms",
  "判斷門檻 confidenceThreshold — ${}": "Confidence floor confidenceThreshold — ${}",
  "最短字數 minPromptChars — ${}": "Min chars minPromptChars — ${}",
  "歷史輪數 historyTurns — ${}": "History turns historyTurns — ${}",
  "過濾規則：選一份清單": "Filter rules: pick a list",
  "deny — 排除模型／glob（${}）": "deny — exclude models/globs (${})",
  "allowProviders — 只放行這些 provider（${}）": "allowProviders — only allow these providers (${})",
  "deny：選一項切換（✓ = 已排除）": "deny: pick one to toggle (✓ = excluded)",
  "allowProviders：選一項切換（✓ = 已放行）": "allowProviders: pick one to toggle (✓ = allowed)",
  "新增 glob 模式…": "Add glob pattern…",
  "新增 provider…": "Add provider…",
  "新增 deny 模式（glob，例如 openai/*）": "New deny pattern (glob, e.g. openai/*)",
  "新增 provider 代號": "New provider code",
  "內容不能是空字串": "contents cannot be empty",
  "價格天花板：選層級": "Price ceilings: pick a tier",
  "${} 的天花板（$/M：input+2×output）": "${} ceiling ($/M: input+2×output)",
  "${} 天花板（$/M 數字）": "${} ceiling ($/M number)",
  "呈現密度（目前：${}）": "Detail density (currently: ${})",
  "只看決策首行": "decision line only",
  "脈絡一列（預設）": "one context line (default)",
  "直接攤開明細": "full breakdown, always open",
  "收合列欄位：選一項切換（✓ = 顯示）": "Collapsed fields: pick one to toggle (✓ = shown)",
  "樹狀導軌（├/└）": "Tree rails (├/└)",
  "重設哪一項？（清單為白名單可寫鍵）": "Reset which item? (list = writable whitelist keys)",
  "重設 ${} 回預設？": "Reset ${} to default?",
  "enabled — ${}": "enabled — ${}",
  "mode — ${}": "mode — ${}",
  "profile — ${}": "profile — ${}",
  "budget — ${} / ${}": "budget — ${} / ${}",
  "cache — ${} · 冷卻 ${}s": "cache — ${} · cooldown ${}s",
  "kindMinimumTier — ${} 種": "kindMinimumTier — ${} kinds",
  "freeOnly — ${}": "freeOnly — ${}",
  "classify — ${} · ${}": "classify — ${} · ${}",
  "deny — ${} 條": "deny — ${} entries",
  "allowProviders — ${} 條": "allowProviders — ${} entries",
  "modelPick — ${}": "modelPick — ${}",
  "stickiness — ${}": "stickiness — ${}",
  "autoRoutes — ${}": "autoRoutes — ${}",
  "allowUnratedPicks — ${}": "allowUnratedPicks — ${}",
  "useDefaultModels — ${}": "useDefaultModels — ${}",
  "xpremium — ${}": "xpremium — ${}",
  "thinking — pin ${}": "thinking — pin ${}",
  "display — ${} · ${}": "display — ${} · ${}",
  "prefer — ${} 層": "prefer — ${} tiers",
  "ceilings — ${} 層自訂": "ceilings — ${} custom tiers",
  "routes — 全部五層回自動派生": "routes — all five tiers back to auto-derived",
  "kindModels — 全部回層級鏈": "kindModels — all back to tier chains",
  "（無）": "(none)",
  "看鏈的來源：選層級": "Chain sources: pick a tier",
  "${} 鏈（事實檔 ${} · 自動推導 ${} · 內建 ${}）": "${} chain (facts ${} · auto-derive ${} · built-in ${})",
  "⚠ 事實檔快照已 ${} 天——建議跑 npm run refresh-facts（價格與模型清單會跟著更新）": "⚠ facts snapshot is ${} days old — run npm run refresh-facts (prices and model lists update with it)",
  "你寫的（鎖定，不過濾）": "yours (locked, never filtered)",
  "自動派生／內建": "auto-derived / built-in",
  "  prefer 首選 ${} — 會插到鏈首（L3）": "  prefer ${} — inserted at chain head (L3)",
  "  ${} — ${}": "  ${} — ${}",
  "自動${}": "auto ${}",
  "你寫${}": "yours ${}",

  // ---- 通知 / 一般訊息 ----
  "compass 狀態 / on|off / mode / budget / why / revert / suggest": "compass status / on|off / mode / budget / why / revert / suggest",
  "compass 狀態 / on|off / mode / budget / why / revert / suggest / refresh-facts": "compass status / on|off / mode / budget / why / revert / suggest / refresh-facts",
  "/compass-set 設定選單（寫 config.json + 時間戳備份）": "/compass-set settings menu (writes config.json with timestamped backup)",
  "/compass-route <text> 分類任意文字並顯示建議（不切換）": "/compass-route <text> classify any text and show the suggestion (no switch)",
  "沒有分類器（backend 未啟用）": "no classifier (backend not enabled)",
  "回一個字就好": "Just reply with a single word",
  "分類失敗：${}": "classify failed: ${}",
  "這個環境不支援測試分類器（沒有掛點）": "this environment does not support testing the classifier (no hook)",
  "${}——再試一次（Esc 取消）": "${} — try again (Esc to cancel)",
  "${}：關鍵字（篩選 ${} 筆）": "${}: keyword (filter ${} items)",
  "關鍵字不能是空字串": "keyword cannot be empty",
  "「${}」沒有符合的模型——再搜一次（Esc 取消）": "No models match “${}” — search again (Esc to cancel)",
  "已寫入 ${}": "saved ${}",
  "未寫入：${}": "not saved: ${}",
  "未識別的選單項目：${}": "unrecognized menu row: ${}",
  "未識別的項目：${}": "unrecognized item: ${}",
  "${}：選一項": "${}: pick one",
  "展開看完整明細": "to view the full breakdown",
  "（展開看完整明細）": "(expand for the full breakdown)",
};

/** 反向表：EN 譯文 → zh 原文（**只收無洞的固定鍵**；建一次）。 */
let REVERSE: Map<string, string> | null = null;
function reverse(): Map<string, string> {
  if (REVERSE === null) {
    REVERSE = new Map();
    for (const [key, value] of Object.entries(EN)) {
      if (!key.includes(HOLE) && !REVERSE.has(value)) REVERSE.set(value, key);
    }
  }
  return REVERSE;
}

/**
 * 顯示字串 → 原文鍵（選單回傳值用）。en 模式查反向表；無洞的固定項
 * （CUSTOM_OPTION、動作選項、「開」等）自動翻回，**比較點維持原文**；
 * 含洞的組合字串（欄位列等）查不到就原樣回傳，由呼叫端以同一變數比對。
 */
export function rawOf(displayed: string): string {
  if (current === "zh") return displayed;
  return reverse().get(displayed) ?? displayed;
}

/**
 * 翻譯一則字串。兩種呼叫：
 *   `t("開")` — 純字串；
 *   `` t`已寫入 ${key}` `` — 標籤模板（鍵 = 字面跨度以 `${}` 串接）。
 */
export function t(literals: string, ...values: unknown[]): string;
export function t(literals: TemplateStringsArray, ...values: unknown[]): string;
export function t(literals: string | TemplateStringsArray, ...values: unknown[]): string {
  return translate(current, literals, values);
}

/**
 * 同上，但**指定語言**（不依全域 `setLang`）——給渲染端用（例如 entry 卡片
 * 依 `display.language` 出提示，不因 wizard 或其他呼叫而漂移）。
 */
export function tl(lang: UiLang, literals: string, ...values: unknown[]): string;
export function tl(lang: UiLang, literals: TemplateStringsArray, ...values: unknown[]): string;
export function tl(lang: UiLang, literals: string | TemplateStringsArray, ...values: unknown[]): string {
  return translate(lang, literals, values);
}

function translate(
  lang: UiLang,
  literals: string | TemplateStringsArray,
  values: unknown[],
): string {
  const key = typeof literals === "string" ? literals : literals.join(HOLE);
  const pattern = lang === "zh" ? key : (EN[key] ?? key);
  if (typeof literals === "string" || values.length === 0) return pattern;
  const parts = pattern.split(HOLE);
  let out = parts[0] ?? "";
  for (let i = 0; i < values.length; i++) out += String(values[i]) + (parts[i + 1] ?? "");
  return out;
}
