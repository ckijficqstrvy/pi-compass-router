// ui/wizard.ts — /compass-set 設定選單（SPEC Part 10.2）。
import type { CompassConfig, Mode, Profile, Target, Tier } from "../schema.js";

/** 供 TUI 選單與寫入落地的掛點（Part 10.2「hooks 形狀」節，2026-10-01 補）。 */
export interface WizardHooks {
  /** 逐項寫入驗證與落地（Part 3.4 白名單）。回 `null` 成功，回 `key: reason` 拒絕。 */
  write(key: string, value: unknown): string | null;
  /** 寫入後重載進執行中 session（Part 10.2：重載 → 才重繪）。 */
  reload(): void | Promise<void>;
  /** TUI 取一列輸入。回 `null` = 使用者取消（Esc）。 */
  prompt(label: string, initial?: string): Promise<string | null>;
  /** TUI 從清單選一項。回 `null` = 取消。 */
  pick(label: string, options: string[]): Promise<string | null>;
}

/**
 * 解析「模型鏈」字串為候選列表（選單顯示與檔案間的往返）。
 *
 * 形狀：`"provider/model, provider/model, ..."`——逗號分隔、去前後空白、
 * 跳過空段。單段無 `/` 時 provider 為 `""`（裸 model id，與 `targetKey`
 * 的編碼一致）。
 */
export function parseChain(input: string): Target[] {
  const out: Target[] = [];
  for (const segment of input.split(",")) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    out.push(splitTarget(trimmed));
  }
  return out;
}

/**
 * `"provider/model"` → `Target`。**前導 `~` 的 `/` 不是 provider 分隔**
 * （如 `~z-ai/glm-latest`）——與 `route/select.ts` 的 `targetFromKey` 同一
 * 規則，兩處編碼不一致會破壞 menu id 往返。
 */
function splitTarget(text: string): Target {
  if (text.startsWith("~")) return { provider: "", model: text };
  const slash = text.indexOf("/");
  if (slash <= 0) return { provider: "", model: text };
  return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
}

/**
 * 解析輸入的金額字串；不合法回 `null`（選單驗證用）。
 *
 * 接受 `"5"`、`"5.5"`、`"$5.00"`（前導 `$` 可有可無、千分位逗號忽略）；
 * 負數、`NaN`、`Infinity`、非數字 → `null`。
 */
