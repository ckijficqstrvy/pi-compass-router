# pi-compass — 行為規格 v1（Clean-room 規格檔）

狀態：**UNBLOCKED — Part 13 七項決策已於 2026-10-01 全數回填**
進入實作的前置：完成條件段列出的四項檢查全部通過。
規格者：主代理
日期：2026-10-01（決策回填日：2026-10-01）

本檔是 pi-compass 的**唯一規格來源**。程式碼實作只能依賴本檔與
「Clean-room 證價清單」所列檔案，不得參照任何被排除的來源。

---

## Part 0 — Clean-room 協議

### 0.1 目標

產出一個在**程式碼表達層面**獨立於
`github.com/da-vinci-noob/pi-jev-model-router` 的新產品，可自行發佈、
不需攜帶上游的 MIT 版權聲明（新程式碼不含上游的受保護表達）。

想法、演算法、行為規格、功能需求、API 概念**不受著作權保護**，可以自由沿用；
受保護的是「表達」——程式碼的具體排列、文件文案的具體措辭、圖像資產。

### 0.2 禁止來源（不得閱讀、不得摘錄、不得對照）

以下檔案屬於 `da-vinci-noob/pi-jev-model-router` 的受保護表達，
或其 53%–100% 由上游構成，實作期間一律不得開啟：

```
extensions/pi-jev-model-router/budget.ts        100% 上游未動
extensions/pi-jev-model-router/index.ts          81% 上游未動
extensions/pi-jev-model-router/jev.ts            75% 上游未動
extensions/pi-jev-model-router/router.ts         72% 上游未動
extensions/pi-jev-model-router/README.md         74% 上游未動
README.md                                       70% 上游未動
extensions/pi-jev-model-router/config.ts         53% 上游未動（見 0.4）
extensions/pi-jev-model-router/pi-jev-model-router.example.json  54%
LICENSE                                          上游授權文本（見 0.5）
assets/decision-entry.png                        上游圖像資產
upstream 之任何 git revision / branch / tag
```

### 0.3 允許來源（Clean-room 等價清單）

下列檔案在分叉點 `5ca26ca` **不存在**，由使用者從零撰寫，是乾淨的表達：

```
extensions/pi-jev-model-router/settings-ui.ts     490 行（全新）
extensions/pi-jev-model-router/laya.ts            254 行（全新）
extensions/pi-jev-model-router/laya-server.py      86 行（全新）
extensions/pi-jev-model-router/facts.ts           122 行（全新）
extensions/pi-jev-model-router/model-facts.json   162 行（全新）
scripts/refresh-facts.mjs                        136 行（全新）
test/config.test.ts                              362 行（全新）
test/config-write.test.ts                        200 行（全新）
test/thinking.test.ts                            388 行（全新）
test/model-pick.test.ts                          288 行（全新）
test/laya.test.ts                                224 行（全新）
test/settings-ui.test.ts                          86 行（全新）
test/latency.ts                                   97 行（全新）
tsconfig.json                                     14 行（全新）
```

另可使用：

- **分叉點以來使用者新增的程式行**（`git diff 5ca26ca..HEAD` 中的 added
  lines，共約 6,700 行）——這是使用者本人的表達。
- **行為事實**：設定鍵名、預設值、命令列介面、輸出格式、數值常數。
  這些是功能規格，不構成表達。
- **上游的 commit 標題與 PR 標題**（公開資訊，僅含功能概念）：

  ```
  feat: propose routes from a local scores file with /jev-router suggest (#12)
  feat: configure task kinds from JSON (#11)
  feat: add an opt-in, gated xpremium tier above premium (#10)
  feat: rank kind specialists with an optional priority (#8)
  feat: add a free-model pool consulted outside the tier scale (#3)
  feat: allow different jev providers (#1, e.g. openrouter, vercel AI, etc.)
  ```

  這六個概念要移植；**其具體實作一律由本規格重新設計**，
  不得回頭閱讀對應實作。

### 0.4 已知污染與自我揭露

分析階段（使用者要求「看一下 repo」時）主代理已 `read` 過
`config.ts` 全文。該檔案 53% 為上游未動內容，故主代理對上游的
設定載入、驗證、env 覆寫、PATCH_CHECKS 結構已有接觸。

**補償措施：**

1. 本規格的 config schema **不以 config.ts 為來源**，改以使用者的
   測試檔（`test/config*.test.ts`，100% 使用者所寫）抽取鍵名與預設值。
2. 實作時的模組切分與命名**由本規格 Part 11 先行決定**，
   不依記憶回溯上游檔案的組織方式。
3. 新專案不複製上游的檔案路徑（不使用 `pi-jev-model-router` 目錄名）。
4. 上述接觸事實記載於 NOTICE 檔的「開發過程」段，供日後審計。

### 0.5 授權與 NOTICE

授權為 **MIT**（Part 13 #2 已定）；`LICENSE` 於完成條件第 1 項建立。
NOTICE 檔必須記載：

- 新程式碼為獨立開發；
- `model-facts.json`、`facts.ts`、`settings-ui.ts`、`laya*` 等
  使用者原創檔案的出處聲明；
- 對上游專案的功能概念致謝（非程式碼複製）；
- 0.4 的開發過程揭露。

舊 repo `pi-jev-router` 的處置是**保持公開**（Part 13 #4 已定）。
無論轉 private 與否，它都繼續攜帶上游 MIT notice——這是法定要求，
刪除或改寫都會構成授權違反；本新專案與它分開授權。

---

## Part 1 — 產品識別

| 項目 | 值 |
| --- | --- |
| 專案 / repo 名 | `pi-compass`（GitHub `ckijficqstrvy/pi-compass`，已驗證可建） |
| npm 套件名 | `pi-compass-router`（**已驗證 registry HTTP 404 = 可用**） |
| 理由 | npm 上的 `pi-compass` 已被 Matt Devy 的同名 Pi 擴充佔用（0.2.2，2026-08-11），同生態系撞名不可採 |
| 安裝指令 | `pi install npm:pi-compass-router` |
| 副目錄 | `extensions/pi-compass-router/` |
| 命令前綴 | `/compass`（**短前綴；套件名與命令名不需一致**——precedent：舊套件 `pi-jev-model-router` 配 `/jev-router`） |
| 狀態列前綴 | `compass:` |
| 設定命令 | `/compass-set` |
| 工具 | `compass_route`、`compass_config` |
| config 目錄 | `~/.pi/agent/pi-compass/` |
| 設定檔 | `~/.pi/agent/pi-compass/config.json` |
| 狀態檔 | `~/.pi/agent/pi-compass/state.json` |
| 事實檔 | 隨附 `model-facts.json`（可被使用者覆寫） |
| 環境變數前綴 | `COMPASS_` |
| 授權 | **MIT**（Part 13 #2 已定） |
| npm 發佈 | **公開非 scoped**（Part 13 #3 已定） |
| Node 下限 | **≥ 22.19.0**（pi 自身 `engines.node` 要求，已從安裝的 `@earendil-works/pi-coding-agent@0.99.1` package.json 實測；不要寫 20） |
| pi 官方連結 | `https://github.com/earendil-works/pi`（`pi-mono.com` 實測 DNS 不通 http=000，**不可用**） |

