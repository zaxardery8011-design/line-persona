# line-persona

> **填三個檔，就有一隻活在 LINE 上、講你的話、用你自己選的模型的 AI 分身。**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)
[![Stars](https://img.shields.io/github/stars/zaxardery8011-design/line-persona?style=social)](https://github.com/zaxardery8011-design/line-persona/stargazers)

line-persona 是一個最小可跑的 LINE 原生 AI 分身框架。你只要填 `.env`、改 `persona/profile.md` 和 `persona/knowledge.md`，就能把自己的基本資料接到 LINE bot，並自由切換雲端或本地 LLM。

市面上的 Dify、Open WebUI、AnythingLLM 多半是 Web-first 平台，對非工程師來說設定較重，LINE 原生整合也不一定直覺。本專案填的縫隙是：LINE 原生、低門檻、餵自己資料、雲端或本地模型隨切的一鍵分身框。

> 📖 **不會寫程式？看 [白話使用手冊（使用手冊.md）](使用手冊.md)** — 教你怎麼「直接叫 AI（Claude Code / Codex）幫你架」，自己一行程式都不用碰；也教怎麼蒸餾大量資料、進階掛資料庫（RAG）。

## 玩玩看｜Try the live bot

**這個框架不是空殼——我們自己就在用它養一個活的 LINE bot。** line-persona 的活人 demo（作者本人的主腦）現在在線上，掃碼加好友、丟一句話過去，就能親身體驗「LINE 原生分身」跑起來什麼樣；覺得好玩再照下面 Quick Start 養一個自己的。

🔥 **加好友（LINE ID：`@395jcpsb`）**：https://line.me/R/ti/p/@395jcpsb

<p align="center">
  <img src="docs/line-qr.png" alt="Add line-persona demo bot on LINE" width="180">
</p>

> _This repo ships with a **live LINE bot** you can talk to right now — scan the QR or open the link above to chat with the line-persona demo before you build your own._

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
- 群組訊息：照樣處理，並把 `groupId` 記到 `data/groups.json`，日後可用來做主動 push
- 圖片、檔案、音訊：目前回覆「目前只處理文字訊息」，程式中已留 future hook

## License

MIT

