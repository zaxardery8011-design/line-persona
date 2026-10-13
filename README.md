# line-persona

> **填三個檔，就有一隻活在 LINE 上、講你的話、用你自己選的模型的 AI 分身。**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Stars](https://img.shields.io/github/stars/zaxardery8011-design/line-persona?style=social)](https://github.com/zaxardery8011-design/line-persona/stargazers)

line-persona 是一個最小可跑的 LINE 原生 AI 分身框架。你只要填 `.env`、改 `persona/profile.md` 和 `persona/knowledge.md`，就能把自己的基本資料接到 LINE bot，並自由切換雲端或本地 LLM。

市面上的 Dify、Open WebUI、AnythingLLM 多半是 Web-first 平台，對非工程師來說設定較重，LINE 原生整合也不一定直覺。本專案填的縫隙是：LINE 原生、低門檻、餵自己資料、雲端或本地模型隨切的一鍵分身框。

> 📖 **不會寫程式就看 [使用手冊](使用手冊.md)。叫 AI 讀 AGENTS.md，它會先列出步驟。**

## 玩玩看｜Try it on LINE

想先看 LINE 上的分身，加 @395jcpsb。

🔥 **加好友（LINE ID：`@395jcpsb`）**：https://line.me/R/ti/p/@395jcpsb

<p align="center">
  <img src="docs/line-qr.png" alt="LINE @395jcpsb" width="180">
</p>

> _想先看 LINE 上的分身，加 @395jcpsb._

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

- 文字訊息：送進大腦並回覆。1:1 私訊等回覆時，bot 會請 LINE 顯示「輸入中」動畫（預設 20 秒，回覆送出就消失；`LINE_LOADING_SECONDS=0` 關掉，LINE 只收 5～60 的 5 的倍數，其他值自動夾進去、不是數字就用 20）。對方要正開著這個聊天室、而且用 LINE iOS／Android 13.16.0 以上才看得到；LINE 不回報有沒有顯示（沒顯示也一樣回成功），所以程式也不知道。群組與多人聊天室 LINE 不支援，不會顯示
- 群組訊息：預設照樣處理（每句都回），並把 `groupId` 記到 `data/groups.json`，日後可用來做主動 push。想讓它在群組裡「叫到才回」或「只收不回」，見下一節〈用群組餵資料〉
- 圖片、影片、語音、檔案：1:1 私訊回「我這邊看不到圖片（影片／語音／檔案）的內容，請改用文字描述。」（依傳來的類型換字）；開了轉真人（`ESCALATION_ENABLED=1`）就改成直接開單通知真人（見〈轉真人閉環〉）。群組與多人聊天室裡的媒體、貼圖、位置等其他類型，照舊回「目前只處理文字訊息」、不開單。程式中已留 future hook。開了群組收集（`GROUP_COLLECT=1`）後，群組裡的媒體會落檔；要它同時不再回這句，得搭 `GROUP_MODE=silent` 或 `mention`（`GROUP_MODE` 空或 `reply` 時仍照回）

## 選配：用群組餵資料（預設關閉）

開一個群組、把 bot 拉進去，平常把菜單、公告、照片丟進去。bot 在群組裡不插嘴，只負責收。
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
> 成員收回的訊息（往回找 7 天）會在 `data/inbox/` 裡遮蔽、圖片等媒體檔刪掉；編輯過的訊息只留最新版。開了多輪記憶的話，收回或編輯過的那一輪也會從記憶拿掉（私訊收回也算）。
> 升級到這一版之前就開著 `GROUP_COLLECT` 的話：之前收的文字與下載成功的媒體沒有記 `message_id`，收回、編輯都對不到它們（原文與照片留著，編輯則新舊兩版並存）。要清掉，請那位成員傳「忘了我」再回「確定」（靠發話者雜湊比對，舊行也遮得到），或照 [`AGENTS.md`](AGENTS.md)〈讀新料〉手動遮蔽那一行。
> 成員在群組或私訊傳「忘了我」（要整句；`GROUP_FORGET_WORDS` 可改），bot 會先問一次；他本人 60 秒內在同一個聊天回「確定」（也要整句），bot 才遮蔽他在 `data/inbox/` 的所有紀錄、刪掉媒體檔、清掉多輪記憶裡他說的話，並回報刪了幾則。沒回、超過 60 秒或 bot 中途重啟都當取消，什麼都不刪；別人回、在別的聊天回、超過 60 秒才回，以及比「忘了我」早送出的「確定」（例如 LINE 重送的舊訊息）都當一般訊息處理（照群組設定回或不回，開著 `GROUP_COLLECT` 時也照常收集）。那句確認的話沒送到（LINE 回覆失敗）就不算問過，要再傳一次「忘了我」；LINE 補送（重送）來的「忘了我」也不算問過，bot 會請他再傳一次。他收回自己傳的「忘了我」，就等於取消。指令和確認的那句「確定」本身不落檔。它只刪你這台主機上的副本；LINE 聊天室裡的訊息本身、你（或 AI 助理）先前用 `absorb.js` 讀過或已經整理進 `persona/` 的內容、已經送給 LLM 服務產生回覆的內容，以及轉真人的客服紀錄（`data/escalations/`），都不會被這個指令刪掉，回覆裡會跟他講明（客服紀錄那條只在轉真人開著、或有他的單時才提）。

完整變數表（含 `GROUP_WAKE_WORDS`）與 AI 助理該怎麼用這些料，見 [`AGENTS.md`](AGENTS.md) 的〈用群組餵資料〉。
`.env.example` 已列出這些變數，留空＝關。

## 選配：轉真人閉環（預設關閉）

自己玩的分身不需要這個，所以**預設是關的**。不設任何環境變數時，行為跟沒有這個模組完全一樣。

但如果你拿它做**客服**，就會撞到這件事：`persona/profile.md` 的範本教分身說「不確定就說轉真人」，
分身照做了，說出「我幫你轉達真人，請稍候」。**然後沒有然後**。框架本身沒有東西去兌現這句話。

`src/escalation.js` 是來兌現它的：答不出來 → 開單（同一人重問會併單）→ 通知回答者 →
回答者用 CLI 取單作答 → 答案推回原提問者 → **寫下 push 收據**。零新相依，轉診單存在 `data/`（已 gitignore）。
push 遇到網路錯誤、逾時或 LINE 5xx 會自動重試（預設共 3 次，只在 10 秒內重試），重試帶同一把 `X-Line-Retry-Key`，不會重複送達。
開著時，1:1 私訊傳來分身看不到的圖片／影片／語音／檔案也會直接開單（問題記成「[使用者傳了圖片]」這類描述，不下載內容；同一人短時間連傳只併成一張單、只通知一次，也不會因此被標成急件），群組不開單。

```env
ESCALATION_ENABLED=1
ESCALATION_NOTIFY_TO=Uxxxxxxxx,Uyyyyyyyy
```

```bash
node src/escalation.js list                       # 看待回覆
node src/escalation.js claim <你的LINEuserId>      # 取一張
node src/escalation.js answer <單號> "答案" --send  # 作答並推回去
```

> `.env.example` 已列出這些變數。全部留空＝轉真人關閉；開了之後，其他變數留空是用預設值，不是關掉那一項。各變數的意思與預設值見 [`AGENTS.md`](AGENTS.md) 的〈轉真人閉環〉表格。

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
- **只存在記憶體**，不寫檔、不寫 log。重啟就清空。這是刻意的隱私取捨。

完整變數表見 [`AGENTS.md`](AGENTS.md) 的〈多輪對話記憶〉。`.env.example` 已列出這些變數，留空＝關。

## 跑測試｜Running tests

專案附一組單元測試，只用 Node 內建的 `node:test`，**不用裝任何新套件**：

```bash
npm ci        # 或 npm install
npm test
```

- 測試**不連網、不呼叫真的模型、也不需要任何 LINE 鑰匙**：LLM 和 LINE 的呼叫都用假的取代。
- 要寫檔的測試一律寫在系統暫存資料夾，不會動到你的 `.env` 和 `data/`。
- 每次 push 和 PR，GitHub Actions 會用 Node 20 和 22 各跑一次（`.github/workflows/test.yml`）。

改了 `src/` 的話，送 PR 前先跑一次 `npm test`。

## 同一個生態圈｜Part of the ecosystem

這些工具做同一件事。人拍板。AI 做事。做完要能被驗收。

| 你還想要… | 看這個 |
|---|---|
| 讓 AI 在自己電腦上排隊跑任務，瀏覽器看進度 | [aiwff-runtime](https://github.com/zaxardery8011-design/aiwff-runtime) |
| AI 說「做完了」，你想要真的檔案與時間戳當證據 | [execution-proofs](https://github.com/zaxardery8011-design/execution-proofs) |
| 長時間跑下來，AI 慢慢偏離你的指示 | [soplint](https://github.com/zaxardery8011-design/soplint) |
| 不確定從哪開始 | [個人頁的 30 秒路由表](https://github.com/zaxardery8011-design) |

> _These tools do one thing. You decide. AI does the work. Finished work has to be checkable._

## License

MIT