完整命令集：`/compass`、`/compass-set`、`/compass-route`、
`/compass-mode`、`/compass-budget`、`/compass-why`、
`/compass-revert`、`/compass-suggest`、`/compass on|off`。

**發佈前置（未完成不 publish）**：本機 `npm whoami` 回 `ENEEDAUTH`，
必須先 `npm adduser` 或配 `NPM_TOKEN`；隨後 `npm pack --dry-run`
驗封包內容，再 `npm publish --access public`。

---

## Part 2 — 產品定義

pi-compass 是一個 pi 擴充，在每一輪對話**開始之前**判斷該用哪個模型
與哪個思考層級，並切換模型。

核心原則（概念層，非抄襲）：

- **判斷與政策分離**：分類器只回答「這是什麼任務、需要多強」，
  預算、價格、可用性由程式碼決定。
- **local-first**：分類預設在本機完成，不需 API key，不打網路。
- **fail-open**：分類失敗、超時、模型不可用 → 警告並用當前模型執行，
  絕不阻擋使用者的回合。
- **可見**：每一次判斷都寫入 transcript entry，含選了誰、為什麼。
- **顯式勝過政策**：使用者在 config.json 寫的模型永遠不會被
  deny/價格帶/免費池過濾掉。

---

## Part 3 — 設定 schema

### 3.1 完整鍵表

來源：使用者的 `test/config*.test.ts`（乾淨來源）。

| 鍵 | 型別 | 預設 | 說明 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 主開關 |
| `mode` | `auto｜confirm｜notify` | `notify` | 切換模式 |
| `useDefaultModels` | boolean | `true` | `false` → 只用使用者自帶模型 |
| `classify.provider` | `laya｜cloud` | **`laya`** | 分類後端（local-first） |
| `classify.model` | string | `"aac6fef/laya-multilingual-mlx"` | laya checkpoint id 或路徑 |
| `classify.python` | string | `~/.pi/agent/pi-compass/venv/bin/python` | 帶 laya-mlx 的 Python ≥3.11 |
| `classify.cloud.provider` | string | `"typesafe"` | cloud 後端（備用） |
| `classify.cloud.model` | string | `"jev-latest"` | cloud 模型代號 |
| `classify.timeoutMs` | number | `800` | 分類整體預算（見 Part 6，自 3500 下調） |
| `classify.minPromptChars` | integer | `12` | 低於此視為延續訊息，不分類 |
| `classify.historyTurns` | integer | `0` | 送入分類器的對話輪數 |
| `classify.cache` | boolean | `true` | 分類結果快取（Part 6） |
| `classify.cacheTtlSeconds` | integer | `300` | 快取有效期 |
| `classify.confidenceThreshold` | 0–1 | `0.34` | 低於此 → 回落 standard |
| `routes` | `Record<Tier, Target[]>` | 內建 | 各層級候選鏈 |
| `kindModels` | `Record<kind, Target[]>` | 內建 | 任務專家鏈 |
| `kindMinimumTier` | `Record<kind, Tier>` | 內建 | 每任務種類的最低層級 |
| `taskKinds` | `Record<kind, {label, floor, priority}>` | 內建 | **可由 JSON 覆寫**（移植 #11） |
| `xpremium.enabled` | boolean | `false` | **移植 #10，opt-in** |
| `freePool.enabled` | boolean | `false` | **移植 #3，預設關** |
| `freePool.models` | `Target[]` | `[]` | 池外免費模型 |
| `specialistPriority` | `Record<kind, string[]>` | `{}` | **移植 #8，專家排序** |
| `suggest.scoresFile` | string | `""` | **移植 #12，本地分數檔路徑** |
| `budget.dailyUsd` | number｜`null` | `5` | 日上限；`null` 移除 |
| `budget.monthlyUsd` | number｜`null` | `100` | 月上限 |
| `budget.softRatio` | 0–1 | `0.7` | 超此 → 降一層 |
| `budget.hardRatio` | 0–1 | `0.9` | 超此 → 強制 quick（demand ≥2.5 例外） |
| `profile` | `cheap｜balanced｜quality` | `balanced` | 價格帶檔位 |
| `ceilings` | `Partial<Record<Tier, number｜null>>` | `{}` | 每層價格上限覆寫（$/M，`input+2×output`） |
| `deny` | `string[]` | `[]` | glob，從**衍生**鏈移除 |
| `allowProviders` | `string[]` | `[]` | 非空 → 衍生鏈只留這些 provider |
| `prefer` | `Partial<Record<Tier, string[]>>` | `{}` | 插入鏈首，**絕不被過濾** |
| `autoRoutes` | boolean | `true` | 用 model-facts 推導未寫的層級 |
| `modelPick` | `off｜menu` | `off` | `menu` → 分類器多答一題選具體模型 |
| `allowUnratedPicks` | boolean | `false` | 允許未評分模型中選 |
| `freeOnly` | boolean | `false` | 特殊情境：只用 $0 模型 |
| `stickiness` | boolean | `true` | 當前已是目標 → 不切換 |
| `cache.aware` | boolean | `true` | 切換前估算 cache miss 成本 |
| `cache.deadband` | number ≥0 | `0.25` | 需超出當前層 ±deadband 才換層 |
| `cache.maxPenaltyUsd` | number ≥0 | `0.05` | 估算成本超此 → 擋下切換 |
| `cache.bypassTierDelta` | integer ≥0 | `2` | 層級跳躍 ≥ 此 → 無條件切 |
| `cache.cooldownSeconds` | integer ≥0 | `0` | 切換後冷卻秒數，0=關 |
| `thinking.pin` | `off…max` | 無 | 全域 pin |
| `thinking.<kind>` | `off…max` | 無 | 按任務種類 pin |

