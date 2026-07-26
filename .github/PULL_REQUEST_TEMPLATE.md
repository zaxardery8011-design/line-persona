<!--
  感謝送 PR！請填下面幾段，能讓 review 快很多。
  Thanks for the PR — filling this in speeds up review a lot.
-->

## 這個 PR 做了什麼 / What

<!-- 一兩句話。例：把 webhook 設定步驟從 README 抽到使用手冊，並補 Linux 說明。 -->

## 為什麼要改 / Why

<!-- 解決什麼問題？不做會怎樣？有對應 issue 就寫 Closes #123。 -->

## 怎麼驗的 / How I verified

<!-- 貼實際跑過的指令與輸出，不要只寫「應該可以」。 -->

```
$ npm install
$ npm start
$ curl http://localhost:3000/
line-persona is running
```

## 檢查清單 / Checklist

- [ ] `npm install` 乾淨跑得過，沒有多出非必要相依
- [ ] `npm start` 起得來，`curl http://localhost:3000/` 回 `line-persona is running`
- [ ] 動到 LINE 收訊路徑的話，已用真的 LINE 帳號實測過至少一則訊息
- [ ] `git status` 確認**沒有** `.env`、金鑰、`data/` 執行期資料被加進來
- [ ] 文件已同步（流程 → `README.md`／AI 施工 → `AGENTS.md`／白話步驟 → `使用手冊.md`）
- [ ] commit 有拆過，訊息符合 [`CONTRIBUTING.md`](../CONTRIBUTING.md) 的慣例（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `harden:`）

<!-- 送出即表示同意你的貢獻以 MIT License 釋出。 -->
