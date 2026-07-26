# 參與貢獻 · Contributing

歡迎！`line-persona` 的目標是**低門檻**——讓不寫程式的人也能養一隻自己的 LINE AI 分身。
所以這裡的貢獻守則也刻意簡單：**三步上手、小改動優先、一定實跑驗證。**

> English speakers: this guide is written in Traditional Chinese first, with English notes inline.
> Issues and PRs in English are equally welcome.

---

## 三步上手 · Get running in 3 steps

```bash
# 1. Fork 後 clone 你的 fork
git clone https://github.com/<你的帳號>/line-persona.git
cd line-persona
npm install

# 2. 準備設定檔（.env 已被 .gitignore，永遠不會被 commit）
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
#    最少填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL；
#    只改文件（docs-only）的話，LINE 那兩把鑰匙可以留空。

# 3. 起服務自驗
npm start
curl http://localhost:3000/     # 應回：line-persona is running
```

看到 `line-persona is running` 就代表你的環境是好的，可以開始改東西了。
完整的架構地圖在 [`AGENTS.md`](AGENTS.md)，白話操作在 [`使用手冊.md`](使用手冊.md)，**動手前請先讀 `AGENTS.md`**。

---

## 這個專案歡迎什麼樣的貢獻

| 很歡迎 ✅ | 請先開 issue 討論 ⚠️ |
|---|---|
| 文件修正、錯字、講不清楚的地方 | 新增第三方相依套件 |
| 平台差異修正（Windows / Mac / Linux） | 新的 LLM adapter 架構 |
| 錯誤處理、更清楚的錯誤訊息 | RAG / 向量庫等進階功能進主線 |
| `persona/` 範例、`distill.js` 的蒸餾規則改良 | 改動 `src/brain.js` 的 `handleMessage(ctx) -> string` 介面 |
| 讓第一次上手更順的任何小改動 | 任何會讓「5 分鐘上線」變長的東西 |

**設計底線（沿用 [`AGENTS.md`](AGENTS.md) 的鐵律）**：

1. **絕不** commit `.env` 或任何金鑰、也不要印進 log 或寫進回覆。
2. **不**新增與目標無關的相依 / 抽象 / 功能——保持低門檻、易讀。
3. 改完**一定實際跑驗證**（`npm start` + `curl`），不要只說「應該可以」。
4. 拿不到的資訊就**問**，不要憑空填假資料。

`src/brain.js` 是「大腦插孔」：只要保留 `async function handleMessage(ctx) -> string` 這個介面，
你可以在自己的 fork 裡把裡面換成任何邏輯——**這是設計上刻意留的擴充點，不需要改進主線**。

---

## Commit 慣例

沿用本 repo 既有的前綴風格（`feat:` / `harden:` / `docs:`），一律 `<type>: <一句話說明>`：

| type | 用在 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修 bug |
| `docs` | 只動文件 |
| `chore` | 建置、設定、雜務 |
| `refactor` | 不改行為的整理 |
| `harden` | 安全性 / 邊界 / 防呆強化 |

- 說明用**繁體中文或英文都可以**，挑你寫得清楚的那個。
- **一個 commit 只做一件事**；寧可拆成 3 個小 commit，也不要一顆大的。
- 範例：`docs: 修正使用手冊 webhook 路徑漏掉 /webhook`、`fix: handle empty LLM_API_KEY for local Ollama`

---

## PR 檢查清單

送 PR 前請自己走一遍（PR 樣板裡也有同一份，直接勾）：

- [ ] `npm install` 乾淨跑得過，`package.json` 沒有多出非必要相依
- [ ] `npm start` 起得來，`curl http://localhost:3000/` 回 `line-persona is running`
- [ ] 改到 LINE 收訊路徑的話，**有用真的 LINE 帳號實測過一則訊息**
- [ ] `git status` 確認 **沒有** `.env`、金鑰、`data/` 執行期資料被加進來
- [ ] 文件同步更新（動到流程 → `README.md`；動到 AI 施工流程 → `AGENTS.md`；動到白話步驟 → `使用手冊.md`）
- [ ] PR 說明有寫**為什麼**要改，不只寫改了什麼
- [ ] commit 有拆過，訊息符合上面的慣例

PR 標題就用 commit 慣例的格式，例如：`docs: add Linux quick start notes`。

---

## 回報與回覆時效

- **issue 開出來後，我們承諾 24 小時內至少給第一個回應**（就算只是「收到，這週看」）。
  如果超過 24 小時沒人理你，直接在該 issue 底下 `@` 一下——那是我們漏掉了，不是你打擾。
- 標了 `good first issue` 的，會盡量把背景與驗收條件寫清楚，讓第一次貢獻的人不用猜。
- 安全性問題（金鑰外洩風險、注入等）**請不要開公開 issue**，先私下聯絡維護者。

---

## 授權

送出貢獻即表示你同意你的貢獻以本專案的 [MIT License](LICENSE) 釋出。