`Target` = `{ provider, model, minTier?, thinkingLevel?, priority? }`

`Tier` = `quick｜standard｜high｜premium`，`xpremium.enabled` 時追加 `xpremium`。

`thinkingLevel` 可能值：`off｜minimal｜low｜medium｜high｜xhigh｜max`

### 3.1a 內建任務種類（`taskKinds` 預設內容）

> 2026-10-01 補：原先只寫「內建」，骨架階段被正確標為規格缺口。
> 種類中繼資料與模型鏈無關，不受 Part 13 #7 阻塞，故在此定案。

`floor` 是 **demand 下限**（0–3 刻度），語意是「這類任務永遠不會被
當成瑣事」；它與 `kindMinimumTier` 的**層級下限**是兩回事（Part 5 Stage 2
先取 demand floor 再取層級 floor）。demand floor 影響思考階梯與
hardRatio 的 `demand ≥ 2.5` 例外；層級 floor 直接決定候選鏈起點。

| kind | label（供 UI/選單） | floor | 層級下限（`kindMinimumTier`） |
| --- | --- | --- | --- |
| `plan` | Planning & design | **1.5** | high |
| `review` | Review & audit | **1.5** | high |
| `implement` | Implementation | **1.0** | standard |
| `debug` | Debugging | **1.0** | standard |
| `refactor` | Refactoring | **1.0** | standard |
| `research` | Research | **1.0** | standard |
| `operate` | Operation & tooling | **0.5** | standard |
| `write` | Writing | **0.5** | quick |
| `explain` | Explanation | **0.5** | quick |
| `chat` | Conversation | **0.0** | quick |

設計理由：`plan`／`review` 需長程推理故 floor 最高；`chat` 不設 floor。
分類器的 `criteria` 用 **kind key**（非 label）作答——key 穩定、短、
易驗證，label 只用於顯示。

`taskKinds` 可由 JSON 完全覆寫（新增自己的 domain），覆寫後
`kindMinimumTier` 與 `kindModels` 需自行搭配（Part 11 移植 #11）。

### 3.2 解析順序

後者勝：

1. 內建預設
2. `~/.pi/agent/pi-compass/config.json`
3. `COMPASS_*` 環境變數

**無專案級設定檔**（repo 不得注入路由設定）。

### 3.3 環境變數對應

`JEV_*` → `COMPASS_*`：

| 環境變數 | 覆寫 |
| --- | --- |
| `COMPASS_ENABLED` | `enabled` |
| `COMPASS_MODE` | `mode` |
| `COMPASS_USE_DEFAULT_MODELS` | `useDefaultModels` |
| `COMPASS_PROVIDER` | `classify.provider` |
| `COMPASS_TIMEOUT_MS` | `classify.timeoutMs` |
| `COMPASS_MIN_PROMPT_CHARS` | `classify.minPromptChars` |
| `COMPASS_HISTORY_TURNS` | `classify.historyTurns` |
| `COMPASS_CACHE` | `classify.cache` |
| `COMPASS_CACHE_TTL` | `classify.cacheTtlSeconds` |
| `COMPASS_CONFIDENCE_THRESHOLD` | `classify.confidenceThreshold` |
| `COMPASS_STICKINESS` | `stickiness` |
| `COMPASS_BUDGET_DAILY_USD` | `budget.dailyUsd`（`none` 清除） |
| `COMPASS_BUDGET_MONTHLY_USD` | `budget.monthlyUsd` |
| `COMPASS_BUDGET_SOFT_RATIO` | `budget.softRatio` |
| `COMPASS_BUDGET_HARD_RATIO` | `budget.hardRatio` |
| `COMPASS_PROFILE` | `profile` |
| `COMPASS_AUTO_ROUTES` | `autoRoutes` |
| `COMPASS_MODEL_PICK` | `modelPick` |
| `COMPASS_ALLOW_UNRATED_PICKS` | `allowUnratedPicks` |
| `COMPASS_FREE_ONLY` | `freeOnly` |
| `COMPASS_FREE_POOL` | `freePool.enabled` |
| `COMPASS_XPREMIUM` | `xpremium.enabled` |
| `COMPASS_CACHE_AWARE` | `cache.aware` |
| `COMPASS_CACHE_DEADBAND` | `cache.deadband` |
| `COMPASS_CACHE_MAX_PENALTY_USD` | `cache.maxPenaltyUsd` |
| `COMPASS_CACHE_BYPASS_TIER_DELTA` | `cache.bypassTierDelta` |
| `COMPASS_CACHE_COOLDOWN_SECONDS` | `cache.cooldownSeconds` |
| `COMPASS_KIND_MIN_TIER` | `kindMinimumTier`（`kind=tier` 逗號分隔） |

驗證規則與舊版一致：非法值**丟棄該變數並警告**，前一層的值立住；
警示只在值為 ≤40 字元可列印 ASCII 時才回顯（防洩密）。
布林值接受 `1/0 true/false yes/no on/off`；比率須 0–1 且
`softRatio ≤ hardRatio`。

### 3.4 寫入驗證（`compass_config` 工具）

三條規則不變：

1. **白名單** — 只有 3.1 表列的鍵可寫，其餘**以鍵名拒絕**（非靜默丟棄）。
2. **寫前驗證** — 型別/範圍不合法就不落檔，回 `key: reason`。
3. **Patch 非覆寫** — 只改被指定的鍵，預設值與衍生鏈**永不寫回使用者檔案**。
   `budget.dailyUsd: null` 清除上限。

---

## Part 4 — 分類後端

### 4.1 介面

```
interface Classifier {
  readonly id: "laya" | "cloud";
  classify(input: ClassifyInput, signal: AbortSignal): Promise<Judgment>;
  warm?(): void;        // 啟動預熱
  dispose?(): void;
}

ClassifyInput { request: string; conversation?: string; kinds: TaskKind[] }
Judgment     { kind, kindConfidence, complexity, capability,
                deepReasoning, thinking, modelPick?, latencyMs, source }
```

`kind` 必須屬於呼叫端傳入的 `kinds` 集合 — 分類器不能自訂種類
（種類由 `taskKinds` 設定決定，移植 #11）。

`complexity` 與 `capability` 規範在 **0–3 刻度**（Stage 2 的 demand 與
階梯閾值 0.5/1.5/2.5/2.9 都建立在此範圍上）；laya 回的是 rubric 層級
期望值，故以 `score / (k-1) * 3` 正規化，結果**收斂到 4 位小數**
（與來源資料精度一致，避免 1.55 → 1.5500000000000003 的浮點噪聲）。

