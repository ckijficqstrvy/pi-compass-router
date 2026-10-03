# pi-compass-router 路由邏輯獨立審查

## Part 1: Structured Review

## Summary

本審查沿 Stage 1–5 檢查分類、compose、候選選擇、guard、apply 與 `index.ts` 接線，並對照 SPEC Part 5/7/8/9 與指定測試。整體架構已把純規則拆成可測模組，但目前「單元規則正確」沒有保證「端到端政策生效」：301 個測試全過、typecheck 全過，仍可由靜態控制流直接推出預算、偏好、history、confirm 等主路徑失效或產生錯誤紀錄。

最嚴重的是預算子系統有兩層斷點：主要 assistant 成本沒有寫入帳本；即使人為讓帳本有壓力，guard 只改 tier 標籤，沒有按降級後 tier 重選模型。因此目前不能把 budget 描述成已有效控制模型成本。其次，`prefer`、`stickiness: false`、`historyTurns` 都是可設定但端到端不生效的表面功能；menu 與 confirm 路徑也有明顯的資料時序／狀態紀錄問題。

## Strengths

- [S1] Stage 2–4 已抽成純 `planTurn`，且 `currentTier`、`lastSwitchAtMs`、`cachePenaltyUsd` 確實由 `index.ts:143-160` 注入；`test/plan.test.ts:61-140` 覆蓋 stickiness、deadband、cooldown 與 cache penalty。這項證據只支持這三條接線，不支持 budget 或完整 routeTurn 正確性。
- [S2] 分類輸出有明確邊界驗證：非法 kind 會拒絕、score 正規化、未知 thinking/pick 會丟棄（`classify/analysis.ts:255-263,291-331`；`test/analysis.test.ts:111-206`），可降低未受信分類輸出直接授權模型的風險。
- [S3] L2/L3 分層在設定載入時有具體實作：衍生鏈才過濾、顯式鏈保留、prefer 最後插入（`config/load.ts:442-476`；`policy/filter.ts:35-76`）。但 W3/W8 說明此正確性沒有完整延伸到 runtime resolution 與即時價格重驗。

## Weaknesses

### 發現清單（依嚴重度排序）

- [W1] **P0 / FATAL — assistant 主成本沒有接到預算帳本。**  
  **位置：** `extensions/pi-compass-router/index.ts:8-10,327-348`；`extensions/pi-compass-router/budget.ts:152-175`；`extensions/pi-compass-router/classify/cloud.ts:140-142,171-178`；SPEC Part 8 (`SPEC.md:800-816`)。  
  **現象：** `index.ts` 只 import/use `loadSpend`，未 import `recordSpend`，也未註冊 `message_end`/`agent_end` 去記 assistant message 的 `usage.cost`。全 repo 的生產呼叫只有 cloud 分類費用。預設 laya 不計費，因此一般模型回覆成本不會增加 `todayUsd/monthUsd`。  
  **影響：** budget pressure 通常長期為 0；soft/hard ratio 與 UI 顯示沒有反映主要支出。這直接違反 SPEC Part 8「每個 assistant message 的計算成本」。  
  **建議：** 在 assistant `message_end`（或等價且不重複的生命週期事件）以權威 `usage.cost.total` 記一次；加入 routeTurn 整合測試，先產生 assistant usage，再驗下一輪 pressure。分類費用應保留獨立來源標記，避免重複記帳。

- [W2] **P0 / FATAL — budget 降級不會重選模型，tier 與實際 target 分裂。**  
  **位置：** `extensions/pi-compass-router/route/plan.ts:91-107,109-123`；`extensions/pi-compass-router/route/guard.ts:84-106`；`extensions/pi-compass-router/index.ts:187-207`；SPEC Stage 4 (`SPEC.md:638-640`)。  
  **現象：** `planTurn` 先按原 tier 選定 target，再呼叫 guard；guard 只把回傳 `tier` 改成低層，target 不變。Stage 5 仍對原本 high/premium target 執行 `setModel`。SPEC 明寫預算降級後「重新跑 Stage 3」。  
  **影響：** 即使 W1 修好或帳本已有值，soft/hard budget 仍可能切到昂貴模型，只在 entry 中錯標成 standard/quick。cache miss 也在降級前 target 上估算。這是成本控制與決策可觀測性的雙重錯誤。  
  **建議：** 把「budget 決定有效 tier」移到 select 前，或讓 planner 在 guard 回傳 tier 改變時重新 `selectTargets`、重新做 availability 與 cache estimate，再跑 cache/cooldown/mode。新增整合斷言：壓力下 `plan.target` 必須來自降級後鏈，而不只檢查 `guard.tier`。

