// route/guard.ts — Stage 4：守衛（SPEC Part 5：可用性 / stickiness /
// budget / cache / cooldown，順序固定）。
import type { CompassConfig, Mode, Target, Tier } from "../schema.js";

/** Stage 4 決策結果（Part 5 頭部介面）。 */
export type GuardOutcome = "applied" | "held" | "notify-only" | "skipped";

/** 守衛需要的 session 狀態（state.json 與當前模型）。 */
export interface GuardState {
  currentModel: string | null;
  currentTier: Tier | null;
  todayUsd: number;
  monthUsd: number;
  lastSwitchAtMs: number | null;
}

/** Stage 4 輸出。 */
export interface GuardResult {
  outcome: GuardOutcome;
  tier: Tier;
  /** 降級/擋下原因（budget pressure、cache miss 估算、cooldown 等）。 */
  reason?: string;
}

/**
 * Stage 4：
 * 1. 可用性（不存在/未認證 → 下一候選）
 * 2. stickiness（當前即目標 → held）
 * 3. budget（pressure ≥ softRatio 降一層重跑 Stage 3；
 *    ≥ hardRatio 強制 quick，demand ≥ 2.5 例外）
 * 4. cache（Part 7 切換成本）
 * 5. cooldown（cooldownSeconds 內僅大跳/hardRatio 降級可再切）
 *
 * mode（auto/confirm/notify）決定 Stage 5 動作，見 apply.ts。
 */
export function guard(
  _target: Target,
  _state: GuardState,
  _config: CompassConfig,
  _mode: Mode,
): GuardResult {
  throw new Error("not implemented: route/guard");
}
