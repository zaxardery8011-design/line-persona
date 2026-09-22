# AGENTS.md — 給 AI 助理的施工手冊

> 這個檔是寫給 **AI 編碼助理（Codex / Claude Code / 任何能讀檔、開 code 的 agent）** 看的。
> 你（AI）打開這個 repo，就照這份把使用者的「LINE AI 分身」從頭架到能跑，並能依需求擴充。
> 人類使用者的白話說明在 `使用手冊.md`，技術說明在 `README.md`。

---

## 這個專案是什麼

`line-persona`（暱稱「LINE 影分身」）= 一個最小可跑的 **LINE 原生 AI 分身框架**。
使用者餵自己的資料（人格 + 知識），接雲端或本地 LLM，就能在 LINE 上自動回覆。
核心設計：**低門檻**——一般人不寫 code，靠你（AI）幫他架。

技術棧：Node.js + Express + `@line/bot-sdk` + `dotenv`，LLM 走 OpenAI-compatible `/chat/completions`。

## 架構地圖（你動手前先讀懂）

```
src/server.js        ── LINE webhook 入口：簽章驗證、event 路由、reply、群組存 groupId(供日後主動 push)
src/brain.js         ── 「大腦插孔」：handleMessage(ctx) -> string。預設組 persona prompt 後呼 llm
src/adapters/llm.js  ── 單一 LLM adapter，OpenAI-compatible，全參數走 .env
src/persona.js       ── 開機讀 persona/*.md 組成 system prompt
src/escalation.js    ── 【選配·預設關閉】轉真人閉環。沒開時 brain.js 那一呼叫直接原樣返回
persona/profile.md   ── 分身人格（誰、口吻、邊界）  ← 使用者要改的
persona/knowledge.md ── 分身知識（FAQ、基本資訊）    ← 使用者要改的
.env.example         ── 設定範本（複製成 .env 填）
data/                ── 執行期資料（groups.json 等），已 gitignore
```

---

## 🛠️ 標準施工流程（使用者說「幫我架 / 設定 / 弄好」時，照這跑）

1. **先問使用者拿 3 樣東西**（缺哪個就問哪個，別自己編）：
   - LINE `Channel access token` 和 `Channel secret`（到 https://developers.line.biz 申請 Messaging API）
   - 大腦選哪個：雲端（OpenAI / Gemini / Claude 的 API key）或本地（Ollama，免 key）
   - 分身的人設與知識：他是誰、做什麼、講話風格、要能回答哪些常見問題
2. **建 `.env`**：`cp .env.example .env`（Windows：`Copy-Item .env.example .env`），填入上面拿到的值。
   - 雲端範例：`LLM_BASE_URL=https://api.openai.com/v1`、`LLM_MODEL=gpt-4.1-mini`
   - 本地範例：`LLM_BASE_URL=http://localhost:11434/v1`、`LLM_API_KEY` 留空、`LLM_MODEL=llama3.1`
3. **改人設**：把使用者給的內容寫進 `persona/profile.md`（人格 + 邊界，務必含「不確定就說轉真人、不要亂編」）和 `persona/knowledge.md`（FAQ / 基本資訊）。
4. **安裝啟動**：`npm install` → `npm start`。
5. **自驗**：`curl http://localhost:3000/` 應回 `line-persona is running`（port 被占就改 `.env` 的 `PORT`）。
6. **開對外網址**：用 `tailscale funnel 3000`（免費固定）或 `ngrok http 3000`，取得 HTTPS 網址。
7. **告訴使用者**：把 `<那個網址>/webhook` 貼到 LINE 後台的 Webhook URL，按驗證。**注意結尾要有 `/webhook`**。
8. 請使用者用 LINE 傳訊息實測，回報結果。

---

## 🔧 擴充任務（使用者要求時才做，預設保持最簡 §最小主義）

- **蒸餾大量資料**：使用者有一堆雜亂原始資料 → 用**已內建的** `distill.js`：
  `node distill.js <原始檔> [--append]`（讀原始檔 → 呼 `src/adapters/llm.js` 蒸餾 → 寫 `persona/knowledge.md`）。
  要客製蒸餾規則就改 `distill.js` 裡的 system prompt。
- **掛資料庫 / RAG**：知識多到塞不進 context 時，改 `src/brain.js`——在組 prompt 前先做「向量檢索取最相關 N 段」。
  優先用**輕量、免另架伺服器**的本地檔案型向量庫，別拉重型相依。
- **媒體訊息**：`src/server.js` 對 image/file/audio 目前只回提示，已留 future hook，可依需求接圖片理解 / 語音轉文字。
- **主動推播**：`data/groups.json` 已存 groupId，可加排程推播。

- **轉真人閉環（客服場景才要，預設關閉）**：見下一節。**使用者沒說要，就不要打開。**

---

## 📮 轉真人閉環（`src/escalation.js`）— 選配，預設關閉

### 什麼時候才該打開

**預設是關的，而且多數人應該讓它一直關著。**

一個人自己玩的分身不需要「轉真人」——沒有真人要接。但如果使用者是拿它做**客服**
（店家、接案、報價），那答不出來時就必須有人接手，否則會發生下面這件事：

`persona/profile.md` 的範本、`使用手冊.md` 都教使用者寫「不確定就說轉真人」。
分身照做了，說出「我幫你轉達真人，請稍候」——**然後沒有然後**。
框架本身沒有任何機制去兌現這句話。使用者等著，沒有人知道他在等。