- [W3] **P1 / MAJOR — `prefer` 注入的 empty-provider target 在 availability 階段必定被丟棄。**  
  **位置：** `extensions/pi-compass-router/policy/filter.ts:59-76`；`extensions/pi-compass-router/index.ts:80-84,157-160`；`extensions/pi-compass-router/route/apply.ts:132-136`；SPEC Part 9 (`SPEC.md:832-839`)。  
  **現象：** `insertPrefer` 有意產生 `{provider:"", model:<bare key>, explicit:true}`，但 `resolveModel` 對任何空 provider 直接回 `undefined`。因此 `planTurn` 永遠不會選到 prefer head；目前 apply 的 bare-id 測試繞過了 availability，不能證明端到端可用。  
  **影響：** UI/設定顯示 prefer 已在鏈首，實際路由卻跳過它；L3「顯式勝出」失效。  
  **建議：** 設定時把 `provider/model` 正規解析成完整 Target，或對 bare key 使用 registry 的唯一解析 API；若多 provider 歧義則明確拒絕，而不是靜默跳過。新增 factory/routeTurn 整合測試，而非只測 `insertPrefer` 與 `applyRoute` 各自一半。

- [W4] **P1 / MAJOR — `stickiness: false` 是無效設定，且早退可完全遮蔽 budget。**  
  **位置：** `extensions/pi-compass-router/route/guard.ts:72-81,84-106`；`extensions/pi-compass-router/schema.ts:352-363`；SPEC §3.1 (`SPEC.md:206-218`) 與 Stage 4 (`SPEC.md:632-643`)。  
  **現象：** guard 的 stickiness 判斷沒有讀 `config.stickiness`。此外，當目前模型等於原 tier 選出的 target 時，函式在計算 budget pressure 前直接 `held`。  
  **影響：** 使用者關閉 stickiness 也不能改變行為；更嚴重的是高成本模型若仍是原鏈首，即使已過 hard cap 也不會進入 budget 降級。  
  **建議：** 至少以 `config.stickiness` 包住 early return；預算壓力存在時不可由 stickiness 提前結束。較乾淨的順序是先算有效 budget tier/重選，再對「重選後 target」做 stickiness。

- [W5] **P1 / MAJOR — menu 永遠由 fallback standard、無 kind 的鏈產生。**  
  **位置：** `extensions/pi-compass-router/index.ts:126-134`；`extensions/pi-compass-router/route/compose.ts:91-95`；`extensions/pi-compass-router/route/select.ts:50-61,181-232`；SPEC Stage 1–3 (`SPEC.md:515-539,609-627`)。  
  **現象：** Stage 1 在尚無 judgment 時呼叫 `menuKeys(compose(undefined).tier, undefined, config)`；`compose(undefined)` 固定 standard，且 `judgment=undefined` 使 specialist chain 缺席。最終真實 judgment 可能是 quick/high/premium，候選集合已不同。  
  **影響：** high 任務無法從 high/specialist menu 挑選；standard menu pick 到最終 tier 才被 capability/price gate 拒絕，menu 大量退化為無效第六題。  
  **建議：** 明確選一個一致策略：(a) 兩階段 classify（先五題得 kind/tier，再問 menu）；或 (b) 單次分類時提供所有政策允許候選，最終按 tier gate；或 (c) 移除 classifier model-pick，保留 deterministic Stage 3。若延遲優先，不應維持目前看似有 menu、實際 tier 錯配的狀態。

