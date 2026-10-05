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
import { TIERS } from "../schema.js";
import FACTS from "../model-facts.json" with { type: "json" };

/** 隨附的事實快照（schema 在使用時校驗，不在 import 時）。 */
export const MODEL_FACTS: FactsFile = FACTS as FactsFile;

export interface ModelFact {
  /** pi 的 catalogue 認得的可路由模型 id（別名亦可）。 */
  model: string;
  provider: string;
  /** 能力是**模型**的屬性（canonical，provider 無關）：同一模型在不同 provider/別名
   *  下共用一個身分與分數，才不會出現「只比較 openrouter 分數」。缺省時由
   *  `canonicalOf()` 推導（openrouter 的 slug 已是 `maker/model`）。 */
  canonical?: string;
  /** 能力快照（多維；見 ModelCapability）。 */
  capability: ModelCapability;
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
 * 模型能力是**多維**的（Artificial Analysis 分不同 index），且各維尺度不同、
 * 不可互換。未核對的維度一律省略，腳本與人工都不猜。
 */
export interface ModelCapability {
  /** AA Intelligence Index：headline 分數；band 內排序與 tier 門檻比較用它。 */
  intelligence: number;
  /** AA Coding Index（未核對則省略）。 */
  coding?: number;
  /** AA Agentic Index（未核對則省略）。 */
  agentic?: number;
}

/** 既有 band 排序與 tier 門檻在 S3 之前仍用 `intelligence` 當主分數。 */
export function primaryCapability(capability: ModelCapability): number {
  return capability.intelligence;
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
      (m.canonical === undefined || (typeof m.canonical === "string" && m.canonical.length > 0)) &&
      isModelCapability(m.capability) &&
      (m.price === undefined ||
        (!!m.price &&
          typeof m.price.input === "number" &&
          typeof m.price.output === "number" &&
          m.price.input >= 0 &&
          m.price.output >= 0)),
  );
}

/** 能力物件校驗：intelligence 必填且有限；coding/agentic 有則必須有限。 */
function isModelCapability(value: unknown): value is ModelCapability {
  if (typeof value !== "object" || value === null) return false;
  const cap = value as Record<string, unknown>;
  const finite = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n);
  return (
    finite(cap.intelligence) &&
    (cap.intelligence as number) >= 0 &&
    (cap.coding === undefined || finite(cap.coding)) &&
    (cap.agentic === undefined || finite(cap.agentic))
  );
}

/**
 * 取某個現役 registry 模型的能力／價格，鍵與 menu 相同（`provider/id`），
 * 並有 id-only 的退而求其次。`undefined` = 未評分——一個品質未知數，
 * modelPick 的閘門要據此處理（Part 5 Stage 3）。
 */
export function factFor(provider: string, id: string): ModelFact | undefined {
  if (provider) return MODEL_FACTS.models.find((f) => f.provider === provider && f.model === id);
  // provider 為空（裸 id）：只在**唯一**同 id 時回傳；多個 provider 同名 → 歧義，
  // 寧可回 undefined 也不套用別人的價格/能力（2026-10-03 W8）。
  const matches = MODEL_FACTS.models.filter((f) => f.model === id);
  return matches.length === 1 ? matches[0] : undefined;
}

/** 依主分數（intelligence）降序；同分保持檔案順序（穩定，重刷不會洗牌）。 */
export function rankedFacts(facts: FactsFile): ModelFact[] {
  return [...facts.models].sort(
    (a, b) => primaryCapability(b.capability) - primaryCapability(a.capability),
  );
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
      // A null (unbounded) ceiling may only own the remainder at the highest
      // tier. Letting a lower null tier swallow everything would collapse the
      // whole ladder (2026-10-04: `ceilings.quick = null` did exactly that).
      if (upper === null || upper === undefined) {
        if (t === TIERS.length - 1) bands[t].push(fact);
        continue;
      }
      if (price <= upper) {
        bands[t].push(fact);
        break;
      }
    }
  }
  return bands;
}