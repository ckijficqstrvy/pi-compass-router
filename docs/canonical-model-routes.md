# 設計草稿：Canonical Models × Routes（2026-10-05）

> 狀態：**S1/S1b/S2 已實作（分支 `feat/canonical-model-routes`）；S3 以後待裁決**。本檔描述把
> 「能力／價格／偏好」三者拆開的資料模型與遷移路徑。S2 以 `selection` 旗標提供
> （預設 `bands`＝現行行為不變；`registry`＝可行集），失敗一律回退 bands。
>
> 進度：S1（canonical 身分 + route/endpoint 模組）、能力向量化（intelligence 為主分數，
> coding/agentic 有來源才填）、S1b（refresh 快取 OpenRouter endpoints）完成。
> S2：`selection: "registry"` → `policy/candidates.ts` 由 registry 全體建可行集
> （能力查 canonical、價格取健康 endpoint 中位數、政策/冷卻照舊），接上
> `selectTargets`/`planTurn`。實測 504 routes、每層上限 25 並去重。
> 實測 deepseek-v4.1-flash 30 個上游最便宜健康價 $0.09/$0.18 vs 摘要價 $0.3/$1.2。

## 1. 問題：三個不同的東西被擠在同一張表

現行 `model-facts.json` 的一筆條目 = `{provider, model, capability, price}`。這把三種
生命週期完全不同的東西綁在一起：

| 東西 | 屬於誰 | 變動速度 | 現況問題 |
| --- | --- | --- | --- |
| 能力 capability | **模型**（canonical，provider 無關） | 慢（改版才變） | 同一模型在 openrouter 與直連被當兩個模型，分數重複且只覆蓋 openrouter |
| 價格／可用性 | **route / endpoint** | 快（每個上游不同） | 壓成單一 `price`；實測 openrouter 一個模型有 30 個上游、價差可達 30× |
| 偏好（我這週愛用誰） | **使用者** | 很快 | 用 `prefer`/`deny` 手設 config，新模型要手動加、不愛了要手動刪 |

**核心症狀**：band/tier 是「規則」，每多一個考慮就要多一組規則，彼此打架 → 「情境太多」。
解法不是把情境列完，是**加維度 + 一個目標函數**。

## 2. 實體模型

```jsonc
// (A) model：能力是模型級，provider 無關。canonical 是身分，aliases 是各家的叫法。
{
  "canonical": "deepseek/deepseek-v4.1-flash",
  "capability": { "intelligence": 39, "coding": null, "agentic": null },
  "contextWindow": 1048576,
  "source": "AA intelligence index, reasoning max effort, 2026-10-05",
  "estimated": false
}

// (B) route：provider 對某 canonical 的取用方式。價格/可用性是 route 級。
{
  "canonical": "deepseek/deepseek-v4.1-flash",
  "provider": "openrouter",
  "kind": "aggregator",              // aggregator | direct
  "model": "deepseek/deepseek-v4.1-flash",   // pi registry 的 slug
  "endpoints": [
    { "upstream": "Relace",       "input": 0.003, "output": 2.4, "contextWindow": 1048576, "status": 0 },
    { "upstream": "InferenceNet", "input": 0.05,  "output": 0.3, "contextWindow": 1040000, "status": 0 }
  ]
}
{
  "canonical": "deepseek/deepseek-v4.1-flash",
  "provider": "deepseek",
  "kind": "direct",
  "model": "deepseek-flash",
  "endpoints": [{ "upstream": "deepseek", "input": 0.3, "output": 1.2, "contextWindow": 1000000, "status": 0 }]
}

// (C) provider profile：不是每個 provider 都一樣，而且要能放「特色」
{
  "provider": "openrouter", "kind": "aggregator",
  "billing": { "funded": null, "lastQuotaAt": null },   // 由 402 事件更新
  "reliability": { "windowDays": 14, "failRate": 0.0 }, // 由 decisions.jsonl 算
  "dataPolicy": "…"
}

// (D) preference：學來的、會衰減、**使用者不手改**
{
  "deepseek/deepseek-v4.1-flash": { "byKind": { "implement": { "score": 0.6, "updatedAt": "…" } } }
}
```

## 3. 決策函數（取代 price-band）

```
需求   ← 每回合由分類/JEV 產生：{ kind, floors: {intelligence, coding}, minContext, costSensitivity }
可行集 ← registry 所有 route，過濾：
         能力達 floors、context 夠、provider 允許、未冷卻、剩餘預算付得起
定價   ← 每條 route 取「最便宜且 status 正常的 endpoint」的 blended 價（程式解，不用 LLM）
選擇   ← argmin( 本回合預估花費 − bounded 偏好加分 )；護欄（budget hard cap/deny）不參與排序
```

- **可路由 = pi registry**（不再由 facts 白名單決定）。facts 只回答「我知道的能力」。
  使用者手動選一個 registry 有的新模型 → 它自動進入可行集（`allowUnratedPicks` 精神）。
- 能力是 canonical 級：openrouter 與直連的同一模型共享同一個分數，不可能再出現
  「只比較 openrouter 分數」。
- 價格是 route 級且**決策時即時算**，不進 band、不寫死。

## 4. 資料來源

| 資料 | 來源 | 誰維護 |
| --- | --- | --- |
| 能力分數 | Artificial Analysis（intelligence/coding/agentic index） | 人工核對，refresh 只報告 estimated/缺分 |
| 可路由模型 | pi registry（`~/.pi/agent/models-store.json`） | 自動 |
| route 報價 | OpenRouter `/api/v1/models/{id}/endpoints`；直連用 registry `cost` | refresh 自動 |
| 熱門度/可靠度 | OpenRouter rankings、`decisions.jsonl` 的 ok/429/5xx | 自動 |
| 偏好 | `decisions.jsonl` 的 manual-override / revert（**跟錯誤無關的那些**） | 學習，會衰減 |

## 5. 遷移路徑（每步都可獨立驗收）

- **S1（本分支）資料層**：新增 canonical 身分 + route/endpoint 模組 + refresh 抓 endpoints。
  **不改路由行為**，只新增模組與測試。
- **S2 registry-wide 可行集**：`selectTargets` 的候選改由 registry routes 產生（能力查 canonical），
  保留現有 band 路徑為 fallback/對照。加 `selection: "bands" | "registry"` 旗標。
- **S3 目標函數**：以 floors + 最便宜 endpoint 取代 band 排序。
- **S4 偏好學習**：從 decisions.jsonl 學衰減偏好，當 bounded tie-breaker。
- **S5 JEV 短名單選**：requirements 由 JEV 產生，只在可行集內選。

## 6. 明確不做（本輪）

- 不送全模型清單給 JEV；不做自由選擇。JEV 只在 S5、且只在可行集內。
- 不改 `health.ts` 的冷卻語意（route 級健康留待 S2 再談）。

## 7. 風險

- **偏好回饋迴圈**：便宜→常用→偏好高→鎖死。對策：偏好加分有上限、只在可行集內、保留少量探索。
- **能力分數覆蓋/時效**：新模型可能沒分數 → `estimated`/未知要能存在，靠手選與 `allowUnratedPicks`。
- **endpoint API 成本**：每模型一次呼叫做快取，refresh 才更新，不在路由路徑上。
- **migration 體積**：S1 必須零行為變更，否則 gate 會紅。
