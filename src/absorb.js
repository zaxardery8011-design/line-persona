#!/usr/bin/env node
// 群組素材增量吸收（配合 GROUP_COLLECT=1）：列出上次水位之後的新素材，當成「待讀清單」。
//
//   node src/absorb.js                  列出所有群組的新素材（不推水位，可重複看）
//   node src/absorb.js --group <id>     只看一個群組
//   node src/absorb.js --commit         看完了，把水位推到現在（下次只列更新的）
//
// PII 快篩只報「第幾行 / 樣態代碼」，命中的那行在清單裡也會遮蔽——這支工具不該變成第二個洩漏點。

const fs = require('fs');
const path = require('path');

const INBOX_DIR = path.join(__dirname, '..', 'data', 'inbox');
const WATERMARK_PATH = path.join(INBOX_DIR, '.absorb_watermark.json');

// [代碼, 說明, regex]
const PII = [
  ['CRED', '帳密賦值', /(?:password|passwd|pwd|密碼|帳密)\s*[=:：]\s*\S|(?:username|account|帳號)\s*[=:：]\s*\S/i],
  ['TOKEN', 'API token', /\b(?:sk-[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[=:：]\s*\S)/i],
  ['OAUTH', '授權網址', /(?:oauth2?[/_]?authorize|[?&](?:client_id|state|code|access_token)=)/i],
  ['EMAIL', 'email', /[\w.+-]+@[\w-]+\.[\w.]{2,}/],
  ['PHONE', '台灣手機', /09\d{2}[-\s]?\d{3}[-\s]?\d{3}\b/]
];

function main(argv) {
  const groupArg = argValue(argv, '--group');
  const commit = argv.includes('--commit');
  const watermark = readJson(WATERMARK_PATH, {});
  const nextWatermark = { ...watermark };
  const out = [];
  const risks = [];
  let total = 0;

  for (const groupId of listDirs(INBOX_DIR)) {
    if (groupArg && groupId !== groupArg) {
      continue;
    }

    const groupLines = [];
    for (const file of listFiles(path.join(INBOX_DIR, groupId))) {
      const key = `${groupId}/${file}`;
      const lines = fs.readFileSync(path.join(INBOX_DIR, groupId, file), 'utf8').split('\n').filter(Boolean);
      const seen = Number(watermark[key]) || 0;
      nextWatermark[key] = lines.length;
      if (lines.length <= seen) {
        continue;
      }

      groupLines.push(`### ${file.replace(/\.jsonl$/, '')}`);
      for (let i = seen; i < lines.length; i += 1) {
        const where = `${key}:${i + 1}`;
        groupLines.push(`- L${i + 1} ${describe(lines[i], where, risks)}`);
        total += 1;
      }
    }

    if (groupLines.length) {
      out.push(`## 群組 ${groupId}`, ...groupLines, '');
    }
  }

  console.log('# 群組新素材（待讀清單）');
  console.log('');
  if (risks.length) {
    console.log('## ⚠ PII 快篩（只報位置與樣態，不印內容）');
    risks.forEach((r) => console.log(`- ${r}`));
    console.log('');
  }
  out.forEach((l) => console.log(l));
  console.log(`新素材 ${total} 筆；PII 命中 ${risks.length} 筆。`);

  if (commit) {
    fs.mkdirSync(INBOX_DIR, { recursive: true });
    fs.writeFileSync(WATERMARK_PATH, JSON.stringify(nextWatermark, null, 2), 'utf8');
    console.log('水位已推進（--commit）。');
  } else if (total) {
    console.log('水位未推進；讀完後加 --commit 標記為已讀。');
  }
}

function describe(rawLine, where, risks) {
  let rec;
  try {
    rec = JSON.parse(rawLine);
  } catch (_error) {
    return '（無法解析的行）';
  }

  const who = rec.user_hash || '--------';
  if (rec.media_error) {
    return `[${who}] ${rec.type} 下載失敗（message_id=${rec.message_id}）`;
  }
  if (rec.media_path) {
    return `[${who}] ${rec.type} → ${rec.media_path}`;
  }
  if (typeof rec.text === 'string') {
    const hits = PII.filter(([, , re]) => re.test(rec.text)).map(([code]) => code);
    if (hits.length) {
      risks.push(`${where} ${hits.join(',')}`);
      return `[${who}] （已遮蔽：${hits.join(',')}）`;
    }
    return `[${who}] ${rec.text.replace(/\s+/g, ' ')}`;
  }
  return `[${who}] ${rec.type}`;
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch (_error) {
    return [];
  }
}

function listFiles(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
}

main(process.argv.slice(2));
