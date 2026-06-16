#!/usr/bin/env node
'use strict';

// distill.js — 把一堆雜亂原始資料「蒸餾」成乾淨的 FAQ 重點，寫進 persona/knowledge.md
//
// 用法：
//   node distill.js <原始資料檔>              # 蒸餾後「覆蓋」persona/knowledge.md
//   node distill.js <原始資料檔> --append     # 蒸餾後「附加」到 persona/knowledge.md 末尾
//   node distill.js <原始資料檔> -o out.md    # 蒸餾後寫到指定檔
//
// 用的是 .env 裡設定好的同一個 LLM（雲端或本地都行）。

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { chat } = require('./src/adapters/llm');

function parseArgs(argv) {
  const args = { input: null, out: null, append: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--append') args.append = true;
    else if (a === '-o' || a === '--out') args.out = argv[++i];
    else if (!args.input) args.input = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.input) {
    console.log('用法：node distill.js <原始資料檔> [--append] [-o 輸出檔]');
    process.exit(1);
  }
  if (!fs.existsSync(args.input)) {
    console.error(`找不到原始資料檔：${args.input}`);
    process.exit(1);
  }
  if (!process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
    console.error('LLM 尚未設定，請先在 .env 填好 LLM_BASE_URL / LLM_MODEL（蒸餾要用模型）。');
    process.exit(1);
  }

  const raw = fs.readFileSync(args.input, 'utf8');
  const outPath = args.out || path.join(__dirname, 'persona', 'knowledge.md');

  console.log(`蒸餾中…（來源 ${args.input}，${raw.length} 字）`);

  const messages = [
    {
      role: 'system',
      content:
        '你是知識整理助手。請把使用者給的雜亂原始資料，蒸餾成乾淨、好讀的「FAQ 重點清單」，' +
        '供 LINE AI 分身當作回答客戶的知識庫。要求：' +
        '① 用繁體中文（台灣用語）；' +
        '② 格式為一問一答（Q: / A:），或清楚的條列重點；' +
        '③ 去掉重複、寒暄、與客戶問答無關的雜訊；' +
        '④ 保留具體事實（時間、地址、電話、價格、流程等），不要杜撰；' +
        '⑤ 只輸出整理後的內容本身，不要加開場白或結語。'
    },
    {
      role: 'user',
      content: `以下是原始資料，請蒸餾成知識庫內容：\n\n${raw}`
    }
  ];

  const distilled = await chat(messages);

  if (args.append && fs.existsSync(outPath)) {
    fs.appendFileSync(outPath, `\n\n${distilled}\n`, 'utf8');
    console.log(`✅ 已附加到 ${outPath}`);
  } else {
    fs.writeFileSync(outPath, `${distilled}\n`, 'utf8');
    console.log(`✅ 已寫入 ${outPath}`);
  }
  console.log('改完知識庫後，重啟分身（npm start）即生效。');
}

main().catch((err) => {
  console.error('蒸餾失敗：', err.message);
  process.exit(1);
});