打開這個模組，才有人知道。

### 怎麼打開（三個變數）

在 `.env` 加：

```env
ESCALATION_ENABLED=1
ESCALATION_NOTIFY_TO=Uxxxxxxxx,Uyyyyyyyy
```

| 變數 | 預設 | 說明 |
|---|---|---|
| `ESCALATION_ENABLED` | 空（＝關） | 設 `1` 才啟用。**留空時行為跟沒有這個檔一模一樣。** |
| `ESCALATION_NOTIFY_TO` | 空 | 誰來回答，LINE userId，逗號分隔。**至少兩個**，理由見咽喉 1。 |
| `ESCALATION_NOTIFY_SKIP_ASKER` | 空（＝不跳過） | 設 `1` 才會在通知時略過提問者本人。**建議不要設**，理由見咽喉 1。 |
| `ESCALATION_TRIGGERS` | 內建清單 | 判斷「答不出來」的關鍵詞，`\|` 分隔。**要跟 `persona/profile.md` 寫的講法對得上**，否則永遠不開單。 |
| `ESCALATION_DEDUPE_MIN` | `60` | 同一人幾分鐘內重問算同一張單。 |
| `ESCALATION_MAX_REMINDERS` | `5` | 同一張單最多重推幾次，避免無限重推。 |
| `ESCALATION_ACK_TEXT` | 內建一句 | 開單後附給提問者的話；留空則不附加。 |

> ⚠️ `.env.example` 尚未收錄這幾個變數（見 README 同一節的註記），請直接照上表手動加到 `.env`。

轉診單寫在 `data/escalations/`，`data/` 已被 `.gitignore` 擋住，**不會進 git**。

### 回答者怎麼用（CLI，不用開後台）

```bash
node src/escalation.js list                          # 看待回覆
node src/escalation.js claim <你的LINEuserId>         # 取一張（最舊優先，urgent 插隊）
node src/escalation.js answer <單號> "答案"            # 先存草稿，使用者端收不到
node src/escalation.js answer <單號> "答案" --send     # 確認後才真的推回去
node src/escalation.js stale 3                       # 超過 3 天沒人回的
node src/escalation.js remind 3                      # 重推提醒（dry-run，加 --send 才真推）
```

### 🩸 三個咽喉（照抄架構很容易，這三個坑抄不到）

這三個不是設計上的顧慮，是一套跑了三個月的系統用 26 筆卡單、最久 94.1 天換來的。
**改這個模組時，先確認你沒有把下面任何一條拆掉。**

1. **通知對象為 0 必須留下紀錄，不准靜默**（`src/escalation.js` `notifyResponders()`）
   「跳過提問者本人」看起來完全合理——直到回答者名單只有一個人、而那個人正是最大量的提問者。
   他自己問倒 bot 時 `targets` 變空陣列，迴圈一圈都不跑，**一個人都沒被通知**。
   磁碟上「開了單」和「有人知道這張單」長得一模一樣，都只是一個 `status:pending` 的檔。
   → 所以 `targets.length === 0` 會寫進 `data/escalations/_notify_failures.jsonl`。
   **驗收**：讓唯一的回答者自己問一題，那個 jsonl 必須多一行。

2. **通知只發一次就沒有下文 = 卡 94 天的真正成因**（`listStale()` / `remind()`）
   開單推一次通知，就這一次。那次被滑掉，這張單就永遠躺在磁碟上，沒有任何東西會再提起它。
   → 所以有 `stale` / `remind`。**排程刻意不內建**（那是使用者環境的事），
   請用 Windows 工作排程器或 cron 每天跑一次 `node src/escalation.js remind 3 --send`。
   **驗收（負向）**：手動把一張單的 `ts` 改成 10 天前 → 跑 `stale 3` → **它必須出現在輸出裡**。
   只驗「指令 exit 0」不算。

3. **回覆流程的狀態要落磁碟，不能放記憶體**（`claim()` / `skip()` / `defer()` → `_flow_state.json`）
   原本的實作把「取單→作答→確認」存在記憶體 Map、TTL 10 分鐘。某次回答者連續清掉 9 筆，
   停在第 10 筆——第 8 到第 9 筆之間隔了 21.6 分鐘，超過 TTL，進度歸零，人就沒再回來。
   **那 9 筆是三個月來唯一一次清理。**
   → 所以 `claim()` 會先把回答者手上那張單還給他，服務重啟也一樣。
   **驗收**：`claim` 之後重跑 `claim`，**必須回到同一張單**，不是最舊的那張。

### 兩條不可拆的收據規則

- **`status` 只有 `pending` / `resolved`，不要發明第三個。** 兩份真相遲早分岔。
- **`push_status` 是整份 schema 最重要的欄位。** 它是「答案真的送到使用者手上」的唯一收據。
  push 失敗時**照樣寫進 `push_status`**，不准 `catch (e) { console.error(e) }` 就結束——
  那是所有卡單的共同根因：上層永遠拿不到「送到沒」。

## 🚧 鐵律（任何情況都不可違反）

- **絕不**把 `.env` 或任何金鑰 commit 進 git、印在 log、或寫進回覆。`.env` 已在 `.gitignore`。
- **不**新增與目標無關的相依 / 抽象 / 功能（保持低門檻、易讀）。
- 改完一定**實際跑驗證**（npm start + curl），不要只說「應該可以」。
- 拿不到的資訊就**問使用者**，不要憑空填假鑰匙或假資料。