### 4.2 laya 後端（預設）

- 啟動 `laya-server.py`（`classify.python`），JSONL over stdio，
  **不開網路監聽**。
- 規約：`{ id, kind, ... }` 請求 → `{ id, analysis }` 回應；
  行與行之間用 `\n` 分隔，一行一個 JSON 物件。
- session 啟動即**預熱**（模型載入不佔用第一次分類的延遲）。
- 子行程以 unref 掛著，不阻擋程序退出。
- 崩潰 → 下次呼叫重啟，**失敗連續 3 次**才在狀態列標記不可用，
  期間 fail-open。
- **不計費**：laya 分類的 token 不進預算帳本（本機推論無雲端成本）。

### 4.3 cloud 後端（可選，opt-in）

- 要 `TYPESAFE_API_KEY`；金鑰來源順序：環境變數 →
  `~/.pi/agent/pi-typesafe/auth.json`（必須 `0600`，否則拒絕讀取）。
- **Endpoint 寫死**，無 `endpoint` 設定鍵（防止設定檔轉向 Bearer key）。
- 分類耗用計入預算帳本。
- 移植 #1（alternate providers）：cloud 後端的 provider 可替換
  （typesafe 之外可接 openrouter、vercel AI 等），
  **由 `classify.cloud.provider` 決定**，介面不變。

#### ⚠️ 線格式未驗證（阻塞 `cloud.ts` 實作）

`parseAnalysis()` 的解析已依 **laya-mlx 官方源碼**驗證（見 `classify/analysis.ts`
檔頭），但 **cloud 後端的回應 schema 從未驗證**——舊版實作位於禁讀的
`jev.ts`，不得參照。`analysis.ts` 目前只接受兩種形狀（`{answers: {...}}`
與裸 answers map），若 typesafe 回的是第三種，cloud 路徑會全數
fail-open（不崩，但也不路由）。

**解除步驟（實作 `cloud.ts` 之前執行，缺一不可）**：

1. 讀 typesafe.ai 的公開 API 文件，取得 `/v1/systemone` 的回應 schema；
2. 文件不足時，以測試金鑰實際呼叫一次，**捕獲完整回應並存檔**
   （`docs/cloud-response.sample.json`，敏感欄位先遮罩）；
3. 把驗證過的 schema 寫進本節下方的「已驗證線格式」小節；
4. 若回應既非 `{answers}` 也非裸 map，在 `analysis.ts` 增加第三種形狀的
   解析——**從捕獲的樣本寫起，不從記憶或猜測**；
5. 未完成以上任一步前，不實作 `cloud.ts`，`provider: "cloud"` 保持
   不可用並在狀態列明說。

**已驗證線格式**：（待第 3 步回填）

### 4.4 安全

- 分類器收到的 payload **僅** `request` 與 `conversation`；
  conversation 預設不送（`historyTurns: 0`），啟用時上限 4000 字元。
- **不送** cwd、環境變數、花費數字。
- 無 `endpoint`／`stateFile` 設定鍵。
- 輸出永不回顯金鑰值。

---

## Part 5 — 路由管線

取代單一巨函式決策。五個階段，各自可測，介面為純資料：

```
Stage 1  classify    prompt + config  →  Judgment
Stage 2  compose     Judgment + floors →  demand, tier, thinking
Stage 3  select      tier + judgment   →  Target[]（專家鏈 → 層級鏈 → 池）
Stage 4  guard       Target + state    →  applied | held | notify-only | skipped
Stage 5  apply       applied           →  pi.setModel / setThinkingLevel + entry
```

### Stage 1 — classify

- 依 `classify.provider` 選後端。
- 快取查 → 命中即回（Part 6）。
- `request.length < minPromptChars` 且非首則訊息 → 回 `continuation`，
  直接跳到 Stage 4 的 `skipped`。
- 超時 → `Judgment` 缺失，Stage 2 用 tier 預設，Stage 5 記 `warn`。

### Stage 2 — compose

```
demand  = 0.55·complexity + 0.45·capability + 0.15·deepReasoning
demand  = clamp(demand, 0, 3)
demand  = max(demand, taskKinds[kind].floor)
demand  = max(demand, TIER_DEMAND_FLOOR[kindMinimumTier[kind]])
tier    = DEMAND_TIER(demand) max kindMinimumTier[kind]
thinking = pin > judgment.thinking > demand ladder > tier 預設
```

> 2026-10-01 補齊三處原先未定義的量（寫 `route/compose.ts` 前補）：
>
> 1. **reasoning 微調公式** `+ 0.15·deepReasoning`——最多只加 0.15，
>    不足以单独把任务跨层级，只在边界上把高等级推向深思考；
>    `deepReasoning` 缺失时该项不加。随后 clamp 到 [0,3]，
>    让 demand 永远落在阶梯刻度内。
> 2. **`TIER_DEMAND_FLOOR`**——層級對應的數值需求下限：
>    `quick 0.5 / standard 1.5 / high 2.5 / premium 2.9 / xpremium 3.0`。
>    取值與階梯閾值同源，故「plan ≥ high」意指 demand 至少 2.5
>    （至少 medium 思考），而不是任意数字。
> 3. **tier 由 demand 切出，不是由 ceilings**。原句「由 demand 與
>    ceilings 切出」有誤——`ceilings` 是 Part 9 的**價格帶**，決定某層
>    裡放哪些模型（Stage 3），不決定需求落在哪一层。
>
> 另補：`xpremium.enabled === false` 時 tier 封頂在 `premium`。

demand ladder（實作常數，定義在 `route/compose.ts`；修改任一閾值
必須回填本檔並註記日期）：
`<0.5 → off`、`<1.5 → low`、`<2.5 → medium`、`<2.9 → high`、
`≥2.9 → xhigh`。demand 頂到上限 = architectural + deep reasoning。

tier 預設 `TIER_THINKING`：`quick: off / standard: low / high: medium /
premium: high / xpremium: max`。

**信心守衛（在階梯之後，且優先於層級 floor）**：
`kindConfidence < confidenceThreshold` 時，**無論 `kindMinimumTier` 給什麼**，
tier 一律落回 `standard`。理由：信心低代表「連這是不是 plan 都不確定」，
此時依賴種類下限去花 high 的錢，是把不確定性放大。這覆蓋了
「planning 不下 cheap」的常規——兩者衝突時**信心優先**。