- [W6] **P1 / MAJOR — `historyTurns` 未接線，且分類快取鍵忽略 conversation 與 menu。**  
  **位置：** `extensions/pi-compass-router/index.ts:126-134`；`extensions/pi-compass-router/classify/types.ts:7-15`；`extensions/pi-compass-router/classify/cache.ts:31-46`；`extensions/pi-compass-router/classify/laya.ts:196-202,267-268`；`extensions/pi-compass-router/classify/cloud.ts:95-99,121-125`；SPEC §3.1/4.4/6.2 (`SPEC.md:183-188,497-503,742-750`)。  
  **現象：** routeTurn 沒有建立 `conversation`；laya/cloud 送出的 `state` 也只有 `input.request`。快取鍵只含截斷 request + `taskKinds/modelPick` generation，不含 conversation 或實際 menu。路由／menu 改變時 lifecycle 刻意保留分類器與其快取（`classify/lifecycle.ts:12-30`）。  
  **影響：** `historyTurns>0` 沒有任何效果。若日後接上 conversation，完全相同的短句在不同上下文仍會命中舊 judgment；menu 改版後也可能回舊 `modelPick`，而 final gate 不會驗證它仍在本輪 menu。  
  **建議：** 先真正擷取最近 N 輪並限制 4000 字元，再把 conversation digest、menu digest、問題版本納入 cache key；快取命中後仍應把 `modelPick` 對本輪 menu 重驗。加入相同 request／不同 conversation 與相同 request／不同 menu 的反例測試。

- [W7] **P1 / MAJOR — confirm 的 entry、decision log 與 session state 不代表實際使用者決定。**  
  **位置：** `extensions/pi-compass-router/route/apply.ts:123-127`；`extensions/pi-compass-router/index.ts:191-240,242-268`；`extensions/pi-compass-router/suggest.ts:35-69`。  
  **現象：** confirm 前第一次 `applyRoute` 已寫一條 `→` entry；接受時第二次再寫一條，拒絕時沒有 cancelled entry。後續 state/log 仍使用第一次 `outcome`（`applied=false`）與 guard 的 `result.outcome="applied"`：接受後 `lastExpectedModel` 仍可能是舊模型，下一輪會被誤判 manual override；拒絕也會被 decision log 記成 applied target。confirm 切換亦未設定 `previousModel`，`/compass revert` 不完整。  
  **影響：** transcript 可誤報／重複報切換，決策日誌污染 suggest，自動切換與手動 override 難以區分。  
  **建議：** confirm 前只建立 pending UI，不落「已切換」entry；確認結果後形成唯一 final outcome（applied/cancelled/failed），再一次性更新 previousModel、lastExpectedModel、lastDecision 與 decision log。

- [W8] **P1 / MAJOR — Part 9 的「registry 即時價格重驗」不存在，且 facts 可跨 provider 誤配。**  
  **位置：** `extensions/pi-compass-router/policy/facts.ts:76-86`；`extensions/pi-compass-router/route/select.ts:109-133,242-251`；`extensions/pi-compass-router/index.ts:72-83,157-160`；SPEC Part 9 (`SPEC.md:841-845`)。  
  **現象：** Stage 3 價格/capability gate 與 `tierOfModel` 都讀靜態 `model-facts.json`；runtime registry cost 只用於 cache miss，不用於 ceiling。`factFor(provider,id)` exact miss 後會回任意 provider 的同 id fact。  
  **影響：** 價格快照過期時可把已超 ceiling 的模型繼續選入；不同 provider 同 model id 時，可套用另一 provider 的價格與能力。這與 SPEC「決策時以 registry 即時價格重驗」直接不符。  
  **建議：** Stage 3 注入 runtime fact/cost resolver，以 exact provider/model 的 registry 價格做最後 ceiling 檢查；id-only fallback 只可用於 provider 空白且解析唯一時。靜態 facts 應只負責排序/缺省，不應覆蓋 runtime 價格。

- [W9] **P2 / MAJOR — 低 kind confidence 只降 tier，不撤銷 kind floor 對 demand/thinking/budget 的影響。**  
  **位置：** `extensions/pi-compass-router/route/compose.ts:107-127,138-142`；`extensions/pi-compass-router/route/guard.ts:90-93`；SPEC Stage 2 (`SPEC.md:566-574`)。  
  **現象：** 例如低信心 plan 先把 demand 拉到 2.5，再把 tier 改回 standard；thinking 仍由 2.5 ladder 得 high（若 judgment.thinking 缺），hard budget 也仍吃到 `demand>=2.5` 例外。  
  **影響：** 「不信任 kind」只作用在模型 tier，卻仍信任該 kind 來提高 thinking 與 budget 特赦，語意不一致。  
  **建議：** 分開保存 raw demand、kind-floor demand 與 confidence-adjusted demand；低信心時應明確決定哪些 floor 被撤回。至少新增低信心 plan + missing thinking + hard pressure 的端到端測試並在 SPEC 定義預期。

