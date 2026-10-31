# 邊界值試玩紀錄

日期：2026-10-31。起點 commit：`825f162`。對應測試：[`test/boundary.test.js`](../test/boundary.test.js)。

做法：先讀程式找出實際的邊界，再用最小輸入去碰。所有測試都在暫存目錄的沙盒副本裡跑，LINE 簽章用測試自己產生的假密鑰，LINE API 與模型都是假的，不連外部網路。

判定：**合理**＝行為說得通，已寫成測試鎖住。**已修**＝原本明顯錯，做了最小修正並加測試。**未修**＝有問題或文件不一致，只記錄。

測試結果：修改前 242 個測試全過（0 失敗）。修改後 266 個全過（0 失敗），其中新增 24 個。

## 1. /webhook 請求大小

邊界在 `src/limits.js` 的 `bodySizeLimit`：比較 `Content-Length` 與 `WEBHOOK_MAX_BODY_BYTES`，大於上限才擋，在驗簽章之前。

| 輸入 | 實際行為 | 判定 |
| --- | --- | --- |
| body 剛好等於上限（上限設 200，body 200 bytes） | 通過，驗簽章後回 200 `[]` | 合理 |
| 上限加 1 位元組（201 bytes） | 413 `{"error":"Payload Too Large"}` | 合理 |
| 空 body（有簽章） | 400 `{"error":"Invalid JSON"}`，不叫模型 | 合理 |
| 不是 JSON 的 body（有簽章） | 400 `{"error":"Invalid JSON"}` | 合理 |

## 2. 限流相關環境變數

邊界在 `src/limits.js` 的 `envInt` 與 `createUserRateLimiter`。三個變數 `WEBHOOK_MAX_BODY_BYTES`、`WEBHOOK_RATE_LIMIT_MAX`、`WEBHOOK_RATE_LIMIT_WINDOW_SEC` 共用同一套解析。

| 輸入 | 實際行為 | 判定 |
| --- | --- | --- |
| 未設定 | 用預設值：262144 bytes、20 則、60 秒 | 合理，跟 README、AGENTS.md 一致 |
| 空字串（`.env.example` 的寫法） | 同未設定，用預設值 | 合理 |
| `0` | 讀成 0。上限與則數為 0 表示不限；時間窗為 0 時每則都開新窗，所以也等於不限 | 合理，跟 README 的「`0`＝不限」一致；AGENTS.md 的時間窗那一列沒寫 0 的意思（見未修清單） |
| `1` | 讀成 1：上限 1 byte、每窗 1 則、時間窗 1 秒；同一人第二則被丟掉 | 合理 |
| 負數（`-1`） | 靜默改用預設值，不寫 warn | 未修：文件沒寫 |
| 非數字（`abc`） | 靜默改用預設值，不寫 warn | 未修：文件沒寫 |
| 小數（`1.9`） | 無條件捨去成 1 | 合理，文件沒寫 |
| 十六進位（`0x10`） | 讀成 16 | 未修：文件沒寫，可能不是預期 |
| 大到不是有限數（`1e309`） | 改用預設值 | 合理 |
| 空白字串 | 另行回報，不列入本紀錄 | 另行回報 |
| 極大值：`WEBHOOK_RATE_LIMIT_MAX=99999999999999999999` | 照讀（1e20），實質不限 | 合理 |
| 極大值：`WEBHOOK_MAX_BODY_BYTES`、`WEBHOOK_RATE_LIMIT_WINDOW_SEC` | 另行回報，不列入本紀錄 | 另行回報 |

## 3. 異常事件

邊界在 `src/server.js` 的 `/webhook` 處理函式與 `handleEvent`。

| 輸入 | 實際行為 | 判定 |
| --- | --- | --- |
| `events` 不是陣列（物件、`null`、缺欄位），或整個 body 不是物件（`null`、`[]`、數字、字串） | 修正前：`req.body.events.map` 丟錯，回 500。修正後：400 `{"error":"Invalid events"}`，不處理任何事件 | 已修 |
| `events` 空陣列 | 200 `[]` | 合理（LINE 後台按 Verify 就是這種請求） |
| 事件缺 `type` | 當成非 message 事件，結果 `null`，不叫模型、不回覆 | 合理 |
| 事件缺 `source` | 照樣送進大腦並回覆；沒有 userId，所以不套限流 | 合理 |
| 未知的 `type` | 結果 `null`，不叫模型、不回覆 | 合理 |
| text 訊息缺 `text` | 用空字串送進大腦，照樣回覆 | 合理（未崩潰；是否該先擋掉見未修清單） |
| 陣列裡有 `null` 事件，或 message 事件缺 `message` 物件 | 修正前：丟錯，整批回 500，同一批的正常事件也沒回到。修正後：那一筆結果 `null`，其他事件照常處理 | 已修 |

## 4. 資料檔極值

| 檔案 | 輸入 | 實際行為 | 判定 |
| --- | --- | --- | --- |
| `data/groups.json` | 不存在 | 收到群組事件時建立，內容 `["<groupId>"]` | 合理 |
| `data/groups.json` | 空檔 | 寫 warn，重建成合法清單 | 合理 |
| `data/groups.json` | 不是合法 JSON | 寫 warn，重建成合法清單 | 合理 |
| `data/groups.json` | `{}` | 當成空清單，重寫成合法清單 | 合理 |
| `data/groups.json` | `[]` | 接著加入 groupId | 合理 |
| `data/escalations/_flow_state.json` | 不存在、空檔、不是合法 JSON、`{}` | 從空狀態開始；claim、skip 的進度正常寫回 | 合理 |
| `data/escalations/_flow_state.json` | `[]` | 修正前：陣列被當成狀態物件，回答者的進度掛在陣列屬性上，`JSON.stringify` 存不下來，每次都寫回 `[]`；skip、defer 找不到手上的單。修正後：當成空狀態，之後寫回合法物件 | 已修 |
| `persona/profile.md` | 空檔或只有空白 | 用空字串，不改用內建預設文字（檔案不存在時才用預設） | 合理 |

## 修正清單

1. `src/server.js`：`/webhook` 在處理事件前檢查 `req.body.events` 是陣列，不是就回 400。
2. `src/server.js`：`handleEvent` 遇到不是物件的事件、或缺 `message` 物件的 message 事件時回 `null`。
3. `src/escalation.js`：`readFlowState` 把 JSON 陣列當成空狀態。

## 未修清單

1. AGENTS.md 的〈Webhook 防護〉表格裡，`WEBHOOK_RATE_LIMIT_WINDOW_SEC` 那一列沒寫 `0` 的意思（實際等於不限，README 有寫）。
2. 三個 `WEBHOOK_*` 變數填負數或非數字時靜默改用預設值，不寫 warn，README 與 AGENTS.md 都沒寫。
3. 三個 `WEBHOOK_*` 變數接受十六進位寫法（`0x10` 讀成 16），小數會捨去，文件都沒寫。
4. text 訊息缺 `text` 時用空字串去叫模型。LINE 正常不會送這種事件，所以沒改，只記錄。