`judgment === undefined`（分類逾時／失敗）時：demand 記 0、
tier 直接 `standard`、thinking 取 `TIER_THINKING[standard]`，
**不套用任何種類 floor**（kind 未知）。

### Stage 3 — select

順序（**先專家後層級**）：

1. `specialistPriority[kind]` 排序的 `kindModels[kind]`，
   過濾 `minTier > tier` 者（移植 #8：priority 決定順序，
   而非只看 minTier 接近度）
2. `routes[tier]` 候選鏈
3. `freePool.models`（`freePool.enabled` 且當前層無可用模型時，移植 #3）
4. `freeOnly` 情境下的全域免費池（最強免費模型）

`modelPick: "menu"` 時，分類器的 `modelPick` 選項**先於上述所有**，
但必須同時通過：存在於 registry、通過 `deny`/`allowProviders`、
**已評分**（或 `allowUnratedPicks`）、capability ≥ 該層下限
（quick 20 / standard 35 / high 38 / premium 44 / xpremium 46）、
價格在該層價格帶內。任一失敗 → 記 `notes` 並退回鏈。

**tier 選項內的可用性回退**：整條鏈都不可用 → 用最近的可用層級。

### Stage 4 — guard

依序：

1. **可用性** — 模型存在且已認證，否則下一個候選。
2. **stickiness** — 當前模型即目標 → `held`。
3. **budget** — `pressure = max(today/daily, month/monthly)`
   - `≥ softRatio` → 降一層（重新跑 Stage 3）
   - `≥ hardRatio` → 強制 `quick`，**除非 `demand ≥ 2.5`** 可留 `standard`
4. **cache** — Part 7
5. **cooldown** — 切換後 `cooldownSeconds` 內，只有
   層級跳躍 ≥ `bypassTierDelta` 或 hardRatio 降級可再切

mode 決定 Stage 5 動作：

| mode | applied | held | skipped |
| --- | --- | --- | --- |
| `auto` | 切換 | 套用 thinking | 不動 |
| `confirm` | 詢問 | 套用 thinking | 不動 |
| `notify` | **不動**，僅通知 | 套用 thinking | 不動 |

`notify` 模式下 thinking **不套用**，entry 標
`not applied (notify mode)`。
`held`／`skipped` 在**所有模式**下都套用 thinking（修正陳舊思考）。

#### 實作契約（2026-10-01 補，寫 guard 前定）

規格原本沒寫三個必要輸入，導致「可用性」「demand ≥ 2.5 例外」「deadband
數值」都無從實作：

1. **可用性不在 `guard()` 裡**——`guard` 沒有 model registry 的存取權。
   可用性改由**呼叫端在候選鏈上做**：Stage 3 產出有序鏈，Stage 5/`apply`
   逐個試到第一個「存在且已認證」的模型。`guard()` 只處理 2–5 項。
   行為不變，只是職責邊界寫明。
2. **輸入型別**：`guard(request, state, config, mode)`，
   `request = { target, tier, demand }`——`demand` 是 hardRatio
   「`≥2.5` 可留 standard」例外必需；`state` 多了可選的
   `cachePenaltyUsd`（由有價格與 context 的呼叫端算好傳入，
   因為 `guard` 也不拿不到 token 數與費率）。
3. **deadband 的數值定義**（原句只有「需超出當前層 ±deadband」）：
   - **上切** `currentTier → target`：需 `demand >= TIER_DEMAND_FLOOR[target] + deadband`
   - **下切**：需 `demand <= TIER_DEMAND_FLOOR[當前層] - deadband`
   - **`state.currentTier` 為 null（本 session 首次切換）→ 不套 deadband**——
     deadband 是抑制反覆橫跳的，首次没有横跳可抑制；
     否則 plan 的 2.5 會被 0.25 死區擋在 standard，種類下限形同虛設。
   - **預算強制的升降級豁免 deadband**（2026-10-01 補）：錢的約束優先於
     「需求不確定性」，與它已有的 cooldown 豁免一致；否則 soft/hard
     降級會先被死區擋住，預算政策形同虛設。

### Stage 5 — apply

- `pi.setModel(...)` + `pi.setThinkingLevel(...)`，之後 **read back**
  實際層級並記錄（模型會 clamp）。
- 寫 transcript entry：`→` switched、`=` held、`•` notify、
  `×` skipped、`·` not routed。
- entry **不進入 LLM context**（`excludeFromContext: true`）。

---

## Part 6 — 分類延遲（優化重點）

### 6.1 延遲預算

| 場景 | 目標 p95 |
| --- | --- |
| laya 命中快取 | **< 5ms** |
| laya 未命中（熱） | **< 80ms** |
| laya 首次（模型載入） | 不計入（session 啯動預熱） |
| cloud（opt-in） | < 800ms，超時 fail-open |
| 延續訊息（不分類） | **0ms** |

`classify.timeoutMs` 預設自 3500 → **800**：
local-first 之後，cloud 超過 800ms 就沒有理由繼續等——
Fail-open 比讓使用者等 3.5 秒好。

**laya-mlx 官方效能數據（判斷 80ms 門樓是否有餘裕用）**：
來源 `github.com/mizorewww/laya-mlx` README，M3 Max、FP16、排除模型載入：

| 指標 | Laya 421M | Multilingual 322M |
| --- | --- | --- |
| 一題短問題 P50 | 13.42 ms | **7.39 ms** |
| 一題短問題 P95 | 13.92 ms | **7.79 ms** |
| 50 題吞吐 | 146.8 q/s | 395.0 q/s |

我們的五題是**同一批次內的獨立列**（laya-mlx 原文：question rows are
batched independently，batch_size 預設 16），故五題成本接近一題而非五倍。
驗收仍用 **p95 < 80ms 端到端**（含 JSONL 往返與橋行程式開銷）——
這是我们**自己的實測驗收值**，不是引用上游數字；實測後若餘裕充足，
再把門檻下收並在此節記入實測值。

### 6.2 分類快取（**新功能，舊版沒有**）

- **鍵**：`hash(normalize(request) + sort(config 生成金鑰))`
  - `normalize`：去空白折疊、大小寫不變、截斷至 512 字元
  - config 金鑰涵蓋 `taskKinds` 與 `modelPick` 設定，改動即失效