- [W10] **P2 / MAJOR — continuation/no-route 的 skipped 路徑繞過 Stage 5，與 thinking 契約不一致。**  
  **位置：** `extensions/pi-compass-router/index.ts:116-121,163-184`；`extensions/pi-compass-router/route/apply.ts:102-107,145-151`；SPEC Stage 4/5 (`SPEC.md:647-655`)。  
  **現象：** SPEC 與 `applyRoute` 都說 skipped 在所有模式套 thinking，但 routeTurn 的兩個真 skipped 分支直接 `writeEntry` 後 return。  
  **影響：** 單元測試 `applyRoute(outcome="skipped")` 通過，實際 continuation/no-route 卻不走它；測試證明的是不可達或少用路徑。  
  **建議：** 所有 skipped 統一經 Stage 5，或若 continuation 應保留 thinking，則修改 SPEC 與刪除誤導的 apply 分支。不要維持兩種 skipped 定義。

- [W11] **P2 / MINOR — suggest 的「chosen」統計不影響分數，自動校準名實不符。**  
  **位置：** `extensions/pi-compass-router/suggest.ts:35-72`；`test/suggest.test.ts:54-64`。  
  **現象：** route applied/held 只累加 `chosen`，但 score 公式只用 `pos/neg`；chosen 僅出現在 note。測試甚至固定「chosen-only is neutral」。  
  **影響：** 沒有 revert/manual override 的大量正常使用不會學到任何偏好；W7 又會污染少數 feedback。  
  **建議：** 在 W7 修正後，再用可解釋的弱正訊號納入 accepted route，對 reject/revert 給負訊號，並設最小樣本數／時間衰減；否則把名稱改成「feedback ranking」，不要宣稱自動校準。

- [W12] **P2 / MINOR — `/compass-route` 與 `compass_route` 宣稱分類文字，實際完全忽略文字。**  
  **位置：** `extensions/pi-compass-router/index.ts:481-489,534-548`。  
  **現象：** command 未使用 `args`，tool 未使用 `_params.text`；兩者都 `compose(undefined)`，固定 fallback standard。  
  **影響：** 診斷工具無法驗證真路由，可能讓使用者誤以為分類器或不同 prompt 沒差。  
  **建議：** 共用 Stage 1–4 dry-run 路徑，或把名稱與說明改成「顯示 fallback route」。

## 限制與設計取捨

1. **Cache penalty 只是輸入側近似，不是實際 cache loss。** `route/plan.ts:61-76` 依 `contextTokens × (next.input + next.cacheWrite − current.cacheRead)` 計算，未建模可 cache 比例、prefix 變動、output 成本與 provider cache 規則。這符合 SPEC Part 7 (`SPEC.md:774-796`)，但 entry 應標「上界式估算」而非近似真成本。
2. **UTC budget window 可能違背使用者對「今日／本月」的直覺。** `budget.ts:23-47` 明定 UTC；跨時區使用者會在本地日中重置。這是已規格化取捨，不是實作 bug，但 UI `today` 沒說 UTC（`index.ts:493-504`）。
3. **Budget 是事後壓力而非預授權。** `budget.ts:136-149` 只看累積已花費，沒有估算下一輪成本，因此即使修正 W1/W2，也可能在 cap 前一輪用昂貴模型跨越上限；SPEC Part 8 明說是政策非硬擋 (`SPEC.md:806-811`)。
4. **`freeOnly` 不是硬保證。** 無零元 fact 時會回退 freePool，再回退一般 paid route（`route/select.ts:82-97`；SPEC `SPEC.md:594-607`）。這是 fail-open 取捨，但命名很容易被理解成成本安全保證；建議 UI 顯示「no verified free model; paid fallback」。
5. **未知 currentTier fail-open 會停用 deadband/cache cap。** 這是已知設計（`route/guard.ts:141-143`；SPEC Part 7），但 W8 的 facts 缺漏或 provider 誤配會擴大未知範圍。應監控 unknown 比率，而非只在單次決策靜默跳過。
6. **價格帶指標與真工作負載不匹配。** `policy/facts.ts:43-49` 固定 `input + 2×output`；長 context、短回答與 agent-heavy 長回答的真成本排序可能相反。適合作為簡單 profile，但不應稱為逐回合成本最優。
7. **分類失敗固定 standard 是可用性優先。** `compose.ts:91-95` 避免阻塞，但對高風險 review/plan 可能 under-route，對 chat 可能 overpay。此取捨合理，建議只增加可觀測性，不要改成 fail-closed。
8. **Provider/model key 有兩套反解。** `route/select.ts:36-40` 特判 `~`，`index.ts:275-280` 與 `suggest.ts:166-190` 則直接按第一個 slash。即使修 W3，也需統一 codec，否則 alias/bare id 仍有邊界錯誤。

