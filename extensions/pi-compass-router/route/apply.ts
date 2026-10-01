// route/apply.ts — Stage 5：套用切換與 transcript entry（SPEC Part 5）。
import type { Mode, Target, ThinkingLevel } from "../schema.js";
import type { GuardOutcome } from "./guard.js";

/** pi 提供的切換掛點（Part 5 Stage 5：setModel + setThinkingLevel + read back）。 */
export interface ApplyHooks {
  setModel(model: string): Promise<void> | void;
  setThinkingLevel(level: ThinkingLevel): Promise<void> | void;
  /** 套用後讀回實際層級（模型會 clamp）（Part 5 Stage 5）。 */
  readThinkingLevel?(): ThinkingLevel | undefined;
}

/** Stage 5 輸入：由 guard 與 mode 組成的決策。 */
export interface ApplyDecision {
  outcome: GuardOutcome;
  target: Target;
  thinking: ThinkingLevel;
  mode: Mode;
}

/**
 * Stage 5：
 * - auto：applied 切換、held 套用 thinking、skipped 不動；
 * - confirm：applied 詢問；
 * - notify：applied 不動僅通知，thinking 不套用（entry 標
 *   `not applied (notify mode)`）；held/skipped 所有模式皆套用 thinking。
 * - 寫 transcript entry（excludeFromContext: true），符號
 *   →/= /•/×/·（Part 5 Stage 5、Part 10.4）。
 */
export async function applyRoute(
  _decision: ApplyDecision,
  _hooks: ApplyHooks,
): Promise<void> {
  throw new Error("not implemented: route/apply");
}
