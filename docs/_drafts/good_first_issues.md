# good first issue 草稿 ×3（彈藥庫．**尚未開，等一句話就能貼**）

- 狀態：**草稿備妥、實際不開 issue**（2026-07-27 隊長裁決）。
- 為什麼現在不開：repo 目前真訂閱者 0、open issue 0、三個月 3 個 commit。沒有流量時開 issue 是對空氣喊話；更糟的是**真有人來做卻沒人回**，訪客看到的是「作者不在」，比空白還傷。
- 什麼時候開：README／CONTRIBUTING／模板上線 → commit 有規律心跳、看起來活著 → 開始有人逛，**那時候才開，才接得住**。
- 怎麼用：下面每一條的「── 以下複製到 issue 本文 ──」整段複製貼上即可，標題與 labels 另外照抄。三條難度是階梯（⭐ 純文件 → ⭐⭐ 小程式 → ⭐⭐ 小程式＋自驗），建議**同一天一次開三條**，讓來逛的人有得挑。
- 開之前記得先建 label：`good first issue`、`documentation`、`enhancement`（`bug` 與 `enhancement` 是 GitHub 預設就有的）。

---

## GFI-1｜README 加一段「常見錯誤排查」

**標題**

```
[Docs] README 加一段「常見錯誤排查 / Troubleshooting」
```

**Labels**：`good first issue`, `documentation`
**預估難度**：⭐（純文件，不用寫程式；30–60 分鐘）

── 以下複製到 issue 本文 ──

### 背景

現在 README 的〈5 分鐘上線〉只寫「順利的話會怎樣」，沒寫「卡住的話怎麼辦」。而卡住幾乎都集中在同樣幾個地方——webhook 驗證失敗、模型連不上、bot 已讀不回。第一次架的人一旦撞到，通常直接放棄，因為不知道要 Google 什麼關鍵字。

我們想在 README 加一段 **Troubleshooting**，用「症狀 → 可能原因 → 怎麼確認」的格式，把最常見的坑先寫下來。

### 要做什麼

在 `README.md` 的〈5 分鐘上線〉之後、〈雲端 vs 本地模型怎麼切〉之前，新增一段 `## 常見錯誤排查`，至少涵蓋這四個症狀：

1. **LINE 後台按 Verify 就失敗 / webhook 回 401**
   → 多半是 `.env` 的 `LINE_CHANNEL_SECRET` 貼錯或有多餘空白（簽章驗證是 `@line/bot-sdk` 的 middleware 做的，`src/server.js`）。
2. **服務起得來、curl `/` 也 OK，但 bot 已讀不回**
   → webhook URL 少了 `/webhook` 路徑，或 LINE 後台的「Use webhook」沒打開。
3. **bot 回「LLM 尚未設定完成…」**
   → `.env` 的 `LLM_BASE_URL` 或 `LLM_MODEL` 是空的（這句話來自 `src/adapters/llm.js`）。
4. **bot 回「大腦暫時沒有回應，請稍後再試。」**
   → LLM 端真的失敗了（key 錯、額度用完、本地 Ollama 沒開）。看終端機的 `Brain failed: ...` 那一行才知道真正原因。

歡迎再補你自己踩過的坑。

### 驗收標準

- [ ] `README.md` 多出一段 `## 常見錯誤排查`，至少 4 個症狀，每個都有「可能原因」與「怎麼確認」。
- [ ] 每一條指到的行為，跟現在的程式對得上（別寫程式裡沒有的錯誤訊息）。
- [ ] 中文為主；有英文一行摘要更好，但不強制。
- [ ] 沒有動到任何 `.js` 檔，也沒有動到 07-24 加的 live demo QR 那一段。

### 提示

要抄的錯誤訊息原文在 `src/adapters/llm.js` 與 `src/brain.js`，用 grep 找引號裡的中文字串就有。

── 複製到這裡為止 ──

---

## GFI-2｜加一個 `/health` 端點，讓人一眼看出「我到底設定好了沒」

**標題**

```
[Feature] 加一個 /health 端點，回報設定狀態（不外洩任何金鑰）
```

**Labels**：`good first issue`, `enhancement`
**預估難度**：⭐⭐（約 20 行 Node.js；1–2 小時）

── 以下複製到 issue 本文 ──

### 背景

現在的健康檢查是 `GET /`，只回一句字串 `line-persona is running`（`src/server.js`）。它只告訴你「行程活著」，不告訴你「設定對不對」——但新手真正想知道的是後者。結果就是服務明明起來了、卻要靠對 LINE 發訊息才知道哪裡沒填。

我們想加一個 `GET /health`，用 JSON 回報幾個布林值，讓人 curl 一下就知道還差什麼。

### 要做什麼

在 `src/server.js` 加一個路由：

```js
app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    line_configured: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET),
    llm_configured: Boolean(process.env.LLM_BASE_URL && process.env.LLM_MODEL),
    persona_loaded: persona.length > 0,
    uptime_sec: Math.round(process.uptime())
  });
});
```

（上面是示意，實作細節可以自己調整；重點是回傳的**語意**。）