## 優化方向（價值／成本排序）

1. **最高價值／中成本｜正確性＋成本：** 一次修通 budget 閉環：assistant usage 記帳 → budget 先決定 effective tier → 依 effective tier 重選 → runtime price recheck → apply。對應 W1/W2/W4/W8。
2. **高價值／低成本｜正確性：** 讓 `config.stickiness` 真正控制 guard，並新增「stickiness off」「current target + hard pressure」兩個反例測試。對應 W4。
3. **高價值／中成本｜正確性＋體感：** 統一 Target codec 與 registry resolution，端到端修 prefer/bare alias。對應 W3 與限制 8。
4. **高價值／中成本｜維護性＋可觀測性：** 把 confirm 做成單一 final outcome state machine；只在結果確定後落 entry/log/state。對應 W7。
5. **中高價值／中成本｜正確性：** 接上 historyTurns，cache key 納入 conversation/menu/question-version digest，命中後重驗 menu pick。對應 W6。
6. **中價值／高成本｜體感：** 重新設計 modelPick menu 的兩階段或全域候選策略；先量測「menu pick 通過率」再決定是否值得多一次分類。對應 W5。
7. **中價值／低成本｜正確性：** 低信心判斷改成顯式的 confidence-adjusted demand；補低信心 × kind floor × budget 的矩陣測試。對應 W9。
8. **中價值／低成本｜維護性：** routeTurn 整合測試應涵蓋 budget target、prefer resolution、confirm yes/no、history cache、skipped thinking。現有 `test/pipeline.test.ts:243-260` 只驗 guard tier，`test/config.test.ts:343-350` 只驗 prefer 在鏈首，無法捕捉接線斷點。
9. **低中價值／低成本｜體感：** UI 顯示 UTC window、freeOnly paid fallback、cache estimate assumptions，避免把政策近似呈現成硬保證。
10. **低中價值／中成本｜成本：** budget 可選擇加入「下一輪成本預估」，但先修 W1/W2；在帳本與重選未正確前做預測沒有價值。

## 不建議改的清單

- **不建議改成分類失敗就阻擋回合。** `compose.ts:91-95` 的 standard fail-open 符合產品「路由器不可阻塞主工作」；應改善 telemetry，不應 fail-closed。
- **不建議引入語意相似快取。** `classify/cache.ts:1-11` 的 exact cache 可預測；當前先修 conversation/menu key correctness，語意快取會新增更難審計的誤命中面。
- **不建議取消 L3 顯式設定可繞過 L2。** `policy/filter.ts:35-56` 與 SPEC Part 9 已清楚定義 user explicit 優先；應修 runtime resolution，而不是為了 W3 把 prefer 重新過濾。
- **不建議把 cache penalty 恢復成阻擋所有升級。** `guard.ts:133-149` 與 SPEC Part 7 已說明長 context 下固定 USD cap 會系統性阻礙必要升級；維持「只擋同層/降級」較合理。
- **不建議先微調 demand 權重／閾值。** `compose.ts:30-34` 的 0.55/0.45/0.15 未有離線品質資料，但目前 P0/P1 是接線與狀態錯誤；在執行政策尚未生效前校準權重只會優化錯誤管線。
- **不建議為了嚴格 freeOnly 直接 no-route。** 目前 fail-open 是明確產品取捨；若要硬保證，應新增獨立 `strictFreeOnly`/「禁止付費 fallback」語意，而不是悄悄反轉既有行為。

## Questions for Authors

