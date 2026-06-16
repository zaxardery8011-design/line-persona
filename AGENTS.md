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
src/server.js        ── LINE webhook 入口：簽章驗證、event 路由、reply/push、群組存 groupId
src/brain.js         ── 「大腦插孔」：handleMessage(ctx) -> string。預設組 persona prompt 後呼 llm
src/adapters/llm.js  ── 單一 LLM adapter，OpenAI-compatible，全參數走 .env
src/persona.js       ── 開機讀 persona/*.md 組成 system prompt
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

## 🚧 鐵律（任何情況都不可違反）

- **絕不**把 `.env` 或任何金鑰 commit 進 git、印在 log、或寫進回覆。`.env` 已在 `.gitignore`。
- **不**新增與目標無關的相依 / 抽象 / 功能（保持低門檻、易讀）。
- 改完一定**實際跑驗證**（npm start + curl），不要只說「應該可以」。
- 拿不到的資訊就**問使用者**，不要憑空填假鑰匙或假資料。