**紅線：只回布林值與長度，絕對不要回傳 token、secret、API key 本身，連前幾碼也不要。** 這個端點是公開路徑，任何人都打得到。

順手在 `README.md` 的〈5 分鐘上線〉第 4 步把 `curl http://localhost:3000/health` 補上去，並貼一段預期輸出。

### 驗收標準

- [ ] `curl http://localhost:3000/health` 回 HTTP 200 與合法 JSON。
- [ ] `.env` 留空跑一次 → `line_configured` 與 `llm_configured` 都是 `false`；填好再跑一次 → 都變 `true`。**PR 請貼這兩次的實際輸出。**
- [ ] 輸出裡搜尋不到任何 token／secret／API key 的字元（自己用 `grep` 對一次）。
- [ ] 原本的 `GET /` 行為不變（還是回 `line-persona is running`）——別讓已經在用的人壞掉。

### 提示

- 需要 Node 18 以上。
- `persona` 這個變數在 `src/server.js` 啟動時就 `loadPersona()` 好了，直接用即可。

── 複製到這裡為止 ──

---

## GFI-3｜啟動時檢查 `.env`，用白話列出「你還差哪幾個」

**標題**

```
[Feature] 啟動時檢查 .env 必填項，缺了就印出白話清單
```

**Labels**：`good first issue`, `enhancement`
**預估難度**：⭐⭐（約 30 行 Node.js；1–2 小時）

── 以下複製到 issue 本文 ──

### 背景

現在 `.env` 沒填好時，程式的反應是**分散又太安靜**的：

- `src/server.js` 只 `console.warn` 一句 LINE 的變數沒設；
- LLM 那邊要等到有人真的傳訊息、`src/adapters/llm.js` 才回一句「LLM 尚未設定完成」。

對第一次架的人來說，這等於「跑起來了，但不知道自己漏了什麼」，得一路試錯到 LINE 上才發現。

我們想在啟動時就一次講清楚：**哪幾個必填的沒填、去 `.env` 的哪一行補**。

### 要做什麼

在 `src/server.js` 啟動流程（`app.listen` 之前）加一段設定自檢，檢查這四個必填變數：

| 變數 | 沒填會怎樣 |
|---|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 回不了訊息 |
| `LINE_CHANNEL_SECRET` | `/webhook` 直接 503，LINE 後台 Verify 過不了 |
| `LLM_BASE_URL` | 大腦不會動 |
| `LLM_MODEL` | 大腦不會動 |

輸出長這樣就夠了（格式可以自己調）：

```
[設定檢查] 還差 2 個：
  ✗ LINE_CHANNEL_SECRET   → .env 第 5 行；到 LINE Developers 的 channel 頁面複製
  ✗ LLM_MODEL             → .env 第 17 行；例如 gpt-4.1-mini 或 llama3.1
  ✓ LINE_CHANNEL_ACCESS_TOKEN
  ✓ LLM_BASE_URL
沒填完也可以先跑，但 bot 會回不了話。
```

**注意兩件事**：

1. **只印變數名稱，不要印值**——連「已填」的也不要印出前幾碼。
2. **不要因為沒填就 `process.exit()`**。現在的設計是「缺設定也起得來」（`/` 還是回得了、`/webhook` 會回 503），保持這個行為，只是把話講清楚。`LLM_API_KEY` 也**不算必填**——本地 Ollama 就是空的。

### 驗收標準

- [ ] 四個變數全空 → 啟動時印出 4 個 `✗`，且服務**仍然起得來**（`curl http://localhost:3000/` 還是回 `line-persona is running`）。
- [ ] 四個都填 → 印出 4 個 `✓`（或一句「設定完整」），沒有 `✗`。
- [ ] 終端機輸出裡**找不到任何實際的 token／secret／key 值**。
- [ ] **PR 請貼上以上兩種情況的實際終端機輸出**（把值遮成 `***` 再貼）。

### 提示

- `.env.example` 已經把每個變數該填什麼寫在註解裡了，訊息文案可以直接沿用，不用另外發明講法。
- 邏輯建議放在 `src/server.js` 裡的一個小函式就好，不用為了它新增一個檔——這個專案的原則是**能少一個檔就少一個檔**（見 `AGENTS.md`）。

── 複製到這裡為止 ──

---

## 附註：這三條為什麼是這三條

- **涵蓋兩種貢獻者**：GFI-1 讓不寫程式的人也有得做（開源專案最缺的其實是這種人），GFI-2／3 給想寫一點 Node.js 的人。
- **三條互不衝突**：改的區塊分別是 README 中段、`src/server.js` 路由區、`src/server.js` 啟動區，三個人同時做也不會打架。
- **每一條都貼著本專案的原則**：不新增依賴、不新增抽象層、改動都在 30 行內，符合 `AGENTS.md` 的「保持最簡」與「改完一定實跑驗證」。
- **驗收標準都要求貼實際輸出**，跟 `.github/PULL_REQUEST_TEMPLATE.md` 的 "How I verified" 欄位是同一套要求，不會讓貢獻者到了 PR 才發現還要補。