- [Q1] Budget 被定義為成本政策還是只做 UI tier 標籤？若是成本政策，W2 的 target 不重選無法成立；請提供一個 routeTurn 級測試，證明 hard pressure 最終 `setModel` 的是 quick/standard chain 模型。
- [Q2] `prefer` 的 string 究竟是完整 registry key、alias，還是裸 model id？`policy/filter.ts:60-63` 與 `index.ts:80-84` 對此有相反假設。
- [Q3] `stickiness: false` 預期語意是「即使 target 相同也重套 model」還是只停用 held early-return？需先定義，否則單純移除 early-return 可能造成無意義 setModel/cache reset。
- [Q4] menu 的產品目標是讓分類器在「最終 tier 內」選模型嗎？若是，現行 standard-only menu 不符合；若不是，SPEC Stage 3 gate 應說明跨 tier menu 的設計。
- [Q5] confirm 被拒絕是否應當成負回饋？目前既沒有 cancelled outcome，也會寫成 applied。這會直接影響 suggest 的證據語意。
- [Q6] Part 9 所稱「registry 即時價格重驗」預期讀哪個欄位？目前 `Model.cost` 已在 `costRatesOf` 可用，但只供 cache estimate。

## Verdict

**整體判斷：需要重大修訂；目前證據不足以聲稱 budget、prefer、history、confirm 或即時價格政策端到端正確。** 最優先是 W1/W2，因為它們使成本控制核心近乎失效；接著是 W3/W4/W6/W7。現有 301 tests 與 typecheck 全過只能證明局部函式和型別一致，反而暴露整合覆蓋不足：多個測試固定了局部行為，卻未驗證真正 `routeTurn → setModel/log/state` 結果。信心：**0.97**（W1–W4/W6/W7 由直接控制流可確認；runtime registry alias 細節仍有少量環境不確定性，已在 W3 建議中保留）。

## Revision Plan

1. **先修 W1/W2 並加端到端測試。** 測試必須斷言 ledger 累積、effective tier、final target、實際 setModel key 四者一致。
2. **修 W4。** stickiness 讀設定；budget pressure 不得被原 target 的 stickiness 遮蔽。
3. **統一 Target codec/resolution，修 W3/W8。** exact provider/model、bare alias、`~.../...` 各一組整合案例；價格用 runtime exact provider recheck。
4. **重構 confirm 流程，修 W7。** yes/no/failure 各只產生一條 final entry 與一筆 decision record，並檢查 previousModel/lastExpectedModel。
5. **完成分類輸入契約，修 W6。** history 擷取、4000 字上限、cache digest、menu revalidation。
6. **決定 menu 架構，修 W5。** 用通過率與額外延遲作選擇依據，不要只補更多 gate。
7. **澄清低信心與 skipped thinking 語意，修 W9/W10。** 先改 SPEC，再補矩陣測試。
8. **最後再改善 suggest 與診斷工具（W11/W12）。** 在決策日誌真實可靠之前，不應擴大自動校準權重。

## Part 2: Inline Annotations

## Inline Annotations

> "記帳來源：每個 assistant message 的計算成本 → `state.json`"

**[W1] FATAL:** SPEC Part 8 (`SPEC.md:808`) 的主張沒有對應接線。`index.ts:8-10` 只 import `loadSpend`，`index.ts:327-348` 也沒有 assistant 結束事件；生產環境只有 cloud classifier 在 `classify/cloud.ts:140-142` 呼叫 `recordSpend`。

> "const selected = selectTargets(composed.tier, judgment, config);"

**[W2] FATAL:** `route/plan.ts:91-96` 在 budget guard 前選定 target；後續 `guard` 降 tier (`guard.ts:90-105`) 不會重跑此行。SPEC Stage 4 的「降一層（重新跑 Stage 3）」沒有實現。

> "if (!target.provider) return undefined;"

**[W3] MAJOR:** `index.ts:82` 使 `policy/filter.ts:70-74` 刻意建立的 empty-provider prefer 永遠 unavailable。現有 apply 單元測試沒有經過這個 availability gate。

> "if (state.currentModel !== null && state.currentModel === targetId) {"

**[W4] MAJOR:** `route/guard.ts:76` 沒有檢查 `config.stickiness`，並在 `computePressure` 前 return；因此設定 false 無效，且 over-budget 的既有 target 仍會 held。

> "const menu = menuKeys(compose(undefined, config).tier, undefined, config);"

