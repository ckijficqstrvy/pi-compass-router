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

```sh
pi install npm:pi-compass-router
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/compass` | 顯示目前狀態：模式、花費、層級鏈、分類器狀態、最近一次決定 |
| `/compass-set` | 設定選單（TUI pick-list，不耗 token；寫入 config.json 並附時間戳備份） |
| `/compass on` \| `/compass off` | 主開關（session-only） |
| `/compass mode auto\|confirm\|notify` | 切換模式（session-only） |
| `/compass budget daily <n>` | session-only 日上限（`monthly` 為月上限） |
| `/compass why` | 重跑分類，顯示完整判斷與決策軌跡 |
| `/compass revert` | 回到上一次自動切換之前的模型 |
| `/compass suggest` | 從本地分數檔提議路由（僅提議，不切換） |
| `/compass-route <text>` | 對任意文字分類並顯示建議，不切換 |

持久化設定走 `/compass-set` 與 `compass_config` 工具；
工具另有 `compass_route` 供對話中呼叫。

## 設定

- 設定檔：`~/.pi/agent/pi-compass/config.json`
- 狀態檔：`~/.pi/agent/pi-compass/state.json`
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

## License

MIT — 詳見 `LICENSE` 與 `NOTICE`。
