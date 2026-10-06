# pi-compass-router

pi-compass 是一個 [pi](https://github.com/earendil-works/pi) 擴充：每輪對話開始**之前**，
它先判斷這次請求屬於什麼任務、需要多強的模型，再把本輪切換到合適的
模型與思考層級。

> 目前版本 **v0.10.0**（canonical models × routes）。最新變更見
> [Releases](https://github.com/ckijficqstrvy/pi-compass-router/releases)。

設計上的四個取捨：

- **判斷與政策分離** — 分類器只回答「這是什麼任務、要多強」；預算、
  價格帶、可用性由程式碼決定。
- **local-first** — 預設用本機分類後端，不需要 API key、不打網路。
- **fail-open** — 分類失敗、逾時、模型不可用時警告並沿用當前模型，
  絕不擋住使用者的回合。
- **可見** — 每次判斷都寫進 transcript entry，記錄選了誰、為什麼。

## 目錄

- [運作方式](#運作方式)
- [安裝](#安裝)
- [命令](#命令)
- [設定](#設定)
- [顯示與語言](#顯示與語言)
- [一般使用 vs 進階設定](#一般使用-vs-進階設定)
- [Requirements](#requirements)
- [開發](#開發)

## 運作方式

每一輪在模型回應之前，依序跑這幾步（純本地、決定性）：

```
prompt ──▶ ① 分類 kind + demand ──▶ ② demand+floor → tier
        ──▶ ③ 取候選鏈（bands 或 registry）──▶ ④ 硬約束與護欄
        ──▶ ⑤ 依 mode 切換模型 / 套 thinking ──▶ 寫 transcript entry
```

- **① 分類**：判 `kind`（10 種任務）與 `demand`（0–3 強度）；結果進快取，
  同一 prompt 不重複判。
- **② 定層**：`tier` ∈ `quick < standard < high < premium < xpremium`，
  由 demand 與該 kind 的 `floor`／`kindMinimumTier` 決定。
- **③ 候選鏈**：每個 tier 有一條候選鏈，來源見下方「候選來源」。
- **④ 護欄**：`deny`、`allowProviders`、預算（軟/硬比例）、provider 健康冷卻、
  切換成本 deadband／prompt-cache 懲罰。**護欄不參與排序，只做否決與讓路。**
- **⑤ 套用**：依 `mode` 決定切換與否（見下表），並把決策寫成一則
  transcript entry（不進 LLM context）。

### 模式（`mode`）

| mode | 切換模型 | 套用 thinking | 說明 |
| --- | --- | --- | --- |
| `auto` | 是 | 是 | 全自動切換 |
| `confirm` | 每次切換前先問你 | 是 | 你同意才切 |
| `notify`（預設） | **否**，只通知 | **否** | 觀察用；entry 標 `not applied (notify mode)` |

> 預設是 `notify`：**開箱只觀察、不切換**。要真的讓 compass 動模型，
> 用 `/compass mode auto` 或 `/compass mode confirm`（session-only），
> 或在 `/compass-set → ① 路由行為` 設定持久值。

### 候選來源（`selection`）

`v0.10.0` 起候選鏈有兩種來源，由 `selection` 切換：

- **`bands`（預設）** — 依 `model-facts.json` 的價格帶切片，每層看自己那一帶。
  與所有舊版行為相同。
- **`registry`** — 由 pi registry **全體**建可行集：能力 ≥ 該層下限、中位數健康
  endpoint 價 ≤ 該層天花板、政策允許、未冷卻；再依「能力降、同分價升」排序，
  每層上限 25 條、去重。同一模型的多條 provider route 會一起出現，天然形成
  跨 provider 備援；`registry` 無可行集時**自動退回 `bands`**。

```json
{ "selection": "registry" }
```

設定 `selection` 前建議先 `/compass-set → ⑦ 看鏈的來源` 檢視實際候選。

### Canonical 模型身分與 route 報價

`model-facts.json` 的一筆條目曾把「能力／價格」綁在一起，導致同一模型在
openrouter 與直連被當成兩個能力、價格也被壓成單一數字。現在拆開：

- **能力是模型級（canonical，provider 無關）** — 同一 canonical 跨 provider／別名
  共用一個分數；`intelligence` 是主分數，`coding`／`agentic` 有來源才填。
- **價格／可用性是 route／endpoint 級** — 每條 route 取「最便宜且健康的 endpoint」
  的 blended 價（`input + 2×output`）。`npm run refresh-facts` 會快取 OpenRouter
  `/endpoints` 報價到 `~/.pi/agent/pi-compass/openrouter-endpoints.json`。

### 偏好學習（S4）

偏好**不是** config，是從行為學來的、會衰減的排序加分：

- 訊號來自 `decisions.jsonl`：手動覆寫（`manual-override`）、`revert`、
  以及成功回合（`usage.ok`）；provider 錯誤**不算**偏好（那是 health 的事）。
- **依 kind 分開記**，半衰期 14 天，原始分夾 ±3、加分夾 ±5。
- **只當可行集內的排序 tie-breaker**，永不推翻硬約束（能力下限／價格天花板／政策）。

所以「這週愛用某個模型」用久了自己會升上來；不愛了、不用它，分數自然淡掉，
不必回頭改 `prefer`／`deny`，新模型也不用逐一手動加。

### OpenRouter 上游路由（`max_price`）

OpenRouter 一個模型可能有多個上游、價差數十倍。上游選擇設在 **pi 層**的
`~/.pi/agent/models.json`（不是本擴充的 `config.json`）：

```jsonc
{
  "providers": {
    "openrouter": {
      "modelOverrides": {
        "xiaomi/mimo-v2.6-pro": {
          "openRouterRouting": { "max_price": { "prompt": 0.87, "completion": 1.74 } }
        }
      }
    }
  }
}
```

做法是用 **`max_price` 上限**（設為 facts 價的 2×），而**不是 `sort: price`**——
後者會讓每輪可能換上游、破壞 prompt cache。加上限則保留預設路由與快取，只擋掉
貴超過兩倍的上游。風險：若某模型所有上游都超限可能回 404；只要任一上游在限內即正常。
要完全不管成本可刪掉該檔，要固定上游可用 `order`。

## 安裝

尚未發佈到 npm，用 git 或本機路徑安裝（建議 pin 到 release tag）：

```sh
# 從 GitHub（pin 到 release tag）
pi install git:github.com/ckijficqstrvy/pi-compass-router@v0.10.0

# 或本機 checkout
pi install /path/to/pi-compass
```

（`npm:pi-compass-router` 在正式發佈後才有。）

## 命令

| 命令 | 作用 |
| --- | --- |
| `/compass` | 顯示目前狀態：模式、花費、層級鏈、分類器狀態、切換次數與最近一次估算的 prompt-cache miss 成本 |
| `/compass-set` | 設定選單（TUI pick-list，不耗 token；能枚舉的設定一律用選的，打字只出現在「自訂…」或沒有候選時；寫入 config.json 並附時間戳備份） |
| `/compass on` \| `/compass off` | 主開關（session-only） |
| `/compass mode auto\|confirm\|notify` | 切換模式（session-only） |
| `/compass budget daily <n>` | session-only 日上限（`monthly` 為月上限；`none` 清除） |
| `/compass why` | 顯示最近一次路由決定的完整細節（分類結果/信心、demand、tier、模型、thinking、cache 估算） |
| `/compass log [n]` | 檢視最近 n 筆決策日誌（預設 10）與聚合統計（applied/held/skipped/cancelled、kind/tier/model 排行、實際花費與 cost-by-kind/model、故障次數、cache miss 平均）；純本地、不切換 |
| `/compass revert` | 回到上一次自動切換之前的模型（並記一筆 revert 回饋） |
| `/compass suggest` | 提議路由：有設定 `suggest.scoresFile` 時用本地分數檔，否則用決策日誌自動校準；尊重 `selection` 模式（僅提議，不切換） |
| `/compass refresh-facts` | 同步 model facts 的價格（能力分數仍人工核對）；事實檔過舊時 session 啟動會提醒 |
| `/compass-route <text>` | 對任意文字分類並顯示建議，不切換 |

持久化設定走 `/compass-set` 與 `compass_config` 工具；
工具另有 `compass_route` 供對話中呼叫。

## 設定

- 設定檔：`~/.pi/agent/pi-compass/config.json`
- 狀態檔：`~/.pi/agent/pi-compass/state.json`
- 決策日誌：`~/.pi/agent/pi-compass/decisions.jsonl`（JSONL；**只存非內容欄位**：kind、demand、tier、模型、thinking、結果、使用者回饋、逐輪用量/成本、provider 故障；不存 prompt 或對話原文）。預設開啟，`"decisionLog": false` 可關。
- OpenRouter endpoint 快取：`~/.pi/agent/pi-compass/openrouter-endpoints.json`（`refresh-facts` 產生）。
- 環境變數：`COMPASS_*` 前綴，解析順序為「內建預設 → config.json → 環境變數」，後者勝。
- **無專案級設定**：設定路徑固定，複製 repo 不會注入路由設定。

### 常用設定鍵

| 鍵 | 值 | 預設 | 說明 |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | 主開關 |
| `mode` | `auto｜confirm｜notify` | `notify` | 切換模式（見上表） |
| `profile` | `cheap｜balanced｜quality` | `balanced` | 價格帶檔位，決定每層價格天花板 |
| `selection` | `bands｜registry` | `bands` | 候選來源（見上） |
| `classify.provider` | `laya｜cloud` | `laya` | 分類後端（見下） |
| `budget.dailyUsd` / `monthlyUsd` | number｜null | `5` / `100` | 預算上限；`null` = 無上限 |
| `deny` | string[] | `[]` | 模式比對，硬否決（顯式設定除外） |
| `allowProviders` | string[] | `[]` | 白名單 provider |
| `allowUnratedPicks` | bool | `false` | 允許沒能力分數的模型進候選（排最後，上限 3） |
| `stickiness` | bool | `true` | 傾向留在當前模型 |
| `cache.*` | 物件 | — | 切換成本 deadband／prompt-cache 懲罰／冷卻 |
| `thinking.*` | 枚舉 | — | `thinking.pin` 或 `thinking.<kind>` 固定思考層級 |
| `decisionLog` | bool | `true` | 決策日誌 |
| `advanced` | bool | `false` | `/compass-set` 顯示工程師向設定 |

### 分類後端（`classify.provider`）

- **`laya`（預設，local-first）** — 本機 laya-mlx 模型，不打網路、不需 key。
  需要 Python ≥ 3.11 與對應 venv。
- **`cloud`（opt-in）** — 交給雲端分類器，延遲更低但需要該 provider 的 API key
  （在 pi 端設定）。切換方式：

```json
{ "classify": { "provider": "cloud", "cloud": { "provider": "typesafe", "model": "jev-latest" } } }
```

`classify.timeoutMs`（預設 800）與 `confidenceThreshold`（預設 0.34）控制逾時回退
與低信心時的保守處理。

## 顯示與語言

每次路由決策會寫一則 transcript entry（不進 LLM context），收合時是一行
脈絡、展開（`app.tools.expand`）是完整明細：

```
 compass → standard  openrouter/xiaomi/mimo-v2.6-pro
 plan 90% · demand 1.63 · thinking → high · laya 12ms (miss)
```

`/compass-set → ⑥ 顯示與呈現` 可調：呈現密度（compact/standard/full）、
收合列欄位、徽章、配色（rich/mono）、expand 提示、樹狀導軌，以及
**界面語言**（中文／English）。

```json
{ "display": { "language": "en", "color": "mono", "detail": "full" } }
```

命令描述在 session 啟動時定案——切換語言後要重開 session 才會跟進；
選單、entry 與通知則即時生效。

## 一般使用 vs 進階設定

預設**不需要調任何設定**：事實檔自動推導模型鏈、分類器自動選路徑，`/compass-set`
只顯示必要的幾項（啟用/模式、預算上限、價格 profile、分類後端、顯示與語言）。
工程師向設定（`selection`、`cache.*`、`thinking` pin、專家鏈、`deny`/`ceilings`、
`suggest` 分數檔、鏈來源診斷⋯）藏在 ① 路由行為 → **進階選項** 後面（`advanced: true`）。

## Requirements

- Node.js ≥ 22.19（與 pi 自身 `engines.node` 的下限一致；測試使用內建
  `node:test`，無其他執行期相依）
- 已安裝並可執行 `pi` CLI（擴充載入）
- 本機分類後端需要 Python ≥ 3.11 與 laya-mlx（可用 cloud 後端取代，
  但 cloud 需要該 provider 的 API key）

## 開發

```sh
npm install
npm run typecheck
npm test
```

本專案**不使用 GitHub Actions**（CI 有分鐘數限制）。發佈前的唯一關卡是
**本機驗收**，並由 `pre-push` hook 強制——驗收不過就推不上去：

```sh
# clone 後設定一次（把 hook 目錄指向版本控管的 .githooks/）
git config core.hooksPath .githooks

# 手動重跑同一套驗收（typecheck + tests + 真 pi 載入 + laya latency + 靜態檢查）
bash scripts/accept.sh
```

要刻意略過（例如只推文件）：`git push --no-verify`。
想在另一台機器驗證，把 repo clone 過去、`npm ci` 後跑 `bash scripts/accept.sh` 即可。
（`COMPASS_ACCEPT_SKIP_ENV=1` 會跳過需要 pi CLI 與本機 laya 的兩項，僅在沒有這些資源時使用。）

### 更新模型事實（能力分數清單）

`extensions/pi-compass-router/model-facts.json` 是 L1 事實層的唯一來源：
**價格**由 `npm run refresh-facts` 自動同步（OpenRouter API 優先、pi
model catalogue 兜底，並快取 OpenRouter endpoints），**能力分數**永不自動猜，
改用榜單人工核對（附出處）。
建議定期跑，例（每週一 06:00 寫進 `crontab -e`）：

```cron
0 6 * * 1 cd /path/to/pi-compass && npm run refresh-facts >> /tmp/pi-compass-refresh-facts.log 2>&1
```

超過 14 天未更新時，`/compass-set → ⑦ 看鏈的來源` 會標警示。

## License

MIT — 詳見 `LICENSE` 與 `NOTICE`。
