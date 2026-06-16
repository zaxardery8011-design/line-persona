# CLAUDE.md

本專案給 AI 助理的完整施工手冊在 **[`AGENTS.md`](AGENTS.md)** — 請先讀它，再動手。

一句話：這是 `line-persona`（LINE AI 分身框架）。當使用者說「幫我架 / 設定 / 弄好」，
照 `AGENTS.md` 的「標準施工流程」執行：問使用者拿 LINE 鑰匙 + 模型選擇 + 人設知識 →
建 `.env` → 改 `persona/*.md` → `npm install && npm start` → 開 webhook 網址給他貼。

鐵律：**絕不 commit 或外洩 `.env` / 金鑰**；保持最簡；改完一定實跑驗證。
