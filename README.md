# line-persona

> **填三個檔，就有一隻活在 LINE 上、講你的話、用你自己選的模型的 AI 分身。**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Stars](https://img.shields.io/github/stars/zaxardery8011-design/line-persona?style=social)](https://github.com/zaxardery8011-design/line-persona/stargazers)

line-persona 是一個最小可跑的 LINE 原生 AI 分身框架。你只要填 `.env`、改 `persona/profile.md` 和 `persona/knowledge.md`，就能把自己的基本資料接到 LINE bot，並自由切換雲端或本地 LLM。

市面上的 Dify、Open WebUI、AnythingLLM 多半是 Web-first 平台，對非工程師來說設定較重，LINE 原生整合也不一定直覺。本專案填的縫隙是：LINE 原生、低門檻、餵自己資料、雲端或本地模型隨切的一鍵分身框。

> 📖 **不會寫程式？看 [白話使用手冊（使用手冊.md）](使用手冊.md)** — 教你怎麼「直接叫 AI（Claude Code / Codex）幫你架」，自己一行程式都不用碰；也教怎麼蒸餾大量資料、進階掛資料庫（RAG）。

## 玩玩看｜Try it on LINE

想先看看 AI 主腦在 LINE 上實際怎麼對話，可以加 **主腦實驗室**：我們艦隊的 LINE 官方帳號，由寂寞伯（第二主腦）在顧。覺得好玩，再照下面養一隻自己的。

🔥 **加好友（LINE ID：`@395jcpsb`）**：https://line.me/R/ti/p/@395jcpsb

<p align="center">
  <img src="docs/line-qr.png" alt="Add 主腦實驗室 (Brain Lab) on LINE" width="180">
</p>

> _Want to see an AI brain on LINE before building your own? Add **主腦實驗室 (Brain Lab)**, our fleet's LINE official account, run by our second brain._

## 幫自己裝一台（3 步）

| # | 做什麼 | 一句話 |
|---|---|---|
| 1 | **拿鑰匙** | 到 LINE Developers 開一個 Messaging API channel，複製 channel access token 與 channel secret |
| 2 | **填三個檔** | `.env`（鑰匙＋要用哪個模型）、`persona/profile.md`（你的口吻）、`persona/knowledge.md`（你的資料） |
| 3 | **跑起來、接對外** | `npm install && npm start`，再用 `tailscale funnel 3000` 拿一組 HTTPS 網址，LINE webhook 填 `<你的網址>/webhook` |

需要 **Node 18 以上**（程式直接用內建 `fetch`，18 以下會壞）。

每一步的細節在下面〈5 分鐘上線〉；**完全不想碰終端機**的話，[白話使用手冊](使用手冊.md) 教你怎麼叫 AI（Claude Code／Codex）整套幫你做完。

## 5 分鐘上線

### 1. 申請 LINE Messaging API channel

到 LINE Developers 建立 Messaging API channel，拿到：

- Channel access token
- Channel secret

接著在 Webhook URL 填入你的公開 HTTPS 網址，路徑要是 `/webhook`。

### 2. 填 `.env`

複製範本：

```powershell
Copy-Item .env.example .env
```

填入你的 LINE 與 LLM 設定：

```env
LINE_CHANNEL_ACCESS_TOKEN=你的 LINE channel access token
LINE_CHANNEL_SECRET=你的 LINE channel secret
PORT=3000
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=你的 LLM API key
LLM_MODEL=gpt-4.1-mini
```

### 3. 編輯分身人格與知識

改這兩個檔案：

- `persona/profile.md`: 你的名字、口吻、能回答什麼、不回答什麼
- `persona/knowledge.md`: 基本資訊、FAQ、營業時間、聯絡方式、常見問題

這個框架不做向量庫或 embedding。餵資料就是把 Markdown 讀進 system prompt，讓你先用最低門檻跑起來。

### 4. 安裝並啟動

```powershell
npm install
npm start
```

健康檢查：

```powershell
curl http://localhost:3000/
```

看到 `line-persona is running` 就代表本機服務已啟動。

### 5. 把 webhook 對外

推薦用 Tailscale Funnel，取得免費 HTTPS 網址：

```powershell
tailscale funnel 3000
```

終端機會顯示類似：

```text
https://your-machine.your-tailnet.ts.net
```

把 LINE webhook URL 設成：

```text
https://your-machine.your-tailnet.ts.net/webhook
```

也可以用 ngrok：

```powershell
ngrok http 3000
```

## 雲端 vs 本地模型怎麼切

這個專案只支援一種 LLM adapter：OpenAI-compatible chat completions。換模型時只改 `.env`。

OpenAI 或相容雲端：

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-your-api-key
LLM_MODEL=gpt-4.1-mini
```

Gemini 或 Claude 經 OpenAI-compatible gateway：

```env
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=your-gateway-api-key
LLM_MODEL=gemini-2.5-flash
```

xAI Grok（本身就是 OpenAI-compatible，不用 gateway，填 xAI 的網址和你自己的 key 即可；可用模型見 [xAI 模型列表](https://docs.x.ai/developers/models)）：

```env
LLM_BASE_URL=https://api.x.ai/v1
LLM_API_KEY=xai-your-api-key
LLM_MODEL=grok-4.7
```

本地 Ollama：

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_API_KEY=
LLM_MODEL=llama3.1
```

## 大腦插孔

`src/brain.js` 是大腦插孔。預設流程是：

1. 讀 `persona/profile.md` 和 `persona/knowledge.md`
2. 組成 system prompt
3. 呼叫 `src/adapters/llm.js`
4. 把文字回覆給 LINE

如果你已經有自己的 agent、工作流或工具呼叫，只要保留 `async function handleMessage(ctx) -> string` 這個介面，就可以把 `src/brain.js` 換成自己的邏輯。

`ctx` 內容：

```js
{
  text: '使用者訊息',
  userId: 'LINE userId',
  source: event.source,
  persona: 'profile.md + knowledge.md 組出的 prompt'
}
```

## LINE 訊息支援

- 文字訊息：送進大腦並回覆
- 群組訊息：預設照樣處理（每句都回），並把 `groupId` 記到 `data/groups.json`，日後可用來做主動 push。想讓它在群組裡「叫到才回」或「只收不回」，見下一節〈用群組餵資料〉
- 圖片、檔案、音訊：預設回覆「目前只處理文字訊息」，程式中已留 future hook。開了群組收集（`GROUP_COLLECT=1`）後，群組裡的媒體會落檔；要它同時不再回這句，得搭 `GROUP_MODE=silent` 或 `mention`（`GROUP_MODE` 空或 `reply` 時仍照回）

## 選配：用群組餵資料（預設關閉）

開一個群組、把 bot 拉進去，平常把菜單、公告、照片丟進去——bot 在群組裡不插嘴，只負責收；
之後讓 AI 助理讀新料、問過你再更新分身的知識。不設任何變數時，群組行為跟現在一樣（每句都回）。

```env
GROUP_MODE=silent        # 群組內不回（mention = 叫到名字或 @bot 才回）
GROUP_COLLECT=1          # 群組文字與圖片／檔案存到 data/inbox/
```

```bash
node src/absorb.js            # 看有哪些新料
node src/absorb.js --commit   # 看完了，標記已讀
```

> ⚠️ **隱私提醒：只在「成員都知道 bot 會記錄」的群組開 `GROUP_COLLECT`。**
> 資料只存在你自己的電腦（`data/inbox/`，不會被 commit），發話者只記雜湊、不記 LINE userId；
> 但訊息原文與圖片會存下來。別在朋友群、家族群偷偷開。

完整變數表（含 `GROUP_WAKE_WORDS`）與 AI 助理該怎麼用這些料，見 [`AGENTS.md`](AGENTS.md) 的〈用群組餵資料〉。
`.env.example` 已列出這些變數，留空＝關。

## 選配：轉真人閉環（預設關閉）

自己玩的分身不需要這個，所以**預設是關的**——不設任何環境變數時，行為跟沒有這個模組完全一樣。

但如果你拿它做**客服**，就會撞到這件事：`persona/profile.md` 的範本教分身說「不確定就說轉真人」，
分身照做了，說出「我幫你轉達真人，請稍候」——**然後沒有然後**。框架本身沒有東西去兌現這句話。

`src/escalation.js` 是來兌現它的：答不出來 → 開單（同一人重問會併單）→ 通知回答者 →
回答者用 CLI 取單作答 → 答案推回原提問者 → **寫下 push 收據**。零新相依，轉診單存在 `data/`（已 gitignore）。

```env
ESCALATION_ENABLED=1
ESCALATION_NOTIFY_TO=Uxxxxxxxx,Uyyyyyyyy
```

```bash
node src/escalation.js list                       # 看待回覆
node src/escalation.js claim <你的LINEuserId>      # 取一張
node src/escalation.js answer <單號> "答案" --send  # 作答並推回去
```

> `.env.example` 已列出這些變數（留空＝關），各變數的意思見 [`AGENTS.md`](AGENTS.md) 的〈轉真人閉環〉表格。

完整變數表、CLI 用法，以及**三個必須知道的坑**（通知對象為 0、通知不重推、流程狀態放記憶體），
都在 [`AGENTS.md`](AGENTS.md) 的〈轉真人閉環〉一節。要改這個模組前請先讀那三個坑。

## 選配：多輪對話記憶（預設關閉）

預設分身每句都當新對話。打開後它會記得同一段對話的前幾輪，你可以接著問「那週末呢？」：

```env
HISTORY_TURNS=5          # 帶入最近 5 輪（空或 0 = 關，行為與現在完全相同）
HISTORY_TTL_MIN=60       # 60 分鐘沒動靜就忘掉（預設）
```

- 傳 `/clear`、`清除對話` 或 `忘記剛剛` 可以讓它馬上忘掉（`HISTORY_CLEAR_WORDS` 可改）。
- **群組裡大家共享同一段記憶**；1:1 則每人各自一段。
- **只存在記憶體**，不寫檔、不寫 log，重啟就清空——這是刻意的隱私取捨。

完整變數表見 [`AGENTS.md`](AGENTS.md) 的〈多輪對話記憶〉。`.env.example` 已列出這些變數，留空＝關。

## 同一個生態圈｜Part of the ecosystem

line-persona 是 [ZAX-HAN 開源矩陣](https://github.com/zaxardery8011-design)裡「觸及真人」的那一塊。整個生態圈在做同一件事：**讓一個人管得住一群會唬爛的 AI。**

| 你還想要… | 看這個 |
|---|---|
| 讓 AI 在自己電腦上排隊跑任務，瀏覽器看進度 | [aiwff-runtime](https://github.com/zaxardery8011-design/aiwff-runtime) |
| AI 說「做完了」，你想要真的檔案與時間戳當證據 | [execution-proofs](https://github.com/zaxardery8011-design/execution-proofs) |
| 長時間跑下來，AI 慢慢偏離你的指示 | [soplint](https://github.com/zaxardery8011-design/soplint) |
| 不確定從哪開始 | [個人頁的 30 秒路由表](https://github.com/zaxardery8011-design) |

> _line-persona is the "reach real users" piece of a small open-source ecosystem for keeping a crowd of AI agents honest. The [profile page](https://github.com/zaxardery8011-design) routes you to the right repo in 30 seconds._

## License

MIT