export function parseAmount(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, "");
  if (cleaned === "" || !/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/** 已登記的 provider 顯示標籤（Part 10.2 選單顯示）。 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openrouter: "OpenRouter",
  laya: "Laya 本機（離線）",
  typesafe: "TypeSafe",
  vercel: "Vercel AI",
};

/**
 * provider 代號 → 顯示標籤。**未登記的 provider 原樣回傳**（不丟失名字，
 * 顯示層不該吞掉使用者的自訂 provider）。
 */
export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** 顯示標籤 → provider 代號（不分大小寫）；未登記回 `null`。 */
export function providerFromLabel(label: string): string | null {
  const lowered = label.toLowerCase();
  for (const [code, text] of Object.entries(PROVIDER_LABELS)) {
    if (text.toLowerCase() === lowered || code === lowered) return code;
  }
  return null;
}

/** mode → 顯示標籤（含短語說明，Part 10.2 選單格式）。 */
export function modeLabel(mode: Mode): string {
  switch (mode) {
    case "auto":
      return "auto — 自動切換";
    case "confirm":
      return "confirm — 每次切換前先問你";
    case "notify":
      return "notify — 只提醒不切換";
  }
}

/** 顯示標籤 → mode：取前綴 token（不分大小寫）；不認識回 `null`。 */
export function modeFromLabel(label: string): Mode | null {
  const token = label.trim().split(/\s+/)[0]?.toLowerCase();
  if (token === "auto" || token === "confirm" || token === "notify") return token;
  return null;
}

/** 選單項目（Part 10.2 清單的鍵 → 顯示行）。 */
type MenuItem =
  | "daily"
  | "monthly"
  | "mode"
  | "provider"
  | "checkpoint"
  | "chains"
  | "profile"
  | "cache"
  | "freeOnly"
  | "kindTiers"
  | "reset"
  | "quit";

const MENU_ORDER: readonly MenuItem[] = [
  "daily",
  "monthly",
  "mode",
  "provider",
  "checkpoint",
  "chains",
  "profile",
  "cache",
  "freeOnly",
  "kindTiers",
  "reset",
  "quit",
];

/** 一項設定的顯示行（供 `hooks.pick` 的 `options` 與重繪用）。 */
function renderRow(item: MenuItem, config: CompassConfig): string {
  const money = (n: number | null): string => (n === null ? "無上限" : `$${n.toFixed(2)}`);
  switch (item) {
    case "daily":
      return `每日上限 ................ ${money(config.budget.dailyUsd)}`;
    case "monthly":
      return `每月上限 ................ ${money(config.budget.monthlyUsd)}`;
    case "mode":
      return `路由模式 ................ ${modeLabel(config.mode)}`;
    case "provider":
      return `分類後端 ................ ${providerLabel(config.classify.provider)}`;
    case "checkpoint":
      return `Laya checkpoint .......... ${config.classify.model}`;
    case "chains":
      return `模型鏈 .................. quick 首選 ${config.routes.quick[0]?.model ?? "(空)"} · high 首選 ${config.routes.high[0]?.model ?? "(空)"}`;
    case "profile":
      return `價格 profile ............ ${config.profile}`;
    case "cache":
      return `cache 感知 .............. ${config.cache.aware ? "開" : "關"} · 冷卻 ${config.cache.cooldownSeconds}s`;
    case "freeOnly":
      return `特殊情境（free-only）..... ${config.freeOnly ? "開" : "關"}`;
    case "kindTiers": {
      const parts = Object.entries(config.kindMinimumTier).map(([kind, tier]) => `${kind}≥${tier}`);
      return `任務最低層級 ............ ${parts.join(" · ")}`;
    }
    case "reset":
      return `重設某項回預設 …`;
    case "quit":
      return `結束`;
  }
}

/**
 * 執行 /compass-set 選單（Part 10.2）：每項驗證 → 寫 config.json
 * （同目錄時間戳備份）→ 重載進執行中 session → 才重繪選單。
 *
 * 本函式是**選單迴圈**，實際的 TUI 顯示與檔案落地全交給 `hooks`（純資料 +
 * 掛點，便於測試：`hooks.pick` 回 `"quit"` 即退出）。任何一項寫入被拒
 * （`write()` 回 `key: reason`）→ 顯示原因、**不重繪該項**、不落檔。
 */
export async function runSettingsWizard(
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<void> {
  for (;;) {
    const rows = MENU_ORDER.map((item) => renderRow(item, config));
    const chosen = await hooks.pick("compass 設定（↑↓ 選擇，Enter 確認，Esc 結束）", rows);
    if (chosen === null) return; // Esc
    const item = itemOf(chosen, config);
    if (item === null || item === "quit") return;
    if (item === "reset") continue; // 重設子選單由 hooks 呈現，交還迴圈

    const edited = await editItem(item, config, hooks);
    if (edited === undefined || edited === null) continue; // 取消 / 寫入被拒
    const problem = hooks.write(edited.key, edited.value);
    if (problem !== null) continue;
    await hooks.reload();
    Object.assign(config, edited.applyTo(config));
  }
}

/**
 * 顯示行 → MenuItem 鍵。
 *
 * `hooks.pick` 回傳的正是我傳入的列字串（規格：pick 回 options 之一），
 * 故直接比對當前 `config` 下的列；萬一 hooks 回了陌生字串（非規格行為），
 * 落回**前綴 token 對 `MENU_ORDER`**的兜底，不崩。
 */
function itemOf(row: string, config: CompassConfig): MenuItem | null {
  const index = MENU_ORDER.findIndex((item) => renderRow(item, config) === row);
  if (index !== -1) return MENU_ORDER[index];
  // 兜底：以列首 token 匹配項目鍵（例如 "quit"、"reset" 等原子名）。
  const token = row.trim().split(/\s+/)[0];
  return (MENU_ORDER as readonly string[]).includes(token) ? (token as MenuItem) : null;
}

/** 一項設定的編輯結果：要寫的 key/value + 寫入後如何反映到 config。 */
interface EditResult {
  key: string;
  value: unknown;
  applyTo(config: CompassConfig): Partial<CompassConfig>;
}

/** 依項目提示使用者編輯；回 `undefined` 取消、`null` 已被 hooks 呈現拒絕。 */
async function editItem(
  item: MenuItem,
  config: CompassConfig,
  hooks: WizardHooks,
): Promise<EditResult | undefined | null> {
  switch (item) {
    case "daily":
    case "monthly": {
      const key = item === "daily" ? "budget" : "budget";
      const initial = item === "daily" ? String(config.budget.dailyUsd ?? "") : String(config.budget.monthlyUsd ?? "");
      const raw = await hooks.prompt(item === "daily" ? "每日上限（數字，留空=無上限）" : "每月上限（數字，留空=無上限）", initial);
      if (raw === null) return undefined;
      const amount = raw.trim() === "" ? null : parseAmount(raw);
      if (raw.trim() !== "" && amount === null) return null;
      const budget = { ...config.budget, ...(item === "daily" ? { dailyUsd: amount } : { monthlyUsd: amount }) };
      return { key, value: budget, applyTo: () => ({ budget }) };
    }
    case "mode": {
      const picked = await hooks.pick("路由模式", (["auto", "confirm", "notify"] as Mode[]).map(modeLabel));
      if (picked === null) return undefined;
      const mode = modeFromLabel(picked);
      if (mode === null) return null;
      return { key: "mode", value: mode, applyTo: () => ({ mode }) };
    }
    case "provider": {
      const picked = await hooks.pick("分類後端", ["laya", "cloud"].map(providerLabel));
      if (picked === null) return undefined;
      const provider = providerFromLabel(picked);
      if (provider === null || (provider !== "laya" && provider !== "cloud")) return null;
      const classify = { ...config.classify, provider: provider as "laya" | "cloud" };
      return { key: "classify", value: classify, applyTo: () => ({ classify }) };
    }
    case "checkpoint": {
      const raw = await hooks.prompt("Laya checkpoint id 或路徑", config.classify.model);
      if (raw === null) return undefined;
      const model = raw.trim();
      if (model === "") return null;
      const classify = { ...config.classify, model };
      return { key: "classify", value: classify, applyTo: () => ({ classify }) };
    }
    case "chains": {
      const initial = config.routes.quick.map((t) => (t.provider ? `${t.provider}/${t.model}` : t.model)).join(", ");
      const raw = await hooks.prompt("quick 鏈（provider/model, …）", initial);
      if (raw === null) return undefined;
      const chain = parseChain(raw);
      if (chain.length === 0) return null;
      const routes = { ...config.routes, quick: chain.map((t) => ({ ...t, explicit: true })) };
      return { key: "routes", value: routes, applyTo: () => ({ routes }) };
    }
    case "profile": {
      const picked = await hooks.pick("價格 profile", (["cheap", "balanced", "quality"] as Profile[]));
      if (picked === null) return undefined;
      if (picked !== "cheap" && picked !== "balanced" && picked !== "quality") return null;
      return { key: "profile", value: picked, applyTo: () => ({ profile: picked }) };
    }
    case "cache": {
      const picked = await hooks.pick("cache 感知", ["開", "關"]);
      if (picked === null) return undefined;
      if (picked !== "開" && picked !== "關") return null;
      const cache = { ...config.cache, aware: picked === "開" };
      return { key: "cache", value: cache, applyTo: () => ({ cache }) };
    }
    case "freeOnly": {
      const picked = await hooks.pick("特殊情境（free-only）", ["開", "關"]);
      if (picked === null) return undefined;
      if (picked !== "開" && picked !== "關") return null;
      const freeOnly = picked === "開";
      return { key: "freeOnly", value: freeOnly, applyTo: () => ({ freeOnly }) };
    }
    case "kindTiers": {
      const raw = await hooks.prompt("任務最低層級（kind≥tier, …）", Object.entries(config.kindMinimumTier).map(([k, t]) => `${k}≥${t}`).join(", "));
      if (raw === null) return undefined;
      const parsed: Record<string, Tier> = {};
      for (const segment of raw.split(",")) {
        const [kind, tier] = segment.trim().split("≥");
        if (!kind || !tier) continue;
        parsed[kind.trim()] = tier.trim() as Tier;
      }
      if (Object.keys(parsed).length === 0) return null;
      const kindMinimumTier = { ...config.kindMinimumTier, ...parsed };
      return { key: "kindMinimumTier", value: kindMinimumTier, applyTo: () => ({ kindMinimumTier }) };
    }
    default:
      return undefined;
  }
}