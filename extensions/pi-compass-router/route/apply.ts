// route/apply.ts — Stage 5：套用切換與 transcript entry（SPEC Part 5 Stage 5）。
import { sanitizeRemote } from "../classify/analysis.js";
import type { Mode, Target, ThinkingLevel, Tier } from "../schema.js";
import type { GuardOutcome } from "./guard.js";
import type { RouteEntry } from "../ui/entries.js";
import { targetKey } from "./select.js";

/** pi 提供的切換掛點（Part 5 Stage 5：setModel + setThinkingLevel + read back）。 */
export interface ApplyHooks {
  setModel(target: Target): Promise<void> | void;
  setThinkingLevel(level: ThinkingLevel): Promise<void> | void;
  /** 套用後讀回實際層級（模型會 clamp）（Part 5 Stage 5）。 */
  readThinkingLevel?(): ThinkingLevel | undefined;
  /**
   * 寫一條 transcript entry（`excludeFromContext: true`）。呼叫端（`index.ts`）
   * 負責實際寫入與合併同因同模型的重複 skip（Part 10.4）。
   */
  writeEntry?(entry: RouteEntry): void;
}

/** Stage 5 輸入：由 guard 與 mode 組成的決策。 */
export interface ApplyDecision {
  outcome: GuardOutcome;
  /** skipped（continuation/no-route）沒有目標模型。 */
  target?: Target;
  thinking: ThinkingLevel;
  mode: Mode;
  /** skipped 可無層級（entry 顯示 null）。 */
  tier?: Tier;
  /** guard 的理由（budget/cache/cooldown），寫進 entry。 */
  reason?: string;
  /** 分類資訊（entry 的 `classify` 欄）。 */
  classify?: { source: string; latencyMs: number; hit: boolean };
  /** composed demand（entry 展開欄）。 */
  demand?: number;
  /** 估算的 prompt-cache miss 成本（USD，Part 7）；未知不寫。 */
  cacheMissUsd?: number;
  /** menu gate 拒絕 notes。 */
  notes?: string[];
  /** 未路由原因（continuation / no route available）。 */
  skipReason?: string;
}

/** Stage 5 結果：呼叫端（index.ts）依此決定 confirm 何時問、是否重試下一候選。 */
export interface ApplyOutcome {
  /** entry 符號：→ 切換、= 保持、• 通知、× 跳過（Part 5 Stage 5）。 */
  symbol: "→" | "=" | "•" | "×";
  /** 是否真的呼叫了 setModel。 */
  applied: boolean;
  /** 套用後讀回的思考層級（readThinkingLevel 缺或失敗時為 undefined）。 */
  appliedThinking?: ThinkingLevel;
  /** confirm 模式下呼叫端應先詢問（apply 不阻塞等待輸入，見 Part 5 補）。 */
  needsConfirm: boolean;
  /** 套用失敗（setModel/setThinkingLevel 拋錯，已捕獲且不外傳）。 */
  failed: boolean;
  /** 失敗訊息（已 sanitizeRemote 上限），僅 `failed` 為真時有意義。 */
  error?: string;
  /** 本條 entry（已組好，供 writeEntry 或呼叫端轉發）。 */
  entry: RouteEntry;
}

/** 把 stage 5 的決策映射成 entry 符號（Part 5 Stage 5 符號表）。 */
function symbolFor(outcome: GuardOutcome, mode: Mode): "→" | "=" | "•" | "×" {
  if (outcome === "held") return "=";
  if (outcome === "notify-only") return "•";
  if (outcome === "skipped") return "×";
  // applied：auto/confirm 真切 → "→"；notify 不動僅通知 → "•"。
  return mode === "notify" ? "•" : "→";
}

