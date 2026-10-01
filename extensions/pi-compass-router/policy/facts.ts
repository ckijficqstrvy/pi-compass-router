/**
 * L1 — model facts：帶日期的模型事實（能力排序 + 價格快照）。
 * 這是四層設計裡的**事實層**（Part 9）：
 *
 *   L3 显式 routes/kindModels/prefer（config.json，永不過滤）
 *   L2 政策 profile / ceilings / deny / allowProviders（config + env）
 *   L1 事實 本檔 —— 誰強、誰便宜、何時查的
 *   L0 機制 demand 組合、守衛、回退（程式碼）
 *
 * 能力分數是人工核對的快照（Artificial Analysis intelligence index，
 * 對照 Terminal-Bench 與社群排行榜），**腳本永不自動猜分數**；
 * 價格由 `npm run refresh-facts` 從 pi 的 model catalogue 同步。
 * 兩者都會過期。事實檔損壞或缺價**從不讓路由中斷**：schema 校驗失敗即
 * 判定不可用，呼叫端退回內建鏈（fail-open，與此處其他規則一致）。
 *
 * 檔案與實作均為本專案原創（Part 0.3 白名單）。
 */
import type { Tier } from "../schema.js";
import { TIERS } from "../schema.js";
import FACTS from "../model-facts.json" with { type: "json" };

/** 隨附的事實快照（schema 在使用時校驗，不在 import 時）。 */
export const MODEL_FACTS: FactsFile = FACTS as FactsFile;

export interface ModelFact {
  /** pi 的 catalogue 認得的可路由模型 id（別名亦可）。 */
  model: string;
  provider: string;
  /** 能力快照（分數越高越強），人工核對。 */
  capability: number;
  /** 快照時點的目錄牌價，USD / 百萬 token。可選：缺價的模型不會被切帶。 */
  price?: { input: number; output: number };
  /** 能力分數是估計值，不是實測條目。 */
  estimated?: boolean;
  note?: string;
}

export interface FactsFile {
  generatedAt: string;
  source: string;
  models: ModelFact[];
}

/**
 * 每個天花板都用的指標：`input + 2×output`（agent 流量寫得多）。
 * 與 Part 9 的 ceiling 指標一致。
 */
export function blendedOf(price: { input: number; output: number }): number {
  return price.input + 2 * price.output;
}

/**
 * schema 校驗——壞掉的事實檔必須退回到內建鏈，絕不 throw。
 * 空 `models` 也算不可用：沒有模型就沒有可推導的鏈。
 */
export function factsValid(value: unknown): value is FactsFile {
  const file = value as FactsFile | undefined;
  if (!file || typeof file.generatedAt !== "string" || !Array.isArray(file.models)) return false;
  if (file.models.length === 0) return false;
  return file.models.every(
    (m) =>
      !!m &&
      typeof m.model === "string" &&
      m.model.length > 0 &&
      typeof m.provider === "string" &&
      typeof m.capability === "number" &&
      Number.isFinite(m.capability) &&
      (m.price === undefined ||
        (!!m.price &&
          typeof m.price.input === "number" &&
          typeof m.price.output === "number" &&
          m.price.input >= 0 &&
          m.price.output >= 0)),
  );
}

/**
 * 取某個現役 registry 模型的能力／價格，鍵與 menu 相同（`provider/id`），
 * 並有 id-only 的退而求其次。`undefined` = 未評分——一個品質未知數，
 * modelPick 的閘門要據此處理（Part 5 Stage 3）。
 */
export function factFor(provider: string, id: string): ModelFact | undefined {
  return (
    MODEL_FACTS.models.find((f) => f.provider === provider && f.model === id) ??
    MODEL_FACTS.models.find((f) => f.model === id) ??
    undefined
  );
}

/** 依能力降序；同分保持檔案順序（穩定，重刷不會洗牌）。 */
export function rankedFacts(facts: FactsFile): ModelFact[] {
  return [...facts.models].sort((a, b) => b.capability - a.capability);
}

/**
 * 把排序後的事實切成互斥的價格帶，一層一條。
 *
 * 沒有價格的事實**無法切帶**，會從推導鏈中排除（refresh 腳本會報告）——
 * 只靠能力永遠不該把模型放進某層。
 *
 * 帶是依層序的連續上界（quick → premium）：模型落在第一個上界覆蓋其
 * blended 價格的層；`null` = 無上界。**價格帶**（而非能力下限）才是讓
 * 各層互斥的機制——否則最強的便宜模型會吃掉每一層。
 * 帶內再由能力排序決定誰領銜（Part 9）。
 */
export function sliceBands(
  ranked: readonly ModelFact[],
  ceilings: readonly (number | null)[],
): ModelFact[][] {
  const bands: ModelFact[][] = TIERS.map(() => []);
  for (const fact of ranked) {
    if (!fact.price) continue;
    const price = blendedOf(fact.price);
    for (let t = 0; t < TIERS.length; t += 1) {
      const upper = ceilings[t];
      if (upper === null || upper === undefined || price <= upper) {
        bands[t].push(fact);
        break;
      }
    }
  }
  return bands;
}