**[W5] MAJOR:** `index.ts:130` 把所有 menu 固定在 fallback standard 且排除 kind specialists；這不是最終 judgment 的 tier/menu。

> "完整快取鍵：`normalize(request)` 與設定世代的組合雜湊。"

**[W6] MAJOR:** `classify/cache.ts:44-46` 的確只使用 request；但 `ClassifyInput` 還有 conversation/menu (`classify/types.ts:8-15`)。相同 request 在不同上下文或 menu 會誤命中。

> "{ request: prompt, kinds: kindsOf(config), menu },"

**[W6] MAJOR:** `index.ts:132` 沒有傳 conversation，故 `classify.historyTurns` 雖可設定，實際沒有作用。

> "if (outcome === \"applied\" && mode === \"confirm\") { hooks.writeEntry?.(entry); return result; }"

**[W7] MAJOR:** `route/apply.ts:125-127` 在使用者確認前先寫 `→`；`index.ts:211-240` 確認後又 apply，但沒有用第二次結果取代第一次 outcome。拒絕、接受、失敗三種狀態都可能被錯記。

> "事實檔過期 → fail-open 而非誤路由。"

**[W8] MAJOR:** SPEC Part 9 (`SPEC.md:844-845`) 同句前還要求「registry 即時價格重驗」，但 `route/select.ts:109-133` 只讀 static fact；`index.ts:157-160` 的 registry cost 僅供 cache estimate。這裡不是 fail-open，而是可能依舊價誤路由。

> "MODEL_FACTS.models.find((f) => f.provider === provider && f.model === id) ?? MODEL_FACTS.models.find((f) => f.model === id)"

**[W8] MAJOR:** `policy/facts.ts:82-85` 在 provider exact miss 後跨 provider 套 fact。對 provider-specific 價格與模型版本，這個 fallback 不安全。

> "if (judgment.kindConfidence < config.classify.confidenceThreshold && tierRank(tier) > tierRank(\"standard\")) { tier = \"standard\"; }"

**[W9] MAJOR:** `route/compose.ts:123-125` 只改 tier；先前由 kind floor 拉高的 demand 仍流向 thinking 與 hard-budget `demand>=2.5` 例外。請明確定義低信心時哪些 kind 衍生量仍可信。

> "if (prompt.length < config.classify.minPromptChars) { writeEntry(...); ... return; }"

**[W10] MAJOR:** `index.ts:117-121` 的真正 continuation 路徑繞過 `applyRoute`，因此不會執行 SPEC 所稱 skipped thinking 套用；`pipeline.test.ts:458-464` 測到的是另一條局部路徑。

> "score: 0.5 + (0.5 * (p - n)) / (p + n + 1)"

**[W11] MINOR:** `suggest.ts:68` 完全沒用上同函式累加的 `c`（chosen）；route applied/held 只會改 note，不會改排序分數。

> "description: \"Classify arbitrary text and show the recommended tier + model (does not switch).\""

**[W12] MINOR:** `index.ts:539` 的 tool 在 `index.ts:541-548` 沒讀 `_params.text`、也沒呼叫 classifier；結果永遠是 fallback compose，不是「Classify arbitrary text」。

## Sources

未發出任何網路請求；僅檢查本機來源與契約：

- [SPEC.md](file:///Users/ethan/dev/pi-compass/SPEC.md)
- [route/plan.ts](file:///Users/ethan/dev/pi-compass/extensions/pi-compass-router/route/plan.ts)
- [route/guard.ts](file:///Users/ethan/dev/pi-compass/extensions/pi-compass-router/route/guard.ts)
- [route/select.ts](file:///Users/ethan/dev/pi-compass/extensions/pi-compass-router/route/select.ts)
- [classify/cache.ts](file:///Users/ethan/dev/pi-compass/extensions/pi-compass-router/classify/cache.ts)
- [policy/facts.ts](file:///Users/ethan/dev/pi-compass/extensions/pi-compass-router/policy/facts.ts)
- [budget.ts](file:///Users/ethan/dev/pi-compass/extensions/pi-compass-router/budget.ts)
- [index.ts](file:///Users/ethan/dev/pi-compass/extensions/pi-compass-router/index.ts)
- [指定測試目錄](file:///Users/ethan/dev/pi-compass/test/)
