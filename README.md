# pi-compass-router

pi-compass 是一個 [pi](https://github.com/earendil-works/pi) 擴充：每輪對話開始**之前**，
它先判斷這次請求屬於什麼任務、需要多強的模型，再把本輪切換到合適的
模型與思考層級。

設計上的四個取捨：

- **判斷與政策分離** — 分類器只回答「這是什麼任務、要多強」；預算、
  價格帶、可用性由程式碼決定。
- **local-first** — 預設用本機分類後端，不需要 API key、不打網路。
- **fail-open** — 分類失敗、逾時、模型不可用時警告並沿用當前模型，
  絕不擋住使用者的回合。
- **可見** — 每次判斷都寫進 transcript entry，記錄選了誰、為什麼。

## 安裝

尚未發佈到 npm，用 git 或本機路徑安裝：

```sh
# 從 GitHub
pi install https://github.com/ckijficqstrvy/pi-compass-router

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
| `/compass budget daily <n>` | session-only 日上限（`monthly` 為月上限） |
| `/compass why` | 顯示最近一次路由決定的完整細節（分類結果/信心、demand、tier、模型、thinking、cache 估算） |
| `/compass log [n]` | 檢視最近 n 筆決策日誌（預設 10）與聚合統計（applied/held/skipped/cancelled、kind/tier/model 排行、cache miss 平均）；純本地、不切換 |
| `/compass revert` | 回到上一次自動切換之前的模型（並記一筆 revert 回饋） |
| `/compass suggest` | 從本地分數檔提議路由；未設定分數檔時用決策日誌自動校準（僅提議，不切換） |
| `/compass refresh-facts` | 同步 model facts 的價格（能力分數仍人工核對）；事實檔過舊時 session 啟動會提醒 |
| `/compass-route <text>` | 對任意文字分類並顯示建議，不切換 |

持久化設定走 `/compass-set` 與 `compass_config` 工具；
工具另有 `compass_route` 供對話中呼叫。

## 一般使用 vs 進階設定

預設**不需要調任何設定**：事實檔自動推導模型鏈、分類器自動選路徑，`/compass-set`
只顯示必要的幾項（啟用/模式、預算上限、價格 profile、分類後端、顯示與語言）。
工程師向設定（`cache.*`、`thinking` pin、專家鏈、`deny`/`ceilings`、`suggest` 分數檔、
鏈來源診斷⋯）藏在 ① 路由行為 → **進階選項** 後面（`advanced: true`）。

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

## 設定

- 設定檔：`~/.pi/agent/pi-compass/config.json`
- 狀態檔：`~/.pi/agent/pi-compass/state.json`
- 決策日誌：`~/.pi/agent/pi-compass/decisions.jsonl`（JSONL；**只存非內容欄位**：kind、demand、tier、模型、thinking、結果與使用者回饋，不存 prompt）。預設開啟，`"decisionLog": false` 可關。
- 環境變數：`COMPASS_*` 前綴，解析順序為「內建預設 → config.json → 環境變數」，後者勝。

## Requirements

- Node.js ≥ 22.19（與 pi 自身 `engines.node` 的下限一致；測試使用內建
  `node:test`，無其他執行期相依）
- 已安裝並可執行 `pi` CLI（擴充載入）
- 本機分類後端需要 Python ≥ 3.11 與 laya-mlx（可用 cloud 後端取代）

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
model catalogue 兜底），**能力分數**永不自動猜，改用榜單人工核對（附出處）。
建議定期跑，例（每週一 06:00 寫進 `crontab -e`）：

```cron
0 6 * * 1 cd /path/to/pi-compass && npm run refresh-facts >> /tmp/pi-compass-refresh-facts.log 2>&1
```

超過 14 天未更新時，`/compass-set → ⑦ 看鏈的來源` 會標警示。

## License

MIT — 詳見 `LICENSE` 與 `NOTICE`。
