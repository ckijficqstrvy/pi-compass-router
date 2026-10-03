import type { CompassConfig } from "../../schema.js";

/** `hooks.candidates()` 的候選種類（接線層決定來源，本模組只負責呈現）。 */
export type CandidateKind =
  /** 路由模型 `provider/model`：registry 可用模型 ∪ 事實檔 ∪ 現有鏈。 */
  | "model"
  /** laya checkpoint：本機快取掃描。 */
  | "checkpoint"
  /** cloud 分類模型：registry 的 typesafe 分類模型。 */
  | "classifier";

/** 供 TUI 選單與寫入落地的掛點（Part 10.2「hooks 形狀」節）。 */
export interface WizardHooks {
  /** 逐項寫入驗證與落地（Part 3.4 白名單）。回 `null` 成功，回 `key: reason` 拒絕。 */
  write(key: string, value: unknown): string | null;
  /**
   * 寫入後重載進執行中 session。**回傳重載後的設定**（可選）：接線層
   * reload 會換掉 session 的設定物件，不回傳選單就畫在舊物件上。
   */
  reload(): CompassConfig | void | Promise<CompassConfig | void>;
  /** TUI 取一列輸入。回 `null` = 使用者取消（Esc）。 */
  prompt(label: string, initial?: string): Promise<string | null>;
  /** TUI 從清單選一項。回 `null` = 取消。 */
  pick(label: string, options: string[]): Promise<string | null>;
  /**
   * 候選清單（可選）。回空或未實作 → 該項以內建預設為種子、仍用選單
   * （「能選就不打」）。
   */
  candidates?(kind: CandidateKind): string[] | Promise<string[]>;
  /** 給使用者的回饋（可選）：寫入被拒、輸入無效、診斷結果。 */
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  /** 測試分類器（可選）：跑一輪真分類，回一列結果；未實作 → 該項目不動作。 */
  probeClassifier?(): Promise<string> | string;
}

// ---------------------------------------------------------------------------
