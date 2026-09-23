// 選配：群組發話政策 + 群組素材收集。
// 環境變數全空（或 GROUP_MODE=reply 且沒開 GROUP_COLLECT）時 enabled() 為 false，
// server.js 完全不會走進這裡，行為與沒有這個模組相同。
//
//   GROUP_MODE        空 / reply = 現況（群組每句都回）
//                     mention    = 只有被叫到（喚醒詞或 @bot）才回
//                     silent     = 群組內一律不回
//   GROUP_WAKE_WORDS  mention 模式的喚醒詞，用 | 分隔；空則用 persona 的「名字」
//   GROUP_COLLECT=1   群組訊息落 data/inbox/<groupId>/<YYYY-MM-DD>.jsonl，媒體落 media/
//
// 1:1 對話完全不受影響。

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pipeline } = require('stream/promises');
const line = require('@line/bot-sdk');

const INBOX_DIR = path.join(__dirname, '..', 'data', 'inbox');
const MEDIA_EXT = { image: '.jpg', video: '.mp4', audio: '.m4a', file: '.bin' };

let blobClient = null;

function groupMode() {
  return (process.env.GROUP_MODE || '').trim().toLowerCase();
}

function collectOn() {
  return (process.env.GROUP_COLLECT || '').trim() === '1';
}

function enabled() {
  const mode = groupMode();
  return (mode !== '' && mode !== 'reply') || collectOn();
}

// 回傳 true = 這則群組訊息不要回（server.js 直接結束）；false = 照原本路徑處理。
async function handleGroupEvent(event, { persona, channelAccessToken }) {
  if (event.type !== 'message' || !event.message) {
    return false;
  }

  if (collectOn()) {
    await collect(event, channelAccessToken);
  }

  const mode = groupMode();
  if (mode === 'silent') {
    return true;
  }
  if (mode === 'mention') {
    return !isAddressed(event.message, persona);
  }
  return false;
}

function isAddressed(message, persona) {
  if (message.type !== 'text') {
    return false;
  }

  const mentionees = (message.mention && message.mention.mentionees) || [];
  if (mentionees.some((m) => m && m.isSelf)) {
    return true;
  }

  const text = message.text || '';
  return wakeWords(persona).some((word) => text.includes(word));
}

function wakeWords(persona) {
  const configured = (process.env.GROUP_WAKE_WORDS || '')
    .split('|')
    .map((w) => w.trim())
    .filter(Boolean);
  if (configured.length) {
    return configured;
  }

  const match = /名字\s*[:：]\s*(\S+)/.exec(String(persona || ''));
  return match ? [match[1]] : [];
}

function hashUser(userId) {
  if (!userId) {
    return null;
  }
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 8);
}

async function collect(event, channelAccessToken) {
  const groupId = event.source.groupId;
  const message = event.message;
  const when = new Date(event.timestamp || Date.now());
  const groupDir = path.join(INBOX_DIR, safeName(groupId));
  const record = {
    ts: when.toISOString(),
    user_hash: hashUser(event.source.userId),
    type: message.type
  };

  try {
    await fsp.mkdir(groupDir, { recursive: true });

    if (message.type === 'text') {
      record.text = message.text || '';
    } else if (MEDIA_EXT[message.type]) {
      try {
        record.media_path = await saveMedia(message, groupDir, channelAccessToken);
      } catch (error) {
        // 下載失敗也要留一行：LINE 的內容會過期，沒記下來就再也不知道漏了什麼。
        record.media_error = String(error && error.message ? error.message : error).slice(0, 200);
        record.message_id = message.id;
      }
    } else {
      record.message_id = message.id;
    }

    await fsp.appendFile(path.join(groupDir, `${localDate(when)}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
  } catch (error) {
    console.warn('GROUP_COLLECT could not write inbox:', error.message);
  }
}

async function saveMedia(message, groupDir, channelAccessToken) {
  if (!blobClient) {
    blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: channelAccessToken || '' });
  }

  const mediaDir = path.join(groupDir, 'media');
  await fsp.mkdir(mediaDir, { recursive: true });

  const ext = (message.type === 'file' && path.extname(message.fileName || '').replace(/[^.\w]/g, '')) || MEDIA_EXT[message.type];
  const fileName = `${safeName(message.id)}${ext}`;
  const target = path.join(mediaDir, fileName);

  const content = await blobClient.getMessageContent(message.id);
  if (Buffer.isBuffer(content) || content instanceof Uint8Array) {
    await fsp.writeFile(target, content);
  } else {
    await pipeline(content, fs.createWriteStream(target));
  }

  return path.posix.join('data', 'inbox', path.basename(groupDir), 'media', fileName);
}

function safeName(value) {
  return String(value || 'unknown').replace(/[^\w-]/g, '_');
}

function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = {
  enabled,
  handleGroupEvent
};