- **值**：`Judgment` + 時間戳
- **TTL**：`classify.cacheTtlSeconds`（預設 300）
- **上限**：256 條，LRU 淘汰
- **持久化**：僅在記憶體（session 級），不寫磁碟（隱私）
- `COMPASS_CACHE=0` 關閉

理由：使用者常重複或近似地提問（重跑、改一個字），
本機分類再快也是 80ms；快取命中把它壓到 5ms 以內。

### 6.3 其餘手段

- **啟動預熱**：session start 即起 bridge 並預載模型
- **延續訊息早退**：`minPromptChars` 門檻，0ms
- **單次前向**：laya 編碼器一次 forward 出五個判斷，
  **不做五題 fan-out**（cloud 版才是一題一問）
- **平行啟動**：分類與 prompt 收尾平行發起，
  Stage 4 才同步等待——把分類延遲藏進 TUI 繪製時間
- **fail-open 快路徑**：失敗分支**不重試**直接落預設層級，
  避免 3 次重試 × 超時 = 最壞 10 秒

### 6.4 觀測

- 每個 entry 記 `classify: <source> <n>ms (hit|miss)`。
- `/compass status` 顯示 `classify p50/p95 · hits · saved ms`。

---

## Part 7 — 切換成本（prompt cache）

- **估算**：`contextTokens × (new.input + new.cacheWrite − current.cacheRead)`
- `> cache.maxPenaltyUsd` → 擋下切換（`bypassTierDelta` 可越過）
- **deadband**：demand 需超出當前層 ±`deadband` 才換層
- **大跳豁免**：層級差 ≥ `bypassTierDelta` → 無條件切
- **同層專家互換**（如 Sonnet ↔ Codex）仍是模型變更，同樣計價
- **冷卻**：`cooldownSeconds` 內僅大跳與 hardRatio 降級可再切
- 價格未知 → **跳過估算**（絕不因猜測而擋）
- `cache.aware: false` → 無條件切換
- entry 記 `cache miss ≈ $X`；`/compass status` 顯示
  `switches: N · cache miss ≈ $Y`

---

## Part 8 — 預算

```
pressure = max(today÷dailyUsd, month÷monthlyUsd)
```

- `≥ softRatio (0.7)` → 降一層
- `≥ hardRatio (0.9)` → 強制 quick（`demand ≥ 2.5` 例外）
- 記帳來源：每個 assistant message 的計算成本 → `state.json`
- **laya 分類不記帳**
- 上限是**政策非硬擋**：改路由，不擋回合
- `0` 或 `null` → 移除該維度上限

---

## Part 9 — 四層模型政策 [狀態：**已確認保留 — 2026-10-01**]

> ✅ 使用者 2026-10-01 回答「保留（規格預設）」，本節全部生效。
> 選項「刪除」當時已評估並否決，其確定後果留作記錄：移除本 Part、
> Stage 3 改為「專家鏈 → 層級鏈 → 池」三段（不再切價格帶）、
> 刪除 `policy/facts.ts`、`policy/model-facts.json`、
> `scripts/refresh-facts.mjs`，並移除 `test/config.test.ts`
> （#38 autoRoutes 推導、#109 事實檔校驗）與 `test/model-pick.test.ts`
> （#223 逾頂上限拒絕、#269 預算壓力夾緊）中的價格帶斷言。
> 本節是你 `config.ts` 新增 1,340 行的主體，
> 以及那三個 100% 原創檔案的用途所在。

四層，高者優先：

| 層 | 內容 | 誰寫 |
| --- | --- | --- |
| L3 顯式 | config.json 的 `routes`／`kindModels`／`prefer` — **永不過濾** | 使用者 |
| L2 政策 | `profile`／`ceilings`／`deny`／`allowProviders`／`freeOnly` | 使用者（1–3 行） |
| L1 事實 | `model-facts.json`（帶日期的能力分數 + 價格快照） | 每版刷新 |
| L0 機制 | demand 組合、守衛、回退（程式碼） | compass |

**價格帶**：天花板指標 `input + 2×output` USD/M。
四（五）層帶寬相鄰，**價格帶互斥**（能力下限做不到互斥——
最強的便宜模型會吃掉所有層）。
帶內依 `capability` 排序；決策時以 registry **即時價格**重驗，
事實檔過期 → fail-open 而非誤路由。

| profile | quick | standard | high | premium | xpremium |
| --- | --- | --- | --- | --- | --- |
| `cheap` | ≤1 | ≤3 | ≤10 | ≤25 | ≤50 |
| `balanced` | ≤1.5 | ≤5 | ≤15 | ≤44 | ∞ |
| `quality` | ≤2 | ≤10 | ≤44 | ∞ | ∞ |

`model-facts.json` schema（**你的原創檔，原樣沿用**）：

```json
{
  "generatedAt": "ISO-8601",
  "source": "string",
  "models": [
    { "provider": "openrouter", "model": "string",
      "capability": number,
      "price": { "input": number, "output": number },
      "estimated": bool?, "note": string? }
  ]
}
```

函式面（沿用 `facts.ts` 原創實作）：
`factsValid()`、`factFor(provider, id)`、`rankedFacts()`、
`blendedOf(price)`、`sliceBands(ranked, ceilings)`。

`refresh-facts`：`npm run refresh-facts`（`-- --dry-run` 預覽）；
價格**從 pi 的 model catalogue 同步，不手抄**；
能力分數人工核對後寫入；報告 slug 漂移與未評分模型。

---

## Part 10 — 使用者介面

### 10.1 命令

| 命令 | 作用 |
| --- | --- |
| `/compass-set` | 設定選單（TUI 原生 pick-list，不耗 token） |
| `/compass` | 狀態：mode、spend、tier 鏈、專家、分類器狀態、最後決定 |
| `/compass on｜off` | 主開關（session-only） |
| `/compass mode auto｜confirm｜notify` | 切換模式（session-only） |
| `/compass budget daily 10` | session-only 日上限 |
| `/compass budget monthly 150` | session-only 月上限 |
| `/compass why` | 重跑分類並顯示完整判斷 + 決策軌跡 |
| `/compass revert` | 回到上一次 auto-switch 之前的模型 |
| `/compass suggest` | **移植 #12**：從本地分數檔提議路由（不切換） |
| `/compass-route <text>` | 分類任意文字並顯示建議，不切換 |

`on/off`、`mode`、`budget` 為 session-only；
持久化用 `/compass-set` 或 `compass_config`。

### 10.2 `/compass-set` 選單

