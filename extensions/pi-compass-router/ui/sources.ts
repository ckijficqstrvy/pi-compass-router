// ui/sources.ts — /compass-set 的候選來源（接線層的 I/O 都在這裡）。
//
// 選單本身是純資料（`ui/wizard.ts`），候選由 `hooks.candidates(kind)` 注入；
// 本模組負責兩種真的要做 I/O 的來源：**本機 HF 快取掃描**與 **OpenRouter
// 最新模型清單**（免金鑰公開端點）。單獨成檔是為了可測（目錄／fetch／快取
// 路徑都可注入）。**拿不到東西一律回 `[]`**——呼叫端會 union 其他來源，
// 不假裝有候選。
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** HF 快取目錄：`HUGGINGFACE_HUB_CACHE`（直指 hub）→ `HF_HOME/hub` → 預設。 */
function hubDir(): string {
  const direct = process.env.HUGGINGFACE_HUB_CACHE;
  if (direct) return direct;
  const home = process.env.HF_HOME;
  if (home) return join(home, "hub");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "huggingface", "hub");
}

/**
 * 掃描 Hugging Face 本機快取，回 `org/name` 形式的 checkpoint 候選。
 *
 * 目錄形狀是 `models--{org}--{name}`（HF 命名），**只切第一組 `--`**：
 * 模型名本身含 `--` 時不會被切壞。目錄不存在／讀不到 → 回 `[]`。
 */
export function localCheckpoints(options: { hubDir?: string } = {}): string[] {
  let entries: string[];
  try {
    entries = readdirSync(options.hubDir ?? hubDir());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("models--")) continue;
    const rest = entry.slice("models--".length);
    if (rest === "") continue;
    const cut = rest.indexOf("--");
    out.push(cut === -1 ? rest : `${rest.slice(0, cut)}/${rest.slice(cut + 2)}`);
  }
  return out.sort();
}

/**
 * registry 的分類模型 → cloud 候選鍵（`provider/model`）。
 *
 * **只留 `provider === "typesafe"`**：`cloud.ts` 的 endpoint 寫死 typesafe，
 * `provider !== "typesafe"` 會直接 throw（Part 4.3）；而 registry 的分類模型
 * 多數掛在別的 provider 底下（id 形如 `~typesafe/…`，掛在 openrouter）——
 * 實測 `getAvailableOfType("classifier")` 回的全是 openrouter/*，選了就會
 * 寫出一個讓分類當場失效的設定（2026-10-02 修）。
 */
export function cloudClassifierKeys(
  models: ReadonlyArray<{ provider: string; id: string }>,
): string[] {
  return models
    .filter((model) => model.provider === "typesafe")
    .map((model) => `${model.provider}/${model.id}`);
}

// ---------------------------------------------------------------------------
// OpenRouter 最新模型清單（免金鑰公開端點 + 24h 磁碟快取）
// ---------------------------------------------------------------------------

/** OpenRouter 模型清單端點（免金鑰；`data[].id` 即路由模型 id）。 */
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** 快取 TTL：一天（模型清單變化慢，每次都打 API 太浪費）。 */
const OPENROUTER_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** 快取檔預設路徑。 */
function defaultCachePath(): string {
  return join(homedir(), ".pi", "agent", "pi-compass", "openrouter-models.json");
}

export interface OpenRouterModelsOptions {
  /** 快取檔路徑（測試注入用）。 */
  cachePath?: string;
  /** 快取有效期（秒）。 */
  ttlSeconds?: number;
  /** fetch 實作（測試注入用）。 */
  fetchImpl?: typeof fetch;
  /** 時鐘（測試注入用）。 */
  now?: number;
}

interface OpenRouterCache {
  fetchedAtMs: number;
  keys: string[];
}

function readCache(cachePath: string): OpenRouterCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as OpenRouterCache;
    if (typeof parsed?.fetchedAtMs === "number" && Array.isArray(parsed?.keys)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function writeCache(cachePath: string, keys: string[], now: number): void {
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ fetchedAtMs: now, keys }));
  } catch {
    // 快取寫入失敗不阻擋（安全網）。
  }
}

/**
 * 抓 OpenRouter **最新**模型清單 → `openrouter/<id>` 鍵清單。
 *
 * - 端點：`GET https://openrouter.ai/api/v1/models`（公開、免金鑰）。
 * - **24h 磁碟快取 + stale-if-error**：過期先重抓；抓失敗回過期快取，
 *   連快取都沒有才回 `[]`（呼叫端會 union registry，不會因此變空）。
 * - 濾掉 `:batch` 之類的非即時端點（不能當對話模型）。
 */
export async function openRouterModelKeys(options: OpenRouterModelsOptions = {}): Promise<string[]> {
  const cachePath = options.cachePath ?? defaultCachePath();
  const ttlSeconds = options.ttlSeconds ?? OPENROUTER_CACHE_TTL_SECONDS;
  const now = options.now ?? Date.now();

  const cached = readCache(cachePath);
  if (cached && now - cached.fetchedAtMs < ttlSeconds * 1000) return cached.keys;

  try {
    const doFetch = options.fetchImpl ?? fetch;
    const response = await doFetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const data = (payload as { data?: unknown[] })?.data;
    const keys = Array.isArray(data)
      ? data
          .map((entry) => ((entry as { id?: unknown })?.id))
          .filter((id): id is string => typeof id === "string" && id !== "" && !id.includes(":batch"))
          .map((id) => `openrouter/${id}`)
      : [];
    writeCache(cachePath, keys, now);
    return keys;
  } catch {
    return cached?.keys ?? [];
  }
}