/**
 * Stage 5（Part 5）。
 *
 * - `auto` + applied → 切模型、套 thinking、read back；
 * - `confirm` + applied → **只標 `needsConfirm`，不阻塞詢問**（詢問是 UI 層
 *   `index.ts` 的事，見 Part 5 補）；
 * - `notify` + applied → 不切、不套 thinking，entry 標 `not applied (notify mode)`；
 * - `held` / `skipped` → 不切，但**所有模式都套 thinking**（修正陳舊思考）。
 *
 * **永不 throw**（Part 2 fail-open）：`setModel`／`setThinkingLevel` 拋錯 →
 * 捕獲、`failed: true`、error 經 `sanitizeRemote` 上限，維持原模型繼續回合。
 * **`readThinkingLevel` 缺時 `appliedThinking` 留空**（不假裝成功）。
 */
export async function applyRoute(
  decision: ApplyDecision,
  hooks: ApplyHooks,
): Promise<ApplyOutcome> {
  const { outcome, target, thinking, mode } = decision;
  const symbol = symbolFor(outcome, mode);

  const entry: RouteEntry = {
    symbol,
    tier: decision.tier ?? null,
    target: target ?? null,
    reason: decision.reason ?? decision.skipReason,
    notes: decision.notes,
    classify: decision.classify,
    demand: decision.demand,
    thinking: { resolved: thinking },
  };
  if (decision.notes && decision.notes.length > 0) entry.notes = decision.notes;
  if (decision.cacheMissUsd !== undefined) entry.cacheMissUsd = decision.cacheMissUsd;

  const wantsModel = outcome === "applied" && mode === "auto"; // confirm 已在上方提前回傳
  const wantsThinking =
    outcome === "held" ||
    outcome === "skipped" ||
    (outcome === "applied" && mode === "auto");

  const result: ApplyOutcome = {
    symbol,
    applied: false,
    needsConfirm: outcome === "applied" && mode === "confirm",
    failed: false,
    entry,
  };

  // notify 的 applied：不動模型、不套 thinking（Part 5 mode 表）。
  if (outcome === "applied" && mode === "notify") {
    entry.reason = [decision.reason, "not applied (notify mode)"].filter(Boolean).join(" · ");
    hooks.writeEntry?.(entry);
    return result;
  }

  // confirm 的 applied：**只標 needsConfirm，絕不切模型、也不寫 entry**（詢問是
  // index.ts 的事）。2026-10-03（W7）：先前在確認前就寫一筆「已切換」entry，
  // 拒絕時留下假紀錄、接受時變成兩筆；entry 由呼叫端在 final outcome 後才寫。
  if (outcome === "applied" && mode === "confirm") {
    return result;
  }

  let error: string | undefined;

  if (wantsModel) {
    if (target === undefined) {
      // 不可能：applied 必経 select。保險起見 fail-open（W10 後 target 可為空）。
      result.failed = true;
      error = "apply failed: no target for an applied outcome";
    } else {
      try {
        await hooks.setModel(target);
        result.applied = true;
        if (symbol === "→") entry.symbol = "→";
      } catch (e) {
        result.failed = true;
        error = `apply failed: ${sanitizeRemote(e instanceof Error ? e.message : e)}`;
        result.needsConfirm = false;
      }
    }
  }

  if (wantsThinking && error === undefined) {
    try {
      await hooks.setThinkingLevel(thinking);
      const read = hooks.readThinkingLevel?.();
      if (read !== undefined) {
        result.appliedThinking = read;
        entry.thinking = { resolved: thinking, applied: read };
      }
    } catch (e) {
      // thinking 套用失敗不改模型切換結果，但記錄（不讓 entry 假裝成功）。
      result.failed = true;
      error = error ?? `apply failed: ${sanitizeRemote(e instanceof Error ? e.message : e)}`;
    }
  } else if (wantsThinking && error !== undefined) {
    // 模型已失敗，不再動 thinking（保持原狀，fail-open）。
  }

  if (error !== undefined) {
    result.error = error;
    entry.reason = error;
  }

  hooks.writeEntry?.(entry);
  return result;
}