沿用你 `settings-ui.ts` 的結構（原創檔），項目改名：

```
/compass-set
  compass 設定（↑↓ 選擇，Enter 確認，Esc 結束）
  每日上限 ................ $5.00
  每月上限 ................ $100.00
  路由模式 ................ confirm — 每次切換前先問你
  分類後端 ................ Laya 本機（離線）  ← 新增
  Laya checkpoint .......... aac6fef/laya-multilingual-mlx  ← 新增
  模型鏈 .................. quick 首選 … · high 首選 …
  價格 profile ............ balanced
  cache 感知 .............. 開 · 冷卻 300s
  特殊情境（free-only）..... 關
  任務最低層級 ............ 全部 10 種皆有下限：plan≥high · review≥high ·
                            implement/debug/refactor/research/operate≥standard ·
                            chat/explain/write≥quick
  重設某項回預設 …
  結束
```

每項驗證 → 寫入 `config.json`（**時間戳備份落在同目錄**）
→ 重載進執行中 session → 才重繪選單。

保留你檔案裡的 helper 語意：
`parseChain()`、`parseAmount()`、`providerLabel()`、
`providerFromLabel()`、`modeLabel()`、`modeFromLabel()`、
`runSettingsWizard(hooks)`。

### 10.3 狀態列

`compass:standard · $0.42 · 74% · notify`（mode 非 auto 才顯示 mode）
／ 未路由前 `compass:on` ／ 停用 `compass:off`
／ free-only 情境顯示 `free-only`

### 10.4 transcript entry

```
compass → standard  openrouter/xiaomi/mimo-v2.6-pro
plan · complexity 1.70/3 · capability 1.55/3 · reasoning 0.82 → high (used standard)
· budget 74% of cap → one tier down · classify laya 12ms (miss)
```

展開顯示：kind 與信心、complexity、capability、deep-reasoning、
composed demand、budget pressure、
thinking 的 resolved／judged／**applied after clamp**、
`picked`（menu 選中者）、拒絕原因 notes。

未路由也要顯示原因（`acknowledgement`／`continuation`／
`no route available`），同因同模型的重複 skip **合併**。

---

## Part 11 — 模組切分

對照問題：`config.ts` 已膨脹到 1,562 行、`index.ts` 1,059 行。
新結構按職責切開，單檔目標 < 400 行。

```
pi-compass/
├── extensions/pi-compass-router/          # 副目錄名同 Part 1 定案
│   ├── index.ts              # pi 接線：事件、命令、工具、切換（<500）
│   ├── schema.ts             # 型別、枚舉、預設值、白名單檢查（純）
│   ├── config/
│   │   ├── load.ts           # 三層解析、warnings、env 驗證
│   │   └── env.ts            # COMPASS_* 定義與 parse
│   ├── classify/
│   │   ├── types.ts          # Classifier 介面、Judgment、ClassifyInput
│   │   ├── analysis.ts       # buildQuestions + parseAnalysis + sanitizeRemote
│   │   │                     #   （新增 2026-10-01：這三個函式原屬禁讀的
│   │   │                     #   `jev.ts`，由本檔重新實作）
│   │   ├── cache.ts          # 分類快取（Part 6.2）
│   │   ├── laya.ts           # 本機 bridge
│   │   ├── cloud.ts          # cloud 後端（可替換 provider）
│   │   └── server.py         # laya JSONL stdio
│   ├── route/
│   │   ├── compose.ts        # Stage 2：demand / tier / thinking
│   │   ├── select.ts         # Stage 3：專家 → 層級 → 池
│   │   ├── guard.ts          # Stage 4：budget / cache / cooldown
│   │   └── apply.ts          # Stage 5：model+thinking+entry
│   ├── policy/
│   │   ├── facts.ts          # 事實查詢、band 切片（沿用你的原創）
│   │   ├── model-facts.json  # 沿用你的原創
│   │   └── filter.ts         # deny / allowProviders / prefer
│   ├── budget.ts             # 記帳與壓力
│   ├── suggest.ts            # /compass suggest（本地分數檔）
│   └── ui/
│       ├── wizard.ts         # /compass-set（沿用你的原創）
│       └── entries.ts        # transcript entry 渲染
├── test/
├── scripts/refresh-facts.mjs # 沿用你的原創
├── NOTICE
├── SPEC.md
├── package.json
└── tsconfig.json
```

**相依方向**（避免迴圈）：
`schema` ← `config` ← `classify` / `policy` ← `route` ← `index`
`budget` / `cache` 被 `route/guard` 單向依賴。

---

## Part 12 — 測試計畫

沿用你 7 個測試檔的**斷言內容**（原創），模組路徑改為 `compass`：

| 檔 | 來源 | 內容 |
| --- | --- | --- |
| `config.test.ts` | 你的（全新） | schema 解析、預設值、env 覆寫、非法值丟棄 |
| `config-write.test.ts` | 你的（全新） | 白名單拒絕、patch 非覆寫、null 清上限 |
| `thinking.test.ts` | 你的（全新） | 四層 thinking 解析、clamp readback、pin 優先 |
| `model-pick.test.ts` | 你的（全新） | menu gate：registry／deny／rated／capability／價格帶 |
| `laya.test.ts` | 你的（全新） | bridge 規約、崩潰重啟、fail-open |
| `settings-ui.test.ts` | 你的（全新） | 標籤往返、驗證、寫入備份 |
| `latency.ts` | 你的（全新） | 分類延遲量測 |
| `pipeline.test.ts` | **新增** | Stage 1–5 各自的純函式 |
| `analysis.test.ts` | **新增**（2026-10-01 補） | 問題集建構、laya 回應解析、score→0–3 正規化、非法種類拒絕、`sanitizeRemote` 上限 |
| `cache.test.ts` | **新增** | 快取命中／TTL／LRU／config 失效 |
| `suggest.test.ts` | **新增** | 分數檔 → 路由提議 |
| `budget.test.ts` | **新增** | soft/hard 壓力、demand ≥2.5 例外 |

`npm test` 改用 **`node:test`（內建，零新相依）**；斷言沿用
`node:assert/strict`，刪除各測試檔手寫的 `test()` 與 pass/fail 計數 helper
（例：`test/config.test.ts:18` 的 `async function test(...)` 與結尾的
`passed`/`failures` 計數）。`package.json` 的 `test` script 定為：

```json
{
  "test": "esbuild test/*.test.ts --bundle --packages=external --platform=node --format=esm --outdir=build/test && node --test build/test/*.test.js"
}
```

**輸出目錄必須在 `node_modules` 之外。** 2026-10-01 實測（Node v22.23.2）：
`node --test node_modules/...` 恒回 `Could not find '<path>'`，即使檔案確實存在
（11,876 B）——Node 的 test runner 在解析位置參數時排除 `node_modules`。
非 `node_modules` 路徑的同一檔案：`6 tests, 6 pass, fail 0, exit 0`。
另一個已踩过的 gotcha：**目錄形式 `node --test build/test`（無尾斜線）會回
`MODULE_NOT_FOUND`**（被當成模組 require），必须用 glob 形式 `build/test/*.test.js`。

取代現有 13 支指令的字串串接。`typecheck` 保持 `tsc --noEmit`。
`build/` 加入 `.gitignore`（編譯產物）。
CI：`.github/workflows/ci.yml`，兩個 job（`typecheck`、`test`），
push 與 pull_request 皆觸發。

驗收：

1. `npm test` 全綠
2. `npm run typecheck` 零錯
3. `pi -ne -e <path>` 可載入並完成一次切換
4. laya 後端延遲 p95 < 80ms（`test/latency.ts` 實測）
5. 上游識別標記掃描。**只有 exit code `1` 算通過**：`0` = 有命中 = 失敗，
   `2` = grep 錯誤（路徑不存在）= **根本沒跑**，不得當作通過
   （2026-10-01 實例：命令裡的 `scripts/` 尚不存在，回 exit=2，
   极易被誤讀成零結果）：

   ```sh
   grep -riE 'da-vinci-noob|pi-jev-model-router|JEV_' extensions/ test/ package.json README.md; echo $?   # 要 1
   grep -rnwE 'Jev' extensions/ test/; echo $?                                                          # 要 1
   ```

   只掃**當時實際存在的路徑**；`scripts/` 要等 Part 13 #7 的
   `refresh-facts.mjs` 建立後才存在，未建立前加進去只会让 grep 回 2。
   第二條僅允許命中**雲端模型預設代號 `"jev-latest"`**（typesafe API 的
   模型別名，屬第三方 API 事實，見 Part 4.3）。它實際住在
   `schema.ts` 的 `DEFAULT_CONFIG.classify.cloud.model`——預設值就該待在
   預設表裡；`classify/cloud.ts` 是另一個合理位置。兩處皆可，其餘零命中。
   另允許 `classify/analysis.ts` 檔頭以 `jev.ts` **指名禁讀來源**（Part 0.4
   要求的出處揭露，不是引用其程式碼）——這是唯一一處允許提上游檔名的地方。
6. **上游重複區塊審計**（與完成條件「不開啟 Part 0.2 檔案」的衝突已解，見下）：
   實作凍結後，由**未參與實作的程序**（獨立子代理或主代理皆可）對
   Part 0.2 清單逐一跑 diff，`>3 行連續相同即失敗`。

   **方向必须單向**：審計結果只回報 `失敗檔名 + 區塊數 + 行數`，
   **不得回傳相同區塊的內容**，實作端也**不得**為了修通過而去看上游怎麼寫。
   失敗的處理是**整段重寫**（換一種自己的表達），不是逐行對齊。
   實作期間的任何 diff、grep、cat、git show 都是 clean-room 違規，
   這條驗收只在凍結後執行一次。

---

## Part 13 — 決議紀錄（已全部解除，2026-10-01）

| # | 事項 | 決議 | 回填位置 |
| --- | --- | --- | --- |
| 1 | 四層政策是否保留 | **保留**（選項「刪除」已評估並否決） | Part 9 標題與 ⚠️ 區塊 |
| 2 | LICENSE 授權 | **MIT**；`LICENSE`（版权人 `Ethan`，取自 git 身分，如需法定姓名请告知）與 `NOTICE` 四段初稿**已於 2026-10-01 被使用者逐段核准（含第 4 段揭露）**，兩檔已建立並定稿 | `LICENSE`、`NOTICE` ✅ 已完成 |
| 2b | `NOTICE` 是否隨 npm 包發佈 | **隨包發佈**（預設）——加入 `package.json` 的 `files` 欄，使 attribution 随 tarball 可见；回覆「不隨包」才移除（將只剩 GitHub 可见，不利 attribution） | `package.json` `files` 欄 |
| 3 | npm 發佈策略 | **公開非 scoped**，套件名 `pi-compass-router`（`pi-compass` 已被 Matt Devy 同名 Pi 擴充佔用） | Part 1 |
| 4 | 舊 repo `pi-jev-router` 處置 | **保持公開**；法定須留上游 MIT notice，且公開 attribution 對本專案有利。與 pi-compass 完全解耦 | Part 0.5 |
| 5 | `xpremium`／`freePool` 預設值 | **皆 `false`**（維持規格原值，未要求翻轉） | Part 3 schema |
| 6 | `classify.timeoutMs` | **維持 800**；若實測推翻，執行已寫死的判定：`test/latency.ts` 對 cloud 跑 20 次取 p95，`p95 > 800 → 改 2000`，並回填 Part 6.1 | Part 6.1 |
| 7 | 模型預設鏈 | **未定**，阻塞 Stage 3 實作。解除動作固定：`npm run refresh-facts -- --dry-run` → 依 Part 9 價格帶切片 → 寫入 `routes` → `pi -ne -e` 實測四層可切換 | `routes` 預設值 |

發佈前還需完成的機器側前置（非決策）：npm 登入（本機 `npm whoami` 回 `ENEEDAUTH`）、
`npm pack --dry-run`、`pi -ne -e` 載入驗證。

---

## 完成條件

本規格的七項決策已於 2026-10-01 全數回填（Part 13 決議紀錄）。
開始寫第一行程式碼前，先完成：

1. ✅ 已完成 — `LICENSE`（MIT）與 `NOTICE`（Part 0.5 四段）已建立，NOTICE 於 2026-10-01 經使用者逐段核准；
2. 建立 `package.json`（`name: "pi-compass-router"`）與 `tsconfig.json`；
3. 確認 Part 11 的模組骨架與空殼測試建置通過；
4. 實作 Stage 3 前先執行 Part 13 #7 的 refresh-facts 流程。

實作期間：

- 不開啟 Part 0.2 列出的任何檔案；
- 不從 git 歷史取出上游版本對照；
- 新增功能先補規格再寫程式；
- 任何發現規格不足處，回填本檔並註記